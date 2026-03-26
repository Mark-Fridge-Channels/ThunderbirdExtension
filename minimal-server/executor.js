/**
 * Warmup Executor (Notion Queue -> extension actions -> Notion writeback).
 *
 * Design notes:
 * - Single-thread, sequential execution (one row at a time).
 * - Notion read is one page (page_size from config), then filtered in-memory.
 * - Eligibility filter follows InteractionLOG spec:
 *   Platform=Email, InNOut=Out, Status=Todo, Action in (Send Email, Reply Email),
 *   FCAccount must exist on current Thunderbird identity list, and time is inside execution window.
 * - "Already executed" is decided by the presence of `external_event_id` on the row.
 */

const { queryDatabase, updatePage, createPage } = require("./notion.js");
const { parseQueueRow, isWithinWindow, computeExternalEventId } = require("./queueParser.js");

/** Cache listAccounts to avoid hammering the extension (same process, short TTL). */
let accountsCache = { at: 0, data: null };
const ACCOUNTS_CACHE_MS = 60000;

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

async function getAccountsPayload(enqueueAndWait, requestIdPrefix) {
  const now = Date.now();
  if (accountsCache.data && now - accountsCache.at < ACCOUNTS_CACHE_MS) {
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

async function queryDependencyStatus(notionCfg, databaseId, dependsOnTaskId) {
  // Spec: filter by property `Task ID` rich_text equals depends_on_task_id; page_size=1.
  const filter = {
    property: "Task ID",
    rich_text: { equals: dependsOnTaskId },
  };
  const data = await queryDatabase(notionCfg, databaseId, { pageSize: 1, filter });
  const page = Array.isArray(data?.results) && data.results.length ? data.results[0] : null;
  if (!page) return { found: false, status: null };
  const row = parseQueueRow(page);
  return { found: true, status: row.status || null };
}

function validateRequired(row) {
  const t = (row.actionText || "").trim();
  if (!t) return { ok: false, reason: "unsupported_action" };

  /** Bridge V1: Notion queue only drives Send and Reply here. */
  if (t !== "Send Email" && t !== "Reply Email") {
    return { ok: false, reason: "v1_queue_unsupported" };
  }

  if (!row.payload) return { ok: false, reason: "invalid_payload_json" };
  if (!row.fcAccount) return { ok: false, reason: "missing_fcaccount" };
  if (t === "Send Email") {
    if (!row.subject) return { ok: false, reason: "missing_subject" };
    if (!row.body) return { ok: false, reason: "missing_body" };
    if (!row.counterpartyEmail) return { ok: false, reason: "missing_counterparty_mailbox_id" };
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

function buildMinimalPayload({ row, resultPayload, mode }) {
  const resultHeaderMessageId = firstNonEmptyString(
    resultPayload?.headerMessageId,
    resultPayload?.sentHeaderMessageId
  );
  const toEmail = normalizeEmail(
    firstNonEmptyString(row?.payload?.to_email) ||
    (Array.isArray(row?.payload?.to) ? firstNonEmptyString(row.payload.to[0]) : "") ||
    firstNonEmptyString(row?.counterpartyEmail)
  );
  const fromEmail = normalizeEmail(firstNonEmptyString(row?.payload?.from_email, row?.fcAccount));
  const baseSubject = firstNonEmptyString(row?.payload?.subject, row?.subject);
  const baseBody = firstNonEmptyString(row?.payload?.body, row?.body);
  const conversationAnchor = firstNonEmptyString(row?.payload?.conversationAnchor, row?.payload?.headerMessageId, resultHeaderMessageId);

  // Unified minimal payload for Send Email / Reply Email / Inbound Reply chains.
  const out = {
    to_email: toEmail,
    from_email: fromEmail,
    subject: baseSubject,
    body: baseBody,
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

async function queryInboundPages(notionCfg, databaseId, pageSize) {
  const filter = {
    and: [
      { property: "Platform", select: { equals: "Email" } },
      { property: "InNOut", select: { equals: "In" } },
    ],
  };
  return await queryDatabase(notionCfg, databaseId, { pageSize, filter });
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
    [p.reply_status || "Reply Status", "Done"],
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
    where: "Platform=Email AND InNOut=Out AND Status=Success AND Action in (Send Email, Reply Email) AND Reply Status not in (Done, NO)",
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
  const accountsPayload = await getAccountsPayload(enqueueAndWait, `inbound-${Date.now()}`);
  console.error("[executor][inbound] scanning", { outboundCandidates: candidates.length, existingInbound: existingInboundHeaderIds.size });

  for (const row of candidates) {
    const ctx = findAccountContextByEmail(accountsPayload, row.fcAccount);
    if (!ctx) continue;
    const accountObj = (accountsPayload.accounts || []).find((a) => a.accountId === ctx.accountId);
    const inboxFolderId = findSpecialFolder(accountObj?.rootFolder, "inbox");
    if (!inboxFolderId) continue;

    const partnerEmail = extractEmail(row.payload?.to_email || row.counterpartyEmail);
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

    const inboundPayload = {
      to_email: row.fcAccount,
      from_email: extractEmail(target.author),
      subject: target.subject || row.subject,
      body: target.body || "",
      headerMessageId: target.headerMessageId || "",
      conversationAnchor: row.payload?.conversationAnchor || row.payload?.headerMessageId || target.headerMessageId || "",
      sourceOutPageId: row.pageId,
    };
    const createProps = buildInboundCreateProperties(row, { ...target, payload: inboundPayload }, cfg.executor?.notionPropertyNames);
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
  const databaseId = cfg.notion.databaseId;
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const externalEventId = computeExternalEventId(row.taskId, row.actionText || "unknown");

  // Idempotency is controlled by Task ID + Status workflow (Todo -> Progress -> Success/Failed).

  // 4.2 dependency check
  if (row.dependsOnTaskId) {
    const dep = await queryDependencyStatus(notionCfg, databaseId, row.dependsOnTaskId);
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
      return { kind: "written", ok: false, reason: "dependency_not_ready", message: `dependency_not_ready:${dep.status}` };
    }
  }

  // 4.4 required fields
  const req = validateRequired(row);
  if (!req.ok) {
    const detail =
      req.reason === "v1_queue_unsupported"
        ? "Bridge V1: Notion executor only supports Send and Reply (Open/Star/Add Contact removed)."
        : req.reason;
    return await failWriteback({ cfg, row, reason: req.reason, detail, externalEventId });
  }

  let accountsPayload;
  try {
    accountsPayload = await getAccountsPayload(enqueueAndWait, externalEventId);
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
    } else if (Number.isFinite(Number(migratedPayload?.messageId ?? row.payload?.messageId))) {
      replyMessageId = Number(migratedPayload?.messageId ?? row.payload?.messageId);
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
  });
  return await successWriteback({
    cfg,
    row,
    detail: successDetail,
    externalEventId,
    payloadText: JSON.stringify(minimalPayload),
  });
}

function mapActionToEnvelope({ row, externalEventId, accountId, identityId, requestId, replyMessageId, migratedPayload }) {
  const t = row.actionText;
  if (t === "Send Email") {
    return {
      ok: true,
      envelope: {
        request_id: requestId,
        action: "sendEmail",
        payload: {
          accountId,
          identityId,
          to: Array.isArray(migratedPayload?.to) ? migratedPayload.to : [row.counterpartyEmail],
          cc: Array.isArray(migratedPayload?.cc) ? migratedPayload.cc : [],
          bcc: Array.isArray(migratedPayload?.bcc) ? migratedPayload.bcc : [],
          subject: row.subject,
          body: row.body,
          bodyFormat: migratedPayload?.bodyFormat === "html" ? "html" : "plain",
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
          body: row.body,
          bodyFormat: migratedPayload?.bodyFormat === "html" ? "html" : "plain",
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
  console.error("[executor][outbound] notion query", {
    databaseId,
    pageSize: cfg.executor.pageSize,
    sorts: [{ property: "Trigger Time", direction: "ascending" }],
    where: "Platform=Email AND InNOut=Out AND Status=Todo AND Action in (Send Email, Reply Email) AND FCAccount in local identities AND now in execute window",
  });

  const data = await queryDatabase(notionCfg, databaseId, {
    pageSize: cfg.executor.pageSize,
    sorts: [{ property: "Trigger Time", direction: "ascending" }],
  });

  const results = Array.isArray(data?.results) ? data.results : [];
  const now = new Date();
  const accountsPayload = await getAccountsPayload(enqueueAndWait, `run-${Date.now()}`);
  const allowedSenders = listAllowedSenderEmails(accountsPayload);

  const candidates = [];
  const rejectStats = {
    notEmailPlatform: 0,
    notOutDirection: 0,
    statusNotTodo: 0,
    actionMismatch: 0,
    fcAccountNotLocal: 0,
    outOfWindow: 0,
    payloadInvalid: 0,
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
    if (!row.fcAccount || !allowedSenders.has(row.fcAccount)) {
      rejectStats.fcAccountNotLocal += 1;
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
    if (!row.payload) {
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
    if (!isWithinWindow(row.executeWindow, now)) {
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
    candidates.push(row);
  }
  console.error("[executor][outbound] filtered candidates", {
    totalRows: results.length,
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

  for (const row of candidates) {
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
}

async function startExecutor({ cfg, enqueueAndWait }) {
  console.error("[executor] warmup executor started");
  console.error("  poll_interval_ms =", cfg.executor.pollIntervalMs);
  console.error("  page_size =", cfg.executor.pageSize);

  // Initial delay is 0: run immediately on boot.
  while (true) {
    try {
      await runOnce({ cfg, enqueueAndWait });
      await runInboundWatchOnce({ cfg, enqueueAndWait });
    } catch (e) {
      console.error("[executor] runOnce failed:", e?.message ?? e);
    }
    await sleep(cfg.executor.pollIntervalMs);
  }
}

module.exports = { startExecutor };

