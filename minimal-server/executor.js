/**
 * Warmup Executor (Notion Queue -> extension actions -> Notion writeback).
 *
 * Design notes:
 * - Single-thread, sequential execution (one row at a time).
 * - Notion read is one page (page_size from config), then filtered in-memory.
 * - Eligibility filter follows InteractionLOG spec:
 *   Platform=Email, InNOut=Out, OutReach Status=Todo, Action in (Send Email, Reply Email);
 *   subject/body columns: Outreach Subject / Outreach Body (configurable via notion_property_names).
 *   FCAccount must exist on current Thunderbird identity list, and time is inside execution window.
 * - "Already executed" is decided by the presence of `external_event_id` on the row.
 */

const { queryDatabase, updatePage, createPage, getPage } = require("./notion.js");
const { parseQueueRow, isWithinWindow, computeExternalEventId, readSelectName, readEmailValue } = require("./queueParser.js");

/** Cache listAccounts to avoid hammering the extension (same process, short TTL). */
let accountsCache = { at: 0, data: null };

/** KeyPerson page id -> normalized email (process lifetime). */
const keyPersonEmailCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function notionRichText(content) {
  return {
    rich_text: [
      {
        type: "text",
        text: { content: content.length > 1900 ? content.slice(0, 1900) + "…" : content },
      },
    ],
  };
}

function notionDate(date) {
  return { date: { start: date.toISOString() } };
}

function notionSelect(name) {
  return { select: { name } };
}

function notionStatus(name) {
  return { status: { name } };
}

function notionTitle(content) {
  return {
    title: [
      {
        type: "text",
        text: { content: content.length > 1900 ? content.slice(0, 1900) + "…" : content },
      },
    ],
  };
}

function notionFromValueByType(type, value) {
  if (type === "status") return notionStatus(String(value || ""));
  if (type === "select") return notionSelect(String(value || ""));
  if (type === "date") return notionDate(value instanceof Date ? value : new Date(value));
  if (type === "title") return notionTitle(String(value || ""));
  return notionRichText(String(value || ""));
}

function getPropertyType(page, name) {
  return page?.properties?.[name]?.type || null;
}

/** Build Notion update payload; property names come from config. */
function buildWritebackProperties({ statusName, executedAt, detailText, externalEventId, payloadText }, propNames) {
  const p = propNames || {
    Status: "Status",
    executed_at: "Completion Time",
    execution_result_detail: "Result Remark",
    reply_status: "Reply Status",
    payload: "Payload",
    external_event_id: "external_event_id",
  };
  const out = {};
  if (p.Status) out[p.Status] = notionStatus(statusName);
  if (p.executed_at) out[p.executed_at] = notionDate(executedAt);
  if (p.execution_result_detail) out[p.execution_result_detail] = notionRichText(detailText);
  // Optional legacy column: only write when explicitly configured.
  if (p.external_event_id && String(p.external_event_id).trim()) {
    out[p.external_event_id] = notionRichText(externalEventId);
  }
  if (p.payload && payloadText != null) out[p.payload] = notionRichText(String(payloadText));
  return out;
}

function makeDetail({ ok, reason, action, requestId, extensionResult, extensionError }) {
  const payload = {
    ok,
    reason: reason ?? null,
    action,
    request_id: requestId,
    extension: ok ? extensionResult : extensionError,
    at: nowIso(),
  };
  return JSON.stringify(payload, null, 2);
}

function getAccountsCacheMs(cfg) {
  const ms = Number(cfg?.executor?.accountsCacheMs);
  if (!Number.isFinite(ms) || ms < 60 * 1000) return 6 * 60 * 60 * 1000;
  return ms;
}

async function getAccountsPayload(cfg, enqueueAndWait, requestIdPrefix) {
  const now = Date.now();
  const cacheMs = getAccountsCacheMs(cfg);
  if (accountsCache.data && now - accountsCache.at < cacheMs) {
    return accountsCache.data;
  }
  const listRes = await enqueueAndWait({
    request_id: `${requestIdPrefix}-listAccounts`,
    action: "listAccounts",
    payload: { includeSubFolders: true },
  });
  if (!listRes?.success) {
    const msg = listRes?.error?.message || JSON.stringify(listRes?.error || listRes);
    throw new Error(`listAccounts failed: ${msg}`);
  }
  accountsCache = { at: now, data: listRes.result };
  return listRes.result;
}

function findAccountContextByEmail(accountsPayload, email) {
  const needle = normalizeEmail(email);
  if (!needle) return null;
  for (const acc of accountsPayload.accounts || []) {
    for (const idn of acc.identities || []) {
      if (normalizeEmail(idn.email) === needle) {
        return { accountId: acc.accountId, identityId: idn.identityId };
      }
    }
  }
  return null;
}

function listAllowedSenderEmails(accountsPayload) {
  const out = new Set();
  for (const acc of accountsPayload?.accounts || []) {
    for (const idn of acc?.identities || []) {
      const em = normalizeEmail(idn?.email);
      if (em) out.add(em);
    }
  }
  return out;
}

function findSpecialFolder(root, special) {
  if (!root) return null;
  const su = root.specialUse || [];
  if (Array.isArray(su) && su.includes(special)) return root.folderId;
  for (const sub of root.subFolders || []) {
    const x = findSpecialFolder(sub, special);
    if (x) return x;
  }
  return null;
}

async function findReplyTargetMessageId(enqueueAndWait, requestIdPrefix, accountId, inboxFolderId, headerMessageId) {
  if (!headerMessageId || !String(headerMessageId).trim()) return null;
  const res = await enqueueAndWait({
    request_id: `${requestIdPrefix}-findMessages`,
    action: "findMessages",
    payload: {
      accountId,
      folderId: inboxFolderId,
      headerMessageId,
      limit: 1,
      messagesPerPage: 50,
    },
  });
  if (!res?.success || !res.result?.items?.length) return null;
  return res.result.items[0].messageId ?? null;
}

/**
 * Dependency: `depends_on_task_id` stores the dependent page id (same as Notion page id / Task ID formula output).
 * Uses GET /pages/{id} and reads the configured outreach status column (e.g. OutReach Status).
 */
async function getDependencyOutreachStatus(notionCfg, dependsOnPageId, outreachStatusColumn) {
  const id = String(dependsOnPageId || "").trim();
  if (!id) return { found: false, status: null };
  const col = outreachStatusColumn || "OutReach Status";
  try {
    const page = await getPage(notionCfg, id);
    const st = readSelectName(page?.properties?.[col]);
    return { found: true, status: st || null };
  } catch (e) {
    console.error("[executor] dependency getPage failed", { dependsOnPageId: id, error: e?.message ?? e });
    return { found: false, status: null };
  }
}

async function resolveKeyPersonEmail(notionCfg, row) {
  if (!row.keyPersonPageId) return normalizeEmail(row.counterpartyEmail);
  const key = row.keyPersonPageId;
  if (keyPersonEmailCache.has(key)) return keyPersonEmailCache.get(key);
  try {
    const page = await getPage(notionCfg, key);
    const raw = readEmailValue(page?.properties?.Email);
    const em = normalizeEmail(raw);
    keyPersonEmailCache.set(key, em);
    return em;
  } catch (e) {
    console.error("[executor] KeyPerson Email fetch failed", { keyPersonPageId: key, error: e?.message ?? e });
    keyPersonEmailCache.set(key, "");
    return "";
  }
}

function validateRequired(row, partnerEmailResolved) {
  const t = (row.actionText || "").trim();
  if (!t) return { ok: false, reason: "unsupported_action" };

  /** Bridge V1: Notion queue only drives Send and Reply here. */
  if (t !== "Send Email" && t !== "Reply Email") {
    return { ok: false, reason: "v1_queue_unsupported" };
  }

  const payloadBroken =
    typeof row.payloadText === "string" && row.payloadText.trim() && row.payload == null;
  if (payloadBroken) return { ok: false, reason: "invalid_payload_json" };

  if (!row.fcAccount) return { ok: false, reason: "missing_fcaccount" };
  if (t === "Send Email") {
    if (!row.subject) return { ok: false, reason: "missing_subject" };
    if (!row.body) return { ok: false, reason: "missing_body" };
    const to = normalizeEmail(partnerEmailResolved ?? row.counterpartyEmail);
    if (!to) return { ok: false, reason: "missing_counterparty_mailbox_id" };
  }
  if (t === "Reply Email") {
    if (!row.body) return { ok: false, reason: "missing_body" };
    if (!row.replyToHeaderMessageId && !row.payload?.replyToHeaderMessageId && !row.payload?.messageId) {
      return { ok: false, reason: "missing_reply_target" };
    }
  }
  if (!row.taskId) return { ok: false, reason: "missing_task_id" };
  return { ok: true };
}

function migratePayloadForV1(row) {
  if (!row.payload || typeof row.payload !== "object") {
    return { changed: false, payload: row.payload, text: row.payloadText || "" };
  }
  const p = { ...row.payload };
  if (p.payload_migrated_v1 === true) {
    return { changed: false, payload: p, text: JSON.stringify(p) };
  }
  let changed = false;
  if (p.threadId != null && p.conversationAnchor == null) {
    p.conversationAnchor = String(p.threadId);
    changed = true;
  }
  if (p.messageId != null && p.legacyMessageId == null) {
    p.legacyMessageId = p.messageId;
    changed = true;
  }
  p.payload_migrated_v1 = true;
  changed = true;
  return { changed, payload: p, text: JSON.stringify(p) };
}

function firstNonEmptyString(...values) {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function buildMinimalPayload({ row, resultPayload, mode, partnerEmail }) {
  const resultHeaderMessageId = firstNonEmptyString(
    resultPayload?.headerMessageId,
    resultPayload?.sentHeaderMessageId
  );
  const toEmail = normalizeEmail(
    firstNonEmptyString(partnerEmail, row?.counterpartyEmail, row?.payload?.to_email) ||
      (Array.isArray(row?.payload?.to) ? firstNonEmptyString(row.payload.to[0]) : "")
  );
  const fromEmail = normalizeEmail(firstNonEmptyString(row?.fcAccount, row?.payload?.from_email));
  const baseSubject = firstNonEmptyString(row?.subject, row?.payload?.subject);
  const baseBody = firstNonEmptyString(row?.body, row?.payload?.body);
  const conversationAnchor = firstNonEmptyString(row?.payload?.conversationAnchor, row?.payload?.headerMessageId, resultHeaderMessageId);

  // Thread metadata only (no duplicate body); InteractionLOG uses Outreach Subject / Outreach Body columns as source of truth.
  const out = {
    to_email: toEmail,
    from_email: fromEmail,
    subject: baseSubject,
    headerMessageId: resultHeaderMessageId,
    conversationAnchor,
    sourceOutPageId: row?.pageId || "",
  };

  if (mode === "reply_outbound" && !out.subject.toLowerCase().startsWith("re:")) {
    out.subject = out.subject ? `Re: ${out.subject}` : out.subject;
  }
  return out;
}

function normalizeSubjectForMatch(subject) {
  return String(subject || "")
    .replace(/^\s*(re|fw|fwd)\s*:\s*/i, "")
    .trim()
    .toLowerCase();
}

function extractEmail(text) {
  const s = String(text || "").trim().toLowerCase();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : s;
}

function normalizeEmail(text) {
  return extractEmail(text || "").trim().toLowerCase();
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHttpUrl(url) {
  const u = String(url || "").trim();
  return /^https?:\/\/\S+$/i.test(u) ? u : "";
}

/**
 * Convert markdown links like [label](https://example.com) into HTML anchors.
 * Keeps other text escaped and preserves line breaks via <br>.
 */
function markdownLinksToHtml(text) {
  const src = String(text || "").replace(/\r\n/g, "\n");
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
  let last = 0;
  let out = "";
  let m;
  while ((m = re.exec(src)) != null) {
    out += escapeHtml(src.slice(last, m.index));
    const label = escapeHtml(m[1]);
    const href = sanitizeHttpUrl(m[2]);
    if (href) {
      out += `<a href="${escapeHtml(href)}">${label}</a>`;
    } else {
      out += escapeHtml(m[0]);
    }
    last = re.lastIndex;
  }
  out += escapeHtml(src.slice(last));
  return out.replace(/\n/g, "<br>");
}

function hasMarkdownHttpLinks(text) {
  return /\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/i.test(String(text || ""));
}

function resolveBodyForCompose(rawBody, explicitBodyFormat) {
  const body = String(rawBody || "");
  if (explicitBodyFormat === "html") {
    return { bodyFormat: "html", body };
  }
  if (explicitBodyFormat === "plain") {
    return { bodyFormat: "plain", body };
  }
  if (hasMarkdownHttpLinks(body)) {
    return { bodyFormat: "html", body: markdownLinksToHtml(body) };
  }
  return { bodyFormat: "plain", body };
}

async function queryInboundPages(notionCfg, databaseId, pageSize) {
  const filter = {
    and: [
      { property: "Platform", select: { equals: "Email" } },
      { property: "InNOut", select: { equals: "In" } },
    ],
  };
  return await queryDatabase(notionCfg, databaseId, { pageSize, filter });
}

async function queryOutboundCandidatePages({ notionCfg, databaseId, pageSize, maxScanRows, lowerBound, upperBound }) {
  const sorts = [{ property: "Trigger Time", direction: "ascending" }];
  const baseClauses = [
    { property: "Platform", select: { equals: "Email" } },
    { property: "InNOut", select: { equals: "Out" } },
    {
      or: [
        { property: "Action", select: { equals: "Send Email" } },
        { property: "Action", select: { equals: "Reply Email" } },
      ],
    },
    { property: "Trigger Time", date: { on_or_after: lowerBound.toISOString() } },
    { property: "Trigger Time", date: { on_or_before: upperBound.toISOString() } },
  ];
  const filterPlans = [
    {
      name: "status_filter=status",
      filter: { and: [...baseClauses, { property: "OutReach Status", status: { equals: "Todo" } }] },
    },
    {
      name: "status_filter=select",
      filter: { and: [...baseClauses, { property: "OutReach Status", select: { equals: "Todo" } }] },
    },
    {
      name: "status_filter=none",
      filter: { and: baseClauses },
    },
    {
      name: "status_filter=none,action_filter=none",
      filter: {
        and: [
          { property: "Platform", select: { equals: "Email" } },
          { property: "InNOut", select: { equals: "Out" } },
          { property: "Trigger Time", date: { on_or_after: lowerBound.toISOString() } },
          { property: "Trigger Time", date: { on_or_before: upperBound.toISOString() } },
        ],
      },
    },
  ];

  let lastError = null;
  for (const plan of filterPlans) {
    try {
      const out = [];
      let cursor = undefined;
      let hasMore = false;
      while (out.length < maxScanRows) {
        const data = await queryDatabase(notionCfg, databaseId, {
          pageSize,
          sorts,
          filter: plan.filter,
          startCursor: cursor,
        });
        const chunk = Array.isArray(data?.results) ? data.results : [];
        out.push(...chunk);
        hasMore = Boolean(data?.has_more);
        if (!data?.has_more || !data?.next_cursor || chunk.length === 0) break;
        cursor = data.next_cursor;
      }
      const items = out.slice(0, maxScanRows);
      return {
        items,
        truncated: items.length >= maxScanRows && hasMore,
        filterPlan: plan.name,
      };
    } catch (e) {
      lastError = e;
      console.error("[executor][outbound] notion filter plan failed", {
        filterPlan: plan.name,
        error: e?.message ?? e,
      });
    }
  }
  throw lastError || new Error("outbound_query_all_filter_plans_failed");
}

function collectInboundHeaderIds(pages) {
  const ids = new Set();
  for (const page of pages || []) {
    const row = parseQueueRow(page);
    const hid = row?.payload?.headerMessageId || row?.payload?.messageHeaderId;
    if (hid) ids.add(String(hid));
  }
  return ids;
}

function buildInboundCreateProperties(sourceRow, inboundMsg, propNames) {
  const p = propNames || {};
  const srcPage = sourceRow?.raw;
  const props = {};
  const srcPayload = sourceRow?.payload || {};
  const partner = srcPayload?.partner || {};
  const partnerId = firstNonEmptyString(partner?.id, srcPayload?.partner_id, srcPayload?.partnerId);
  const partnerName = firstNonEmptyString(partner?.name, srcPayload?.partner_name, srcPayload?.partnerName);
  const productId = firstNonEmptyString(
    srcPayload?.product_id,
    srcPayload?.productId,
    srcPayload?.product_id?.id
  );
  const whoWroteIt = "BGOS";
  const mappings = [
    ["Platform", "Email"],
    ["InNOut", "In"],
    ["Action", "Inbound Reply"],
    [p.Status || "Status", "Success"],
    [p.reply_status || "Reply Status", "Todo"],
    [p.executed_at || "Completion Time", new Date(inboundMsg.date || Date.now())],
    [p.execution_result_detail || "Result Remark", inboundMsg.snippet || inboundMsg.subject || "Inbound reply captured"],
    [p.payload || "Payload", JSON.stringify(inboundMsg.payload || {})],
    ["FCAccount", sourceRow.fcAccount],
  ];

  // Preserve title field if the database requires one.
  for (const [name, prop] of Object.entries(srcPage?.properties || {})) {
    if (prop?.type === "title") {
      props[name] = notionTitle(`[In] ${inboundMsg.subject || "Reply"}`);
      break;
    }
  }

  for (const [name, value] of mappings) {
    const type = getPropertyType(srcPage, name);
    if (!type) continue;
    props[name] = notionFromValueByType(type, value);
  }

  const replyCol = p.reply || "Reply Body";
  const replyType = getPropertyType(srcPage, replyCol);
  if (replyType && inboundMsg.replyText != null) {
    props[replyCol] = notionFromValueByType(replyType, inboundMsg.replyText);
  }

  const subjectCol = p.subject || "Outreach Subject";
  const bodyCol = p.body || "Outreach Body";
  for (const [col, val] of [
    [subjectCol, inboundMsg.subject || ""],
    [bodyCol, ""],
  ]) {
    const typ = getPropertyType(srcPage, col);
    if (typ) props[col] = notionFromValueByType(typ, val);
  }

  const kpSrc = sourceRow?.raw?.properties?.["KeyPerson ID"];
  if (kpSrc?.type === "relation" && Array.isArray(kpSrc.relation) && kpSrc.relation.length) {
    const kt = getPropertyType(srcPage, "KeyPerson ID");
    if (kt === "relation") props["KeyPerson ID"] = { relation: kpSrc.relation.map((x) => ({ id: x.id })).filter((x) => x.id) };
  }

  // Extra fields required by InteractionLOG inbound spec.
  // These are conditional on the destination property existing in the Notion DB.
  const whoType = getPropertyType(srcPage, "WhoWroteIt");
  if (whoType) props["WhoWroteIt"] = notionFromValueByType(whoType, whoWroteIt);

  const partnerIdType = getPropertyType(srcPage, "Partner ID");
  if (partnerIdType && partnerId) props["Partner ID"] = notionFromValueByType(partnerIdType, partnerId);

  const partnerNameType = getPropertyType(srcPage, "Partner Name");
  if (partnerNameType && partnerName) props["Partner Name"] = notionFromValueByType(partnerNameType, partnerName);

  const productIdType = getPropertyType(srcPage, "Product ID");
  if (productIdType && productId) props["Product ID"] = notionFromValueByType(productIdType, productId);

  return props;
}

async function markReplyDone(cfg, row, detailText) {
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const names = cfg.executor?.notionPropertyNames || {};
  const statusName = names.reply_status || "Reply Status";
  const type = getPropertyType(row.raw, statusName);
  const props = {};
  if (type === "status") props[statusName] = notionStatus("Done");
  else if (type === "select") props[statusName] = notionSelect("Done");
  const remarkName = names.execution_result_detail || "Result Remark";
  const remarkType = getPropertyType(row.raw, remarkName);
  if (remarkType) props[remarkName] = notionFromValueByType(remarkType, detailText);
  if (Object.keys(props).length > 0) await updatePage(notionCfg, row.pageId, props);
}

async function runInboundWatchOnce({ cfg, enqueueAndWait }) {
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const databaseId = cfg.notion.databaseId;
  console.error("[executor][inbound] notion query", {
    databaseId,
    pageSize: Math.max(100, cfg.executor.pageSize),
    sorts: [{ property: "Completion Time", direction: "descending" }],
    where: "Platform=Email AND InNOut=Out AND OutReach Status=Success AND Action in (Send Email, Reply Email) AND Reply Status not in (Done, NO)",
  });
  const data = await queryDatabase(notionCfg, databaseId, {
    pageSize: Math.max(100, cfg.executor.pageSize),
    sorts: [{ property: "Completion Time", direction: "descending" }],
  });
  const pages = Array.isArray(data?.results) ? data.results : [];
  const candidates = pages
    .map((p) => parseQueueRow(p))
    .filter((r) =>
      r.platform === "Email" &&
      r.inNOut === "Out" &&
      r.status === "Success" &&
      (r.actionText === "Send Email" || r.actionText === "Reply Email") &&
      r.replyStatus !== "Done" &&
      r.replyStatus !== "NO"
    );
  if (!candidates.length) {
    console.error("[executor][inbound] no outbound candidates waiting for reply");
    return;
  }

  const inboundData = await queryInboundPages(notionCfg, databaseId, 100);
  const inboundPages = Array.isArray(inboundData?.results) ? inboundData.results : [];
  const existingInboundHeaderIds = collectInboundHeaderIds(inboundPages);
  const accountsPayload = await getAccountsPayload(cfg, enqueueAndWait, `inbound-${Date.now()}`);
  const allowedSenders = listAllowedSenderEmails(accountsPayload);
  const localCandidates = candidates.filter((r) => r.fcAccount && allowedSenders.has(r.fcAccount));
  console.error("[executor][inbound] scanning", {
    outboundCandidates: candidates.length,
    localOutboundCandidates: localCandidates.length,
    skippedByFcAccountNotLocal: candidates.length - localCandidates.length,
    existingInbound: existingInboundHeaderIds.size,
  });

  const inboundCap = Math.max(1, Number(cfg?.executor?.maxInboundChecksPerCycle) || 5);
  const toInspect = localCandidates.slice(0, inboundCap);
  if (localCandidates.length > toInspect.length) {
    console.error("[executor][inbound] max_inbound_checks_per_cycle cap", {
      cap: inboundCap,
      totalCandidates: localCandidates.length,
      processingThisCycle: toInspect.length,
      deferredToNextInboundPoll: localCandidates.length - toInspect.length,
    });
  }

  for (const row of toInspect) {
    const ctx = findAccountContextByEmail(accountsPayload, row.fcAccount);
    if (!ctx) continue;
    const accountObj = (accountsPayload.accounts || []).find((a) => a.accountId === ctx.accountId);
    const inboxFolderId = findSpecialFolder(accountObj?.rootFolder, "inbox");
    if (!inboxFolderId) continue;

    const partnerEmail = extractEmail(await resolveKeyPersonEmail(notionCfg, row) || row.counterpartyEmail);
    const fromDate = row.completionTime instanceof Date ? row.completionTime : new Date(Date.now() - 60 * 60 * 1000);
    const findRes = await enqueueAndWait({
      request_id: `inbound-find-${row.taskId}-${Date.now()}`,
      action: "findMessages",
      payload: {
        accountId: ctx.accountId,
        folderId: inboxFolderId,
        fromDate: fromDate.toISOString(),
        includeBody: true,
        limit: 20,
        messagesPerPage: 50,
      },
    });
    console.error("[executor][inbound] findMessages query", {
      taskId: row.taskId,
      accountId: ctx.accountId,
      folderId: inboxFolderId,
      fromDate: fromDate.toISOString(),
      partnerEmail,
      subjectAnchor: normalizeSubjectForMatch(row.subject),
      limit: 20,
      messagesPerPage: 50,
    });
    if (!findRes?.success) continue;
    const items = findRes?.result?.items || [];
    console.error("[executor][inbound] findMessages result", {
      taskId: row.taskId,
      totalItems: items.length,
      sampleHeaders: items.slice(0, 3).map((m) => ({
        messageId: m.messageId,
        headerMessageId: m.headerMessageId,
        author: m.author,
        subject: m.subject,
        date: m.date,
      })),
    });
    const target = items.find((m) => {
      const authorEmail = extractEmail(m.author);
      if (partnerEmail && authorEmail !== partnerEmail) return false;
      if (existingInboundHeaderIds.has(String(m.headerMessageId || ""))) return false;
      const subjOk = normalizeSubjectForMatch(m.subject) === normalizeSubjectForMatch(row.subject);
      return subjOk;
    });
    if (!target) continue;

    const metadataPayload = {
      headerMessageId: target.headerMessageId || "",
      conversationAnchor: row.payload?.conversationAnchor || row.payload?.headerMessageId || target.headerMessageId || "",
      sourceOutPageId: row.pageId,
      messageId: target.messageId,
      to_email: row.fcAccount,
      from_email: extractEmail(target.author),
      subject: target.subject || row.subject,
    };
    const createProps = buildInboundCreateProperties(
      row,
      {
        ...target,
        subject: target.subject || row.subject,
        replyText: target.body || "",
        payload: metadataPayload,
      },
      cfg.executor?.notionPropertyNames
    );
    if (Object.keys(createProps).length === 0) continue;
    await createPage(notionCfg, databaseId, createProps);
    await markReplyDone(cfg, row, `inbound_reply_detected:${target.headerMessageId || target.messageId}`);
    console.error("[executor][inbound] captured reply", {
      outTaskId: row.taskId,
      inboundHeaderMessageId: target.headerMessageId,
      inboundMessageId: target.messageId,
    });
    existingInboundHeaderIds.add(String(target.headerMessageId || ""));
  }
}

async function executeOne({ cfg, enqueueAndWait }, row) {
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const externalEventId = computeExternalEventId(row.taskId, row.actionText || "unknown");

  // Idempotency is controlled by Task ID + Status workflow (Todo -> Progress -> Success/Failed).

  // 4.2 dependency check
  const outreachStatusCol = cfg.executor?.notionPropertyNames?.Status || "OutReach Status";

  if (row.dependsOnTaskId) {
    const dep = await getDependencyOutreachStatus(notionCfg, row.dependsOnTaskId, outreachStatusCol);
    if (!dep.found) {
      return await failWriteback({
        cfg,
        row,
        reason: "missing_dependency",
        detail: `depends_on_task_id not found: ${row.dependsOnTaskId}`,
        externalEventId,
      });
    }
    if (dep.status === "Cancelled") {
      return await failWriteback({
        cfg,
        row,
        reason: "blocked_by_cancelled_dependency",
        detail: `dependency status=Cancelled taskId=${row.dependsOnTaskId}`,
        externalEventId,
      });
    }
    if (dep.status === "Failed") {
      return await failWriteback({
        cfg,
        row,
        reason: "blocked_by_failed_dependency",
        detail: `dependency status=Failed taskId=${row.dependsOnTaskId}`,
        externalEventId,
      });
    }
    if (dep.status !== "Success") {
      // runOnce already set OutReach Status=Progress; must not return without writeback or the row is stuck
      // (Todo filter never picks it up again).
      return { kind: "skipped", message: `dependency_not_ready:${dep.status}` };
    }
  }

  const resolvedPartnerEmail = await resolveKeyPersonEmail(notionCfg, row);

  // 4.4 required fields
  const req = validateRequired(row, resolvedPartnerEmail);
  if (!req.ok) {
    const detail =
      req.reason === "v1_queue_unsupported"
        ? "Bridge V1: Notion executor only supports Send and Reply (Open/Star/Add Contact removed)."
        : req.reason;
    return await failWriteback({ cfg, row, reason: req.reason, detail, externalEventId });
  }

  let accountsPayload;
  try {
    accountsPayload = await getAccountsPayload(cfg, enqueueAndWait, externalEventId);
  } catch (e) {
    return await failWriteback({
      cfg,
      row,
      reason: "listAccounts_failed",
      detail: e?.message ?? String(e),
      externalEventId,
    });
  }

  const ctx = findAccountContextByEmail(accountsPayload, row.fcAccount);
  if (!ctx) {
    return { kind: "skipped", message: `fcaccount_not_local:${row.fcAccount}` };
  }
  const { accountId, identityId } = ctx;
  const accountObj = (accountsPayload.accounts || []).find((a) => a.accountId === accountId);
  const inboxFolderId = findSpecialFolder(accountObj?.rootFolder, "inbox");
  const migrated = migratePayloadForV1(row);

  const actionName = row.actionText;
  const rid = `${externalEventId}-${actionName}`;

  let replyMessageId = null;
  if (row.actionText === "Reply Email") {
    if (!inboxFolderId) {
      return await failWriteback({
        cfg,
        row,
        reason: "missing_inbox_folder",
        detail: "Could not resolve inbox folderId from listAccounts tree (specialUse inbox)",
        externalEventId,
      });
    }
    // Prefer stable headerMessageId lookup; fallback to payload messageId only when explicitly provided.
    if (row.replyToHeaderMessageId && String(row.replyToHeaderMessageId).trim()) {
      replyMessageId = await findReplyTargetMessageId(
        enqueueAndWait,
        externalEventId,
        accountId,
        inboxFolderId,
        row.replyToHeaderMessageId
      );
      if (replyMessageId == null) {
        return await failWriteback({
          cfg,
          row,
          reason: "message_not_found",
          detail: `findMessages found no row for headerMessageId in Inbox: ${row.replyToHeaderMessageId}`,
          externalEventId,
        });
      }
    } else if (Number.isFinite(Number(migrated.payload?.messageId ?? row.payload?.messageId))) {
      replyMessageId = Number(migrated.payload?.messageId ?? row.payload?.messageId);
    } else {
      return await failWriteback({
        cfg,
        row,
        reason: "missing_reply_target",
        detail: "Reply Email requires replyToHeaderMessageId or payload.messageId.",
        externalEventId,
      });
    }
  }

  if (migrated.changed) {
    try {
      const payloadName = cfg.executor?.notionPropertyNames?.payload || "Payload";
      await updatePage(notionCfg, row.pageId, { [payloadName]: notionRichText(migrated.text) });
    } catch (e) {
      return await failWriteback({
        cfg,
        row,
        reason: "payload_migration_failed",
        detail: `payload migration write failed: ${e?.message ?? String(e)}`,
        externalEventId,
      });
    }
  }

  const mapped = mapActionToEnvelope({
    row,
    externalEventId,
    accountId,
    identityId,
    requestId: rid,
    replyMessageId,
    migratedPayload: migrated.payload,
    partnerEmail: resolvedPartnerEmail,
  });
  if (!mapped.ok) {
    return await failWriteback({ cfg, row, reason: mapped.reason, detail: mapped.reason, externalEventId });
  }

  const out = await enqueueAndWait(mapped.envelope);
  if (!out?.success) {
    const detailText = makeDetail({
      ok: false,
      reason: "api_error",
      action: mapped.envelope.action,
      requestId: mapped.envelope.request_id,
      extensionError: out?.error ?? out,
    });
    return await failWriteback({ cfg, row, reason: "api_error", detail: detailText, externalEventId });
  }

  const successDetail = makeDetail({
    ok: true,
    action: mapped.envelope.action,
    requestId: mapped.envelope.request_id,
    extensionResult: out?.result ?? null,
  });
  const minimalPayload = buildMinimalPayload({
    row,
    resultPayload: out?.result || {},
    mode: row?.actionText === "Reply Email" ? "reply_outbound" : "send_outbound",
    partnerEmail: resolvedPartnerEmail,
  });
  return await successWriteback({
    cfg,
    row,
    detail: successDetail,
    externalEventId,
    payloadText: JSON.stringify(minimalPayload),
  });
}

function mapActionToEnvelope({ row, externalEventId, accountId, identityId, requestId, replyMessageId, migratedPayload, partnerEmail }) {
  const t = row.actionText;
  const toMailbox = normalizeEmail(partnerEmail || row.counterpartyEmail);
  const effectiveBodyFormat = migratedPayload?.bodyFormat ?? row.bodySourceFormat;
  const bodyResolved = resolveBodyForCompose(row.body, effectiveBodyFormat);
  if (t === "Send Email") {
    return {
      ok: true,
      envelope: {
        request_id: requestId,
        action: "sendEmail",
        payload: {
          accountId,
          identityId,
          to: Array.isArray(migratedPayload?.to) ? migratedPayload.to : [toMailbox],
          cc: Array.isArray(migratedPayload?.cc) ? migratedPayload.cc : [],
          bcc: Array.isArray(migratedPayload?.bcc) ? migratedPayload.bcc : [],
          subject: row.subject,
          body: bodyResolved.body,
          bodyFormat: bodyResolved.bodyFormat,
          sendMode: migratedPayload?.sendMode || "sendNow",
        },
        idempotency_key: externalEventId,
      },
    };
  }
  if (t === "Reply Email") {
    return {
      ok: true,
      envelope: {
        request_id: requestId,
        action: "replyEmail",
        payload: {
          accountId,
          identityId,
          messageId: replyMessageId ?? migratedPayload?.messageId,
          replyType: migratedPayload?.replyType || "replyToSender",
          body: bodyResolved.body,
          bodyFormat: bodyResolved.bodyFormat,
          sendMode: migratedPayload?.sendMode || "sendNow",
        },
        idempotency_key: externalEventId,
      },
    };
  }
  return { ok: false, reason: "unsupported_action" };
}

async function successWriteback({ cfg, row, detail, externalEventId, payloadText }) {
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const propNames = cfg.executor?.notionPropertyNames;
  const props = buildWritebackProperties({
    statusName: "Success",
    executedAt: new Date(),
    detailText: detail,
    externalEventId,
    payloadText,
  }, propNames);
  const replyName = propNames?.reply_status || "Reply Status";
  const replyType = getPropertyType(row.raw, replyName);
  if (row?.inNOut === "Out" && (row?.actionText === "Send Email" || row?.actionText === "Reply Email")) {
    const current = String(row?.replyStatus || "").trim();
    if (!current || current === "Todo" || current === "Progress") {
      if (replyType === "status") props[replyName] = notionStatus("Todo");
      else if (replyType === "select") props[replyName] = notionSelect("Todo");
    }
  }
  try {
    await updatePage(notionCfg, row.pageId, props);
  } catch (e) {
    console.error("[executor] writeback failed (success)", { taskId: row.taskId, pageId: row.pageId, error: e?.message ?? e });
    throw e;
  }
  return { kind: "written", ok: true };
}

async function failWriteback({ cfg, row, reason, detail, externalEventId }) {
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const propNames = cfg.executor?.notionPropertyNames;
  const props = buildWritebackProperties({
    statusName: "Failed",
    executedAt: new Date(),
    detailText: typeof detail === "string" ? detail : String(detail),
    externalEventId: externalEventId ?? "",
  }, propNames);
  try {
    await updatePage(notionCfg, row.pageId, props);
  } catch (e) {
    console.error("[executor] writeback failed (failed)", { taskId: row.taskId, pageId: row.pageId, reason, error: e?.message ?? e });
    throw e;
  }
  return { kind: "written", ok: false, reason };
}

async function runOnce({ cfg, enqueueAndWait }) {
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const databaseId = cfg.notion.databaseId;
  const now = new Date();
  const lookbackMs = Number(cfg?.executor?.triggerLookbackMs) || 24 * 60 * 60 * 1000;
  const horizonMs = Number(cfg?.executor?.triggerHorizonMs) || 30 * 60 * 1000;
  const maxScanRows = Math.max(cfg.executor.pageSize, Number(cfg?.executor?.maxScanRows) || 200);
  const lowerBound = new Date(now.valueOf() - lookbackMs);
  const upperBound = new Date(now.valueOf() + horizonMs);
  console.error("[executor][outbound] notion query", {
    databaseId,
    pageSize: cfg.executor.pageSize,
    maxScanRows,
    sorts: [{ property: "Trigger Time", direction: "ascending" }],
    triggerRangeLocal: {
      onOrAfter: lowerBound.toString(),
      onOrBefore: upperBound.toString(),
    },
    where:
      "Trigger Time in [now-lookback, now+horizon] (Notion coarse filter) AND local eligibility checks: Platform=Email, InNOut=Out, OutReach Status=Todo, Action in (Send Email, Reply Email), FCAccount in local identities, now in execute window",
  });
  let results = [];
  try {
    const queryRes = await queryOutboundCandidatePages({
      notionCfg,
      databaseId,
      pageSize: cfg.executor.pageSize,
      maxScanRows,
      lowerBound,
      upperBound,
    });
    results = queryRes.items;
    console.error("[executor][outbound] notion filter plan selected", {
      filterPlan: queryRes.filterPlan || "unknown",
      scannedRows: results.length,
    });
    if (queryRes.truncated) {
      console.error("[executor][outbound] scan capped by max_scan_rows", {
        maxScanRows,
        scanned: results.length,
        hint: "Increase executor.max_scan_rows if foreign/shared queue rows are dense.",
      });
    }
  } catch (e) {
    // Final fallback only when all filter plans fail.
    console.error("[executor][outbound] all notion filter plans failed, fallback to unfiltered first page", {
      error: e?.message ?? e,
    });
    const data = await queryDatabase(notionCfg, databaseId, {
      pageSize: cfg.executor.pageSize,
      sorts: [{ property: "Trigger Time", direction: "ascending" }],
    });
    results = Array.isArray(data?.results) ? data.results : [];
  }

  /** Rows that pass all outbound filters except “FCAccount is a local identity” (needs listAccounts). */
  const preFc = [];
  const rejectStats = {
    notEmailPlatform: 0,
    notOutDirection: 0,
    statusNotTodo: 0,
    actionMismatch: 0,
    fcAccountNotLocal: 0,
    outOfWindow: 0,
    payloadInvalid: 0,
    listAccountsFailed: 0,
  };
  const rejectSamples = [];
  const sendEmailTodoRejectStats = {
    fcAccountNotLocal: 0,
    payloadInvalid: 0,
    outOfWindow: 0,
    unexpected: 0,
  };
  const sendEmailTodoRejectSamples = [];
  for (const page of results) {
    const row = parseQueueRow(page);
    if (row.platform !== "Email") {
      rejectStats.notEmailPlatform += 1;
      continue;
    }
    if (row.inNOut !== "Out") {
      rejectStats.notOutDirection += 1;
      continue;
    }
    if (row.status !== "Todo") {
      rejectStats.statusNotTodo += 1;
      continue;
    }
    if (row.actionText !== "Send Email" && row.actionText !== "Reply Email") {
      rejectStats.actionMismatch += 1;
      if (rejectSamples.length < 20) {
        rejectSamples.push({ taskId: row.taskId, reason: "action_mismatch", action: row.actionText });
      }
      continue;
    }
    const isSendTodo = row.actionText === "Send Email" && row.status === "Todo";
    if (!row.fcAccount) {
      rejectStats.fcAccountNotLocal += 1;
      if (isSendTodo) {
        sendEmailTodoRejectStats.fcAccountNotLocal += 1;
      }
      if (rejectSamples.length < 20) {
        rejectSamples.push({
          taskId: row.taskId,
          reason: "missing_fcaccount",
          fcAccount: row.fcAccount,
        });
      }
      if (isSendTodo && sendEmailTodoRejectSamples.length < 20) {
        sendEmailTodoRejectSamples.push({
          taskId: row.taskId,
          reason: "missing_fcaccount",
          fcAccount: row.fcAccount,
        });
      }
      continue;
    }
    const payloadBroken =
      typeof row.payloadText === "string" && row.payloadText.trim() && row.payload == null;
    if (payloadBroken) {
      rejectStats.payloadInvalid += 1;
      if (isSendTodo) {
        sendEmailTodoRejectStats.payloadInvalid += 1;
      }
      if (rejectSamples.length < 20) {
        rejectSamples.push({
          taskId: row.taskId,
          reason: "payload_invalid_json",
          payloadParseError: row.payloadParseError,
        });
      }
      if (isSendTodo && sendEmailTodoRejectSamples.length < 20) {
        sendEmailTodoRejectSamples.push({
          taskId: row.taskId,
          reason: "payload_invalid_json",
          payloadParseError: row.payloadParseError,
          payloadTextPreview: String(row.payloadText || "").slice(0, 120),
        });
      }
      continue;
    }
    if (!isWithinWindow(row.executeWindow, now, cfg?.executor?.executeWindowGraceMs)) {
      rejectStats.outOfWindow += 1;
      if (isSendTodo) {
        sendEmailTodoRejectStats.outOfWindow += 1;
      }
      if (rejectSamples.length < 20) {
        rejectSamples.push({
          taskId: row.taskId,
          reason: "out_of_window",
          windowStart: row.executeWindow?.start ? row.executeWindow.start.toISOString() : null,
          windowEnd: row.executeWindow?.end ? row.executeWindow.end.toISOString() : null,
          now: now.toISOString(),
        });
      }
      if (isSendTodo && sendEmailTodoRejectSamples.length < 20) {
        sendEmailTodoRejectSamples.push({
          taskId: row.taskId,
          reason: "out_of_window",
          windowStart: row.executeWindow?.start ? row.executeWindow.start.toISOString() : null,
          windowEnd: row.executeWindow?.end ? row.executeWindow.end.toISOString() : null,
          now: now.toISOString(),
        });
      }
      continue;
    }
    preFc.push(row);
  }

  const candidates = [];
  if (preFc.length > 0) {
    let accountsPayload = null;
    try {
      accountsPayload = await getAccountsPayload(cfg, enqueueAndWait, `run-${Date.now()}`);
    } catch (e) {
      rejectStats.listAccountsFailed = preFc.length;
      console.error("[executor][outbound] listAccounts failed (Thunderbird extension not responding?)", e?.message ?? e, {
        deferredTaskCount: preFc.length,
        hint: "Ensure the extension is enabled and polling GET /next on minimal-server.",
      });
    }
    if (accountsPayload) {
      const allowedSenders = listAllowedSenderEmails(accountsPayload);
      for (const row of preFc) {
        if (!allowedSenders.has(row.fcAccount)) {
          rejectStats.fcAccountNotLocal += 1;
          const isSendTodo = row.actionText === "Send Email" && row.status === "Todo";
          if (isSendTodo) {
            sendEmailTodoRejectStats.fcAccountNotLocal += 1;
          }
          if (rejectSamples.length < 20) {
            rejectSamples.push({
              taskId: row.taskId,
              reason: "fcaccount_not_local",
              fcAccount: row.fcAccount,
              localSenders: Array.from(allowedSenders).slice(0, 5),
            });
          }
          if (isSendTodo && sendEmailTodoRejectSamples.length < 20) {
            sendEmailTodoRejectSamples.push({
              taskId: row.taskId,
              reason: "fcaccount_not_local",
              fcAccount: row.fcAccount,
              localSenders: Array.from(allowedSenders).slice(0, 10),
            });
          }
          continue;
        }
        candidates.push(row);
      }
    }
  }

  console.error("[executor][outbound] filtered candidates", {
    totalRows: results.length,
    preFcEligible: preFc.length,
    candidates: candidates.length,
    candidateTaskIds: candidates.slice(0, 10).map((r) => r.taskId),
    rejectStats,
  });
  if (rejectSamples.length > 0) {
    console.error("[executor][outbound] reject samples", rejectSamples);
  }
  const sendEmailTodoRejectedTotal =
    sendEmailTodoRejectStats.fcAccountNotLocal +
    sendEmailTodoRejectStats.payloadInvalid +
    sendEmailTodoRejectStats.outOfWindow +
    sendEmailTodoRejectStats.unexpected;
  if (sendEmailTodoRejectedTotal > 0) {
    console.error("[executor][outbound][send-email-todo] rejects", {
      stats: sendEmailTodoRejectStats,
      samples: sendEmailTodoRejectSamples,
    });
  }

  const cap = cfg.executor.maxTasksPerCycle;
  const toRun = cap > 0 && candidates.length > cap ? candidates.slice(0, cap) : candidates;
  if (cap > 0 && candidates.length > toRun.length) {
    console.error("[executor][outbound] max_tasks_per_cycle cap", {
      cap,
      totalEligible: candidates.length,
      processingThisCycle: toRun.length,
      deferredToNextPoll: candidates.length - toRun.length,
    });
  }

  for (const row of toRun) {
    const externalEventId = computeExternalEventId(row.taskId, row.actionText);
    try {
      // claim first to avoid duplicate work across workers
      const progressProps = buildWritebackProperties({
        statusName: "Progress",
        executedAt: new Date(),
        detailText: "claimed_by_executor",
        externalEventId,
      }, cfg.executor?.notionPropertyNames);
      await updatePage({ token: cfg.notion.token, notionVersion: cfg.notion.notionVersion }, row.pageId, progressProps);

      const result = await executeOne({ cfg, enqueueAndWait }, row);
      const outcome = result?.kind === "written" ? (result?.ok ? "ok" : "failed") : (result?.kind === "skipped" ? "skipped" : "?");
      if (result?.kind === "skipped") {
        // Avoid leaving records in Progress when we intentionally skip.
        const rollbackProps = buildWritebackProperties({
          statusName: "Todo",
          executedAt: new Date(),
          detailText: result?.message || "skipped",
          externalEventId: row.externalEventId || "",
        }, cfg.executor?.notionPropertyNames);
        await updatePage({ token: cfg.notion.token, notionVersion: cfg.notion.notionVersion }, row.pageId, rollbackProps);
      }
      console.error("[executor]", { taskId: row.taskId, action: row.actionText, external_event_id: externalEventId, outcome, reason: result?.reason ?? result?.message ?? null });
    } catch (e) {
      console.error("[executor]", { taskId: row.taskId, action: row.actionText, external_event_id: externalEventId, outcome: "exception", reason: e?.message ?? String(e) });
      // We keep the loop resilient: unexpected errors should not crash the whole executor.
      // Best effort: write back executor_exception if we still can.
      try {
        const detail = makeDetail({
          ok: false,
          reason: "executor_exception",
          action: row.actionText,
          requestId: `exec-${row.taskId}-${row.actionText}-exception`,
          extensionError: { message: e?.message ?? String(e), details: e?.details },
        });
        await failWriteback({
          cfg,
          row,
          reason: "executor_exception",
          detail,
          externalEventId: row.taskId && row.actionText ? computeExternalEventId(row.taskId, row.actionText) : "",
        });
      } catch (_) {
        // ignore
      }
    }
  }
  return {
    totalRowsScanned: results.length,
    candidates: candidates.length,
    processed: toRun.length,
  };
}

async function startExecutor({ cfg, enqueueAndWait }) {
  console.error("[executor] warmup executor started");
  console.error("  mode =", cfg.executor.mode);
  console.error("  enable_outbound =", cfg.executor.enableOutbound);
  console.error("  enable_inbound =", cfg.executor.enableInbound);
  console.error("  poll_interval_ms =", cfg.executor.pollIntervalMs);
  console.error("  page_size =", cfg.executor.pageSize);
  console.error("  max_tasks_per_cycle =", cfg.executor.maxTasksPerCycle || "(unlimited)");
  console.error("  inbound_poll_interval_ms =", cfg.executor.inboundPollIntervalMs);
  console.error("  max_inbound_checks_per_cycle =", cfg.executor.maxInboundChecksPerCycle);
  if (!cfg.executor.enableOutbound && !cfg.executor.enableInbound) {
    console.error("[executor] both outbound and inbound are disabled; executor loop will stay idle");
  }

  // Initial delay is 0: run immediately on boot.
  let nextInboundAt = 0;
  while (true) {
    const cycleStart = Date.now();
    let outbound = { totalRowsScanned: 0, candidates: 0, processed: 0 };
    try {
      if (cfg.executor.enableOutbound) {
        outbound = await runOnce({ cfg, enqueueAndWait });
      }
      const now = Date.now();
      const outboundBusy = outbound.processed > 0 || outbound.candidates > 0;
      if (cfg.executor.enableInbound && !outboundBusy && now >= nextInboundAt) {
        await runInboundWatchOnce({ cfg, enqueueAndWait });
        nextInboundAt = Date.now() + cfg.executor.inboundPollIntervalMs;
      } else if (cfg.executor.enableInbound && outboundBusy) {
        nextInboundAt = Math.max(nextInboundAt, now + 5000);
      }
    } catch (e) {
      console.error("[executor] runOnce failed:", e?.message ?? e);
    }
    const elapsed = Date.now() - cycleStart;
    const waitMs = Math.max(0, cfg.executor.pollIntervalMs - elapsed);
    await sleep(waitMs);
  }
}

module.exports = { startExecutor };

