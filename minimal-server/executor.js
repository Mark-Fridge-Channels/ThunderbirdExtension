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

const { queryDatabase, updatePage, createPage, getPage, appendBlockChildren } = require("./notion.js");
const { parseQueueRow, isWithinWindow, computeExternalEventId, readSelectName, readEmailValue } = require("./queueParser.js");
const { mergeDedupeKeysInto, hasDedupeKey, addDedupeKey } = require("./inboundDedupe.js");
const fs = require("fs");
const path = require("path");

/** Cache listAccounts to avoid hammering the extension (same process, short TTL). */
let accountsCache = { at: 0, data: null };

/** KeyPerson page id -> normalized email (process lifetime). */
const keyPersonEmailCache = new Map();

/** Inbound contact cache persisted in JSON (permanent, first-write wins). */
let inboundContactCacheState = null;
/** Outbound attribution cache for unknown-sender inbound matching. */
let outboundAttributionCacheState = null;

/** TTL cache: Success Out rows for webhook `is_reply` branch B + InteractionLOG row template. */
let cachedSuccessOutRowsForWebhook = { at: 0, rows: [] };
const SUCCESS_OUT_ROWS_TTL_MS = 60_000;

const OUTBOUND_ATTRIBUTION_WINDOW_DAYS = 30;
const OUTBOUND_ATTRIBUTION_MAX_ROWS = 5000;
const OUTBOUND_ATTRIBUTION_MIN_BODY_LEN = 80;
const OUTBOUND_ATTRIBUTION_MAX_BODY_LEN = 2500;
const OUTBOUND_ATTRIBUTION_KEY_LINES_LIMIT = 5;
const OUTBOUND_ATTRIBUTION_MIN_ENTITY_OVERLAP = 2;

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

const ASIA_SHANGHAI = "Asia/Shanghai";

/** Notion date property: datetime in Asia/Shanghai with explicit +08:00 (for Last Reply Time). */
function notionDateTimeAsiaShanghai(date) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ASIA_SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (type) => parts.find((x) => x.type === type)?.value ?? "00";
  const pad2 = (s) => String(s).padStart(2, "0");
  const y = g("year");
  const mo = pad2(g("month"));
  const da = pad2(g("day"));
  const h = pad2(g("hour"));
  const mi = pad2(g("minute"));
  const se = pad2(g("second"));
  const start = `${y}-${mo}-${da}T${h}:${mi}:${se}.000+08:00`;
  return { date: { start, time_zone: ASIA_SHANGHAI } };
}

/** Human-readable Shanghai local time for Notion page block headings. */
function formatShanghaiWallClockForHeading(date) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ASIA_SHANGHAI,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const g = (type) => parts.find((x) => x.type === type)?.value ?? "00";
  const pad2 = (s) => String(s).padStart(2, "0");
  return `${g("year")}-${pad2(g("month"))}-${pad2(g("day"))} ${pad2(g("hour"))}:${pad2(g("minute"))}:${pad2(g("second"))}`;
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
  if (type === "email") {
    const em = extractEmail(String(value || ""));
    return em ? { email: em } : { email: null };
  }
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

function classifyWindowTiming(executeWindow, now = new Date(), graceMs = 0) {
  const start = executeWindow?.start;
  const end = executeWindow?.end;
  if (!(start instanceof Date) || isNaN(start.valueOf())) return "invalid";
  const grace = Number.isFinite(Number(graceMs)) ? Math.max(0, Number(graceMs)) : 0;
  if (now <= start) return "not_started";
  if (end instanceof Date && !isNaN(end.valueOf())) {
    if (now >= new Date(end.valueOf() + grace)) return "expired";
    return "in_window";
  }
  return "in_window";
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

/**
 * Reply Email 在 Notion Payload 中至少需要能 **定位要回复的那一封**（二选一或兼具）：
 * - `messageId`：Thunderbird 内部消息 id（数字，扩展 `replyEmail` 首选）
 * - `headerMessageId` 和/或 `replyToHeaderMessageId`：RFC Message-ID 字符串，供 executor `findMessages` 在 Inbox 解析
 * 不要求在 Payload 中保存原信 subject/body；执行时由 `mapActionToEnvelope` 用占位正文满足扩展非空校验。
 */
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
    const p = row.payload || {};
    const hasMessageId = Number.isFinite(Number(p.messageId));
    const hasRfc = Boolean(
      String(row.replyToHeaderMessageId || p.replyToHeaderMessageId || p.headerMessageId || "").trim()
    );
    if (!hasMessageId && !hasRfc) {
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

function buildInboundCacheKey(fcAccount, counterpartyEmail) {
  return `${normalizeEmail(fcAccount)}|${normalizeEmail(counterpartyEmail)}`;
}

/** Strip RFC 2822 angle-bracket wrapping from a Message-ID so stored keys and lookup keys always match. */
function normalizeMessageId(id) {
  return String(id || "").trim().replace(/^<+|>+$/g, "").trim();
}

const CONSUMER_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "qq.com",
  "163.com",
  "icloud.com",
]);

function extractDomainFromEmail(email) {
  const e = normalizeEmail(email);
  const i = e.indexOf("@");
  return i > 0 ? e.slice(i + 1) : "";
}

function isConsumerEmailDomain(domain) {
  return CONSUMER_EMAIL_DOMAINS.has(String(domain || "").toLowerCase());
}

/** Minimal Message-ID sanity check for In-Reply-To / References tokens. */
function isParseableMessageIdToken(token) {
  const t = normalizeMessageId(token);
  if (!t || t.length < 4 || t.length > 250) return false;
  if (!t.includes("@")) return false;
  return true;
}

/** True if the header string contains at least one whitespace-delimited Message-ID token. */
function headerFieldHasParseableMessageId(headerField) {
  const s = String(headerField || "").trim();
  if (!s) return false;
  for (const raw of s.split(/\s+/)) {
    if (isParseableMessageIdToken(raw)) return true;
  }
  return false;
}

/** Same fc + (exact author email OR same non-consumer domain as outbound counterparty). */
function outboundRowMatchesAuthorDomain(row, authorEmail) {
  const cp = normalizeEmail(row?.counterpartyEmail);
  const au = normalizeEmail(authorEmail);
  if (!cp || !au) return false;
  if (cp === au) return true;
  const d1 = extractDomainFromEmail(au);
  const d2 = extractDomainFromEmail(cp);
  if (!d1 || !d2 || d1 !== d2) return false;
  if (isConsumerEmailDomain(d1)) return false;
  return true;
}

function filterSuccessOutRowsForFcAndAuthor(rows, fc, authorEmail) {
  const f = normalizeEmail(fc);
  if (!f) return [];
  return (rows || []).filter((r) => normalizeEmail(r?.fcAccount) === f && outboundRowMatchesAuthorDomain(r, authorEmail));
}

/**
 * Subject-line best match among rows already filtered to fc + author/domain.
 * Mirrors findBestMatchingOutRow without re-checking counterparty.
 */
function findBestMatchingOutRowFromCandidates(rows, subjectText) {
  const normalizedInboundSubject = normalizeSubjectForMatch(subjectText);
  let fallback = null;
  for (const row of rows || []) {
    if (!fallback) fallback = row;
    const outNormalized = normalizeSubjectForMatch(row?.subject || "");
    if (outNormalized && normalizedInboundSubject && outNormalized === normalizedInboundSubject) return row;
    if (outNormalized && normalizedInboundSubject && String(subjectText || "").toLowerCase().includes(outNormalized)) {
      return row;
    }
  }
  return fallback;
}

function hasHistoricalContactForReply(cacheMap, fc, author) {
  const key = buildInboundCacheKey(fc, author);
  if (cacheMap.byKey.has(key)) return true;
  const dom = extractDomainFromEmail(author);
  if (dom && !isConsumerEmailDomain(dom) && cacheMap.domainMap.has(dom)) return true;
  return false;
}

function canonicalTextForContains(input) {
  return String(input || "")
    .replace(/\r\n/g, "\n")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\u00a0/g, " ")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function dropReplySignatures(raw) {
  const s = String(raw || "");
  if (!s) return "";
  const patterns = [
    /\n--\s*\n[\s\S]*$/i,
    /\nbest\s*,[\s\S]*$/i,
    /\nregards\s*,[\s\S]*$/i,
    /\nkind regards\s*,[\s\S]*$/i,
    /\nthanks\s*,[\s\S]*$/i,
  ];
  for (const re of patterns) {
    if (re.test(s)) return s.replace(re, "").trim();
  }
  return s.trim();
}

function normalizeBodyForAttribution(rawBody) {
  const stripped = stripHtmlToPlain(rawBody);
  const deSig = dropReplySignatures(stripped);
  return deSig.length > OUTBOUND_ATTRIBUTION_MAX_BODY_LEN
    ? deSig.slice(0, OUTBOUND_ATTRIBUTION_MAX_BODY_LEN)
    : deSig;
}

function extractKeyLinesFromBody(bodyText) {
  const lines = String(bodyText || "")
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x.length >= 24)
    .map((x) => canonicalTextForContains(x));
  return lines.slice(0, OUTBOUND_ATTRIBUTION_KEY_LINES_LIMIT);
}

function normalizeEntityToken(token) {
  return String(token || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff&+\-.'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEntitiesFromText(subject, body, authorText = "") {
  const blob = `${subject || ""}\n${body || ""}\n${authorText || ""}`;
  const out = new Set();
  const add = (raw) => {
    const t = normalizeEntityToken(raw);
    if (!t) return;
    if (t.length < 3) return;
    if (!/[a-z\u4e00-\u9fff]/i.test(t)) return;
    const words = t.split(" ").filter(Boolean);
    if (words.length > 8) return;
    out.add(t);
  };

  const quotedRe = /["“”'‘’]([^"“”'‘’]{3,120})["“”'‘’]/g;
  let m;
  while ((m = quotedRe.exec(blob)) != null) add(m[1]);

  const titleRe = /\b([A-Z][a-z]+(?:[\s-]+[A-Z][a-z]+){0,5})\b/g;
  while ((m = titleRe.exec(blob)) != null) add(m[1]);

  const orgRe = /\b([A-Z][A-Za-z0-9&+\-]{1,}(?:\s+[A-Z][A-Za-z0-9&+\-]{1,}){0,5})\b/g;
  while ((m = orgRe.exec(blob)) != null) add(m[1]);

  // CJK phrases help reduce misses for non-English email content.
  const cjkRe = /([\u4e00-\u9fff]{2,12})/g;
  while ((m = cjkRe.exec(blob)) != null) add(m[1]);

  // Lowercase multi-word phrases from subject (e.g. "fridge channels") can still be business entities.
  const subjectNorm = canonicalTextForContains(subject);
  const phraseRe = /\b([a-z][a-z0-9]+(?:\s+[a-z][a-z0-9]+){1,4})\b/g;
  while ((m = phraseRe.exec(subjectNorm)) != null) add(m[1]);

  const emailDomain = extractEmail(authorText).split("@")[1] || "";
  if (emailDomain && !["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "qq.com", "163.com", "icloud.com"].includes(emailDomain)) {
    add(emailDomain.replace(/\.[a-z]{2,}$/i, "").replace(/[.-]+/g, " "));
  }
  return Array.from(out).slice(0, 30);
}

function subjectContainsMatch(inboundSubjectNorm, outboundSubjectNorm) {
  if (!inboundSubjectNorm || !outboundSubjectNorm) return false;
  return inboundSubjectNorm.includes(outboundSubjectNorm) || outboundSubjectNorm.includes(inboundSubjectNorm);
}

function bodyContainsMatch(inboundBodyNorm, outboundBodyNorm) {
  if (!inboundBodyNorm || !outboundBodyNorm) return false;
  if (outboundBodyNorm.length < OUTBOUND_ATTRIBUTION_MIN_BODY_LEN) return false;
  return inboundBodyNorm.includes(outboundBodyNorm);
}

function bodyContainsByKeyLines(inboundBodyNorm, outboundKeyLines) {
  if (!inboundBodyNorm) return false;
  const lines = Array.isArray(outboundKeyLines) ? outboundKeyLines : [];
  for (const line of lines) {
    const one = canonicalTextForContains(line);
    if (one && one.length >= 24 && inboundBodyNorm.includes(one)) return true;
  }
  return false;
}

function entityOverlap(inboundEntities, outboundEntities) {
  const a = new Set((inboundEntities || []).map(normalizeEntityToken).filter(Boolean));
  const b = new Set((outboundEntities || []).map(normalizeEntityToken).filter(Boolean));
  let cnt = 0;
  const overlap = [];
  for (const x of a) {
    if (b.has(x)) {
      overlap.push(x);
      cnt += 1;
    }
  }
  return { count: cnt, overlap };
}

function buildOutboundAttributionRecordFromRow(row, authoredAt) {
  const entityId = String(row?.entityPageId || row?.keyPersonPageId || "").trim();
  if (!entityId) return null;
  const fcAccount = normalizeEmail(row?.fcAccount);
  if (!fcAccount) return null;
  const subject = String(row?.subject || "").trim();
  const subjectNorm = normalizeSubjectForMatch(subject);
  const bodyCore = normalizeBodyForAttribution(row?.body || row?.payload?.body || "");
  const keyLines = extractKeyLinesFromBody(bodyCore);
  const entities = extractEntitiesFromText(subject, bodyCore);
  return {
    outboundPageId: String(row?.pageId || "").trim(),
    entityId,
    fcAccount,
    authoredAt: authoredAt || nowIso(),
    subject,
    subjectNorm,
    bodyCore,
    keyLines,
    entities,
  };
}

function getOutboundAttributionCachePath() {
  return path.join(__dirname, ".cache", "outbound-attribution-cache.json");
}

function getAttributionMatchLogPath(cfg) {
  const base = cfg?.logging?.directory && String(cfg.logging.directory).trim()
    ? String(cfg.logging.directory).trim()
    : "log";
  const dir = path.isAbsolute(base) ? base : path.join(__dirname, base);
  return path.join(dir, "attribution-match.log");
}

function appendAttributionMatchLog(cfg, payload) {
  try {
    const p = getAttributionMatchLogPath(cfg);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify({ at: nowIso(), ...payload })}\n`, "utf8");
  } catch (e) {
    console.error("[executor][attribution] log write failed", e?.message ?? e);
  }
}

function readOutboundAttributionCacheFresh() {
  const cachePath = getOutboundAttributionCachePath();
  const out = { path: cachePath, items: [] };
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    out.items = items.filter((x) => x && typeof x === "object");
  } catch (_) {
    /* missing cache */
  }
  return out;
}

function saveOutboundAttributionCache(state) {
  if (!state?.path) return;
  const dir = path.dirname(state.path);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    state.path,
    JSON.stringify(
      {
        version: 1,
        updatedAt: nowIso(),
        windowDays: OUTBOUND_ATTRIBUTION_WINDOW_DAYS,
        items: Array.isArray(state.items) ? state.items : [],
      },
      null,
      2
    ),
    "utf8"
  );
}

function getInboundCachePath(cfg) {
  const p = String(cfg?.executor?.inboundContactCachePath || "").trim();
  if (!p) return path.join(__dirname, "inbound-contact-cache.json");
  if (path.isAbsolute(p)) return p;
  return path.join(__dirname, p);
}

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(String(raw || ""));
  } catch (_) {
    return fallback;
  }
}

function loadInboundContactCache(cfg) {
  if (inboundContactCacheState) return inboundContactCacheState;
  const cachePath = getInboundCachePath(cfg);
  let parsed = null;
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    parsed = safeJsonParse(raw, null);
  } catch (_) {
    parsed = null;
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  const byKey = new Map();
  for (const e of entries) {
    const fc = normalizeEmail(e?.fcAccount);
    const cp = normalizeEmail(e?.counterpartyEmail);
    const kp = String(e?.keyPersonId || "").trim();
    if (!fc || !cp || !kp) continue;
    const k = buildInboundCacheKey(fc, cp);
    // first-write wins
    if (!byKey.has(k)) byKey.set(k, {
      fcAccount: fc,
      counterpartyEmail: cp,
      keyPersonId: kp,
      entityPageId: String(e?.entityPageId || "").trim(),
    });
  }

  const messageMap = new Map();
  if (parsed?.messageMap) {
    for (const [k, v] of Object.entries(parsed.messageMap)) messageMap.set(k, v);
  }

  const domainMap = new Map();
  if (parsed?.domainMap) {
    for (const [k, v] of Object.entries(parsed.domainMap)) domainMap.set(k, v);
  }

  inboundContactCacheState = {
    path: cachePath,
    byKey,
    messageMap,
    domainMap,
    lastScanAtByAccount: parsed?.lastScanAtByAccount && typeof parsed.lastScanAtByAccount === "object"
      ? { ...parsed.lastScanAtByAccount }
      : {},
  };
  return inboundContactCacheState;
}

function saveInboundContactCache(state) {
  if (!state?.path) return;
  const entries = Array.from(state.byKey.values());
  const payload = {
    version: 2,
    updatedAt: new Date().toISOString(),
    entries,
    messageMap: Object.fromEntries(state.messageMap.entries()),
    domainMap: Object.fromEntries(state.domainMap.entries()),
    lastScanAtByAccount: state.lastScanAtByAccount || {},
  };
  const dir = path.dirname(state.path);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(state.path, JSON.stringify(payload, null, 2), "utf8");
}

/** Emails we may receive replies from (TB Active Receiver matches author to these). */
function collectOutboundRecipientEmailsForCache(row, partnerEmailResolved) {
  const out = new Set();
  const add = (v) => {
    const n = normalizeEmail(v);
    if (n) out.add(n);
  };
  add(partnerEmailResolved);
  add(row?.counterpartyEmail);
  const p = row?.payload;
  if (p && Array.isArray(p.to)) for (const x of p.to) add(x);
  else if (p && typeof p.to === "string") add(p.to);
  add(p?.to_email);
  return [...out];
}

/**
 * Merge one (fcAccount, counterpartyEmail, keyPersonId, entityPageId) into the JSON cache if missing.
 * Fresh read/write so webhook (`readContactCacheMapFresh`) sees updates; clears in-memory cache.
 */
function appendInboundCacheEntriesFromSendSuccess(cfg, row, partnerEmailResolved, payloadText) {
  const fc = normalizeEmail(row?.fcAccount);
  const kp = String(row?.keyPersonPageId || "").trim();
  const ep = String(row?.entityPageId || "").trim();
  if (!fc || !kp) return;
  if (row?.inNOut !== "Out") return;
  if (row?.actionText !== "Send Email" && row?.actionText !== "Reply Email") return;

  const recipients = collectOutboundRecipientEmailsForCache(row, partnerEmailResolved);
  if (recipients.length === 0) return;

  let minPayload = null;
  if (payloadText) minPayload = safeJsonParse(payloadText, null);

  const cachePath = getInboundCachePath(cfg);
  let parsed = null;
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    parsed = safeJsonParse(raw, null);
  } catch (_) {
    parsed = null;
  }

  const state = {
    path: cachePath,
    byKey: new Map(),
    messageMap: new Map(Object.entries(parsed?.messageMap || {})),
    domainMap: new Map(Object.entries(parsed?.domainMap || {})),
    lastScanAtByAccount: parsed?.lastScanAtByAccount || {}
  };

  for (const e of Array.isArray(parsed?.entries) ? parsed.entries : []) {
    const f = normalizeEmail(e?.fcAccount);
    const c = normalizeEmail(e?.counterpartyEmail);
    const kid = String(e?.keyPersonId || "").trim();
    if (!f || !c || !kid) continue;
    const k = buildInboundCacheKey(f, c);
    if (!state.byKey.has(k)) state.byKey.set(k, {
      fcAccount: f,
      counterpartyEmail: c,
      keyPersonId: kid,
      entityPageId: String(e?.entityPageId || "").trim(),
    });
  }

  let added = 0;
  for (const cp of recipients) {
    const key = buildInboundCacheKey(fc, cp);
    if (!state.byKey.has(key)) {
      state.byKey.set(key, { fcAccount: fc, counterpartyEmail: cp, keyPersonId: kp, entityPageId: ep });
      added += 1;
    }

    // Domain mapping — entityId = Entity page ID (Entity Name relation), not KeyPerson ID
    const parts = cp.split('@');
    if (parts.length === 2 && parts[1]) {
      const domain = parts[1].toLowerCase();
      if (!["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "qq.com", "163.com", "icloud.com"].includes(domain)) {
        state.domainMap.set(domain, { entityId: ep || kp, lastSentAt: new Date().toISOString() });
      }
    }
  }

  // Message ID mapping — entityId = Entity page ID; normalize to strip angle brackets
  if (minPayload?.headerMessageId) {
    const normalizedMsgId = normalizeMessageId(minPayload.headerMessageId);
    if (normalizedMsgId) {
      state.messageMap.set(normalizedMsgId, {
        entityId: ep || kp,
        outboundPageId: row?.pageId || "",
      });
    }
  }

  saveInboundContactCache(state);
  inboundContactCacheState = null;
  console.error("[executor] inbound contact cache updated after send", { fcAccount: fc, added, totalKeys: state.byKey.size });
}

function appendOutboundAttributionFromSendSuccess(row) {
  const cache = readOutboundAttributionCacheFresh();
  const record = buildOutboundAttributionRecordFromRow(row, nowIso());
  if (!record) return;
  const current = Array.isArray(cache.items) ? cache.items : [];
  const filtered = current.filter(
    (x) => String(x?.outboundPageId || "").trim() !== record.outboundPageId
  );
  filtered.push(record);
  filtered.sort((a, b) => Date.parse(String(b?.authoredAt || "")) - Date.parse(String(a?.authoredAt || "")));
  const cutoffMs = Date.now() - OUTBOUND_ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const trimmed = filtered.filter((x) => {
    const t = Date.parse(String(x?.authoredAt || ""));
    return Number.isFinite(t) && t >= cutoffMs;
  });
  const next = { path: cache.path, items: trimmed.slice(0, OUTBOUND_ATTRIBUTION_MAX_ROWS) };
  saveOutboundAttributionCache(next);
  outboundAttributionCacheState = null;
}

async function queryRecentSuccessOutRowsForAttribution(cfg) {
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const databaseId = cfg.notion.databaseId;
  const statusCol = String(cfg.executor?.notionPropertyNames?.Status || "OutReach Status").trim() || "OutReach Status";
  const executedAtProp =
    String(cfg.executor?.notionPropertyNames?.executed_at || "Completion Time").trim() || "Completion Time";
  const cutoffIso = new Date(Date.now() - OUTBOUND_ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const filter = {
    and: [
      { property: "Platform", select: { equals: "Email" } },
      { property: "InNOut", select: { equals: "Out" } },
      {
        or: [
          { property: "Action", select: { equals: "Send Email" } },
          { property: "Action", select: { equals: "Reply Email" } },
        ],
      },
      { property: statusCol, status: { equals: "Success" } },
      { property: executedAtProp, date: { on_or_after: cutoffIso } },
    ],
  };

  const outRows = [];
  let cursor = undefined;
  while (outRows.length < OUTBOUND_ATTRIBUTION_MAX_ROWS) {
    const data = await queryDatabase(notionCfg, databaseId, {
      pageSize: 100,
      filter,
      sorts: [{ property: executedAtProp, direction: "descending" }],
      startCursor: cursor,
    });
    const chunk = Array.isArray(data?.results) ? data.results : [];
    for (const p of chunk) {
      try {
        outRows.push(parseQueueRow(p));
      } catch (_) {
        /* skip malformed row */
      }
    }
    if (!data?.has_more || !data?.next_cursor || chunk.length === 0) break;
    cursor = data.next_cursor;
  }
  return outRows.slice(0, OUTBOUND_ATTRIBUTION_MAX_ROWS);
}

async function initOutboundAttributionCache(cfg) {
  try {
    const outRows = await queryRecentSuccessOutRowsForAttribution(cfg);
    const items = [];
    for (const row of outRows) {
      const authoredAt = row?.completionTime
        ? new Date(row.completionTime).toISOString()
        : nowIso();
      const rec = buildOutboundAttributionRecordFromRow(row, authoredAt);
      if (rec) items.push(rec);
    }
    const state = {
      path: getOutboundAttributionCachePath(),
      items: items.slice(0, OUTBOUND_ATTRIBUTION_MAX_ROWS),
    };
    saveOutboundAttributionCache(state);
    outboundAttributionCacheState = null;
    console.error("[executor] initOutboundAttributionCache completed", {
      rows: outRows.length,
      cached: state.items.length,
      path: state.path,
    });
  } catch (e) {
    console.error("[executor] initOutboundAttributionCache failed", e?.message ?? e);
  }
}

function matchUnknownInboundByThreeSignals({ cfg, payload, fcAccount }) {
  const cache = outboundAttributionCacheState || readOutboundAttributionCacheFresh();
  outboundAttributionCacheState = cache;
  const inboundSubjectNorm = normalizeSubjectForMatch(payload?.subject || "");
  const inboundBodyRaw =
    (typeof payload?.bodyPlain === "string" && payload.bodyPlain.trim())
      ? payload.bodyPlain
      : stripHtmlToPlain(payload?.bodyHtml || "");
  const inboundBodyNorm = canonicalTextForContains(inboundBodyRaw);
  const inboundEntities = extractEntitiesFromText(payload?.subject || "", inboundBodyRaw, payload?.author || "");

  const candidates = (cache.items || [])
    .filter((x) => normalizeEmail(x?.fcAccount) === normalizeEmail(fcAccount))
    .slice(0, OUTBOUND_ATTRIBUTION_MAX_ROWS);

  const inspected = [];
  const passed = [];

  for (const c of candidates) {
    const subjHit = subjectContainsMatch(inboundSubjectNorm, normalizeSubjectForMatch(c?.subjectNorm || c?.subject || ""));
    const outboundBodyNorm = canonicalTextForContains(c?.bodyCore || "");
    const bodyHit = bodyContainsMatch(inboundBodyNorm, outboundBodyNorm) || bodyContainsByKeyLines(inboundBodyNorm, c?.keyLines);
    const overlap = entityOverlap(inboundEntities, c?.entities || []);
    const entityHit = overlap.count >= OUTBOUND_ATTRIBUTION_MIN_ENTITY_OVERLAP;
    const allHit = subjHit && bodyHit && entityHit;

    const one = {
      outboundPageId: c?.outboundPageId || "",
      entityId: c?.entityId || "",
      authoredAt: c?.authoredAt || "",
      subjectHit: subjHit,
      bodyHit,
      entityHit,
      entityOverlapCount: overlap.count,
      overlapEntities: overlap.overlap.slice(0, 8),
      keyLineCount: Array.isArray(c?.keyLines) ? c.keyLines.length : 0,
      subject: c?.subject || "",
    };
    inspected.push(one);
    if (allHit) passed.push({ ...one, source: c });
  }

  passed.sort((a, b) => Date.parse(String(b?.authoredAt || "")) - Date.parse(String(a?.authoredAt || "")));
  const winner = passed[0] || null;

  appendAttributionMatchLog(cfg, {
    kind: "three_signal_match",
    inbound: {
      fcAccount: normalizeEmail(fcAccount),
      author: payload?.author || "",
      subject: payload?.subject || "",
      headerMessageId: payload?.headerMessageId || "",
      messageId: payload?.messageId || "",
      inboundEntities,
    },
    summary: {
      candidateCount: candidates.length,
      passCount: passed.length,
      matched: !!winner,
      matchedOutboundPageId: winner?.outboundPageId || "",
      matchedEntityId: winner?.entityId || "",
    },
    inspectedTop: inspected.slice(0, 10),
  });

  if (!winner) return null;
  return {
    entityId: winner.entityId,
    outboundPageId: winner.outboundPageId,
    matchReason: "three_signal_match",
    classification: "Human Reply Stranger Attribution",
  };
}

/** Read contact cache JSON from disk (fresh read for webhook; does not use in-memory cache). */
function readContactCacheMapFresh(cfg) {
  const cachePath = getInboundCachePath(cfg);
  const state = {
    byKey: new Map(),
    messageMap: new Map(),
    domainMap: new Map(),
    lastScanAtByAccount: {},
  };
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    for (const e of Array.isArray(parsed?.entries) ? parsed.entries : []) {
      const fc = normalizeEmail(e?.fcAccount);
      const cp = normalizeEmail(e?.counterpartyEmail);
      const kp = String(e?.keyPersonId || "").trim();
      if (!fc || !cp || !kp) continue;
      const k = buildInboundCacheKey(fc, cp);
      if (!state.byKey.has(k)) state.byKey.set(k, {
        keyPersonId: kp,
        entityPageId: String(e?.entityPageId || "").trim(),
        fcAccount: fc,
        counterpartyEmail: cp,
      });
    }
    if (parsed?.messageMap) {
      for (const [k, v] of Object.entries(parsed.messageMap)) state.messageMap.set(k, v);
    }
    if (parsed?.domainMap) {
      for (const [k, v] of Object.entries(parsed.domainMap)) state.domainMap.set(k, v);
    }
    if (parsed?.lastScanAtByAccount && typeof parsed.lastScanAtByAccount === "object") {
      state.lastScanAtByAccount = { ...parsed.lastScanAtByAccount };
    }
  } catch (_) {
    /* missing file or invalid JSON → empty maps */
  }
  return state;
}

async function initResolverCache(cfg) {
  if (!cfg.executor.initResolverCacheOnStartup) return;
  const cacheMap = readContactCacheMapFresh(cfg);
  
  if (cacheMap.messageMap.size > 0 && cacheMap.domainMap.size > 0) {
    console.error("[executor] initResolverCache: messageMap/domainMap are already somewhat populated. Appending missing recent ones...");
  }
  
  console.error("[executor] initResolverCache: Starting backfill from Notion...");
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const databaseId = cfg.notion.databaseId;
  const statusCol = String(cfg.executor?.notionPropertyNames?.Status || "OutReach Status").trim() || "OutReach Status";

  const filter = {
    and: [
      { property: "Platform", select: { equals: "Email" } },
      { property: "InNOut", select: { equals: "Out" } },
      {
        or: [
          { property: "Action", select: { equals: "Send Email" } },
          { property: "Action", select: { equals: "Reply Email" } },
        ],
      },
      { property: statusCol, status: { equals: "Success" } },
    ],
  };
  const sorts = [{ property: "Completion Time", direction: "descending" }];
  
  let addedDomains = 0;
  let addedMessages = 0;
  let cursor = undefined;
  const outRows = [];
  
  try {
    while (outRows.length < 5000) {
      const data = await queryDatabase(notionCfg, databaseId, {
        pageSize: 100,
        sorts,
        filter,
        startCursor: cursor,
      });
      const chunk = Array.isArray(data?.results) ? data.results : [];
      outRows.push(...chunk);
      if (!data?.has_more || !data?.next_cursor || chunk.length === 0) break;
      cursor = data.next_cursor;
    }
  } catch (e) {
    console.error("[executor] initResolverCache: queryDatabase failed", e?.message ?? e);
    return;
  }
  
  console.error(`[executor] initResolverCache: Pulled ${outRows.length} recent Outbound rows from Notion.`);

  let addedEntries = 0;

  for (const page of outRows) {
    let row;
    try {
      row = parseQueueRow(page);
    } catch (_) { continue; }

    const fc = normalizeEmail(row?.fcAccount);
    const cp = normalizeEmail(row?.counterpartyEmail);
    const kp = String(row?.keyPersonPageId || "").trim();
    const ep = String(row?.entityPageId || "").trim();
    if (!fc || !kp) continue;

    // Participant entries (byKey) — covers counterpartyEmail + all To/CC recipients
    const recipients = collectOutboundRecipientEmailsForCache(row, cp);
    for (const r of recipients) {
      const key = buildInboundCacheKey(fc, r);
      if (!cacheMap.byKey.has(key)) {
        cacheMap.byKey.set(key, { fcAccount: fc, counterpartyEmail: r, keyPersonId: kp, entityPageId: ep });
        addedEntries++;
      }
    }

    // Domain mapping — entityId = Entity page ID (Entity Name relation)
    if (cp) {
      const parts = cp.split('@');
      if (parts.length === 2 && parts[1]) {
        const domain = parts[1].toLowerCase();
        if (!["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "qq.com", "163.com", "icloud.com"].includes(domain)) {
          if (!cacheMap.domainMap.has(domain)) {
            cacheMap.domainMap.set(domain, { entityId: ep || kp, lastSentAt: row.executedAt || new Date().toISOString() });
            addedDomains++;
          }
        }
      }
    }

    // Message ID mapping — entityId = Entity page ID; normalized to strip angle brackets
    const p = row?.payload || {};
    const rawHeaderMessageId = p.headerMessageId || p.messageId;
    const headerMessageId = normalizeMessageId(rawHeaderMessageId);
    if (headerMessageId && !cacheMap.messageMap.has(headerMessageId)) {
      cacheMap.messageMap.set(headerMessageId, { entityId: ep || kp, outboundPageId: row.pageId });
      addedMessages++;
    }
  }

  if (addedDomains > 0 || addedMessages > 0 || addedEntries > 0) {
    const state = {
      path: getInboundCachePath(cfg),
      byKey: cacheMap.byKey,
      messageMap: cacheMap.messageMap,
      domainMap: cacheMap.domainMap,
      lastScanAtByAccount: cacheMap.lastScanAtByAccount || {},
    };
    saveInboundContactCache(state);
    inboundContactCacheState = null;
    console.error(`[executor] initResolverCache: Backfilled ${addedMessages} messages, ${addedDomains} domains, ${addedEntries} participants.`);
  } else {
    console.error("[executor] initResolverCache: No new mappings found in Notion to backfill.");
  }
}

function stripHtmlToPlain(s) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeIdForInboundMessage(msg) {
  const hid = String(msg?.headerMessageId || "").trim();
  if (hid) return { value: hid, kind: "headerMessageId" };
  const mid = String(msg?.messageId || "").trim();
  if (mid) return { value: mid, kind: "messageId" };
  return { value: "", kind: "none" };
}

async function queryAllInboundPages(notionCfg, databaseId, pageSize) {
  const out = [];
  let cursor = undefined;
  while (true) {
    const data = await queryInboundPages(notionCfg, databaseId, pageSize, cursor);
    const chunk = Array.isArray(data?.results) ? data.results : [];
    out.push(...chunk);
    if (!data?.has_more || !data?.next_cursor || chunk.length === 0) break;
    cursor = data.next_cursor;
  }
  return out;
}

async function queryAllSuccessOutPages(notionCfg, databaseId, pageSize, outreachStatusProp) {
  const out = [];
  let cursor = undefined;
  const statusCol = String(outreachStatusProp || "OutReach Status").trim() || "OutReach Status";
  const filter = {
    and: [
      { property: "Platform", select: { equals: "Email" } },
      { property: "InNOut", select: { equals: "Out" } },
      {
        or: [
          { property: "Action", select: { equals: "Send Email" } },
          { property: "Action", select: { equals: "Reply Email" } },
        ],
      },
      // Notion "Status" column type — must use `status` filter, never `select`.
      { property: statusCol, status: { equals: "Success" } },
    ],
  };
  const sorts = [{ property: "Completion Time", direction: "ascending" }];
  while (true) {
    const data = await queryDatabase(notionCfg, databaseId, {
      pageSize,
      sorts,
      filter,
      startCursor: cursor,
    });
    const chunk = Array.isArray(data?.results) ? data.results : [];
    out.push(...chunk);
    if (!data?.has_more || !data?.next_cursor || chunk.length === 0) break;
    cursor = data.next_cursor;
  }
  return out;
}

async function getCachedSuccessOutRows(cfg) {
  const now = Date.now();
  if (
    cachedSuccessOutRowsForWebhook.rows?.length &&
    now - cachedSuccessOutRowsForWebhook.at < SUCCESS_OUT_ROWS_TTL_MS
  ) {
    return cachedSuccessOutRowsForWebhook.rows;
  }
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const databaseId = cfg.notion.databaseId;
  const outreachStatusCol = cfg.executor?.notionPropertyNames?.Status || "OutReach Status";
  const pages = await queryAllSuccessOutPages(
    notionCfg,
    databaseId,
    Math.max(100, cfg.executor.pageSize || 20),
    outreachStatusCol
  );
  const rows = pages
    .map((p) => parseQueueRow(p))
    .filter(
      (r) =>
        r.platform === "Email" &&
        r.inNOut === "Out" &&
        r.status === "Success" &&
        (r.actionText === "Send Email" || r.actionText === "Reply Email")
    );
  cachedSuccessOutRowsForWebhook = { at: now, rows };
  return rows;
}

/**
 * minimal-server `is_reply`:
 * - In-Reply-To or References contains ≥1 parseable Message-ID, OR
 * - (historical contact: exact or non-consumer domain) AND subject overlap AND inbound body overlaps outbound body.
 */
async function computeIsReplyForWebhook(cfg, payload, cacheMap, fc, author, replyText) {
  const irt = String(payload.inReplyTo || "").trim();
  const refs = String(payload.references || "").trim();
  if (headerFieldHasParseableMessageId(irt) || headerFieldHasParseableMessageId(refs)) {
    return { isReply: true, reason: "threading_headers", matchedOut: null };
  }
  if (!hasHistoricalContactForReply(cacheMap, fc, author)) {
    return { isReply: false, reason: "no_historical_contact", matchedOut: null };
  }
  const successOutRows = await getCachedSuccessOutRows(cfg);
  const candidates = filterSuccessOutRowsForFcAndAuthor(successOutRows, fc, author);
  if (candidates.length === 0) {
    return { isReply: false, reason: "no_outbound_candidate", matchedOut: null };
  }
  const matchedOut = findBestMatchingOutRowFromCandidates(candidates, payload.subject || "");
  if (!matchedOut) {
    return { isReply: false, reason: "no_subject_match", matchedOut: null };
  }
  const inboundSubjectNorm = normalizeSubjectForMatch(payload.subject || "");
  const outSubjectNorm = normalizeSubjectForMatch(matchedOut.subject || "");
  if (!subjectContainsMatch(inboundSubjectNorm, outSubjectNorm)) {
    return { isReply: false, reason: "subject_mismatch", matchedOut: null };
  }
  const inboundBodyNorm = canonicalTextForContains(replyText);
  const outBody = normalizeBodyForAttribution(matchedOut.body || matchedOut.payload?.body || "");
  const outBodyNorm = canonicalTextForContains(outBody);
  if (!bodyContainsMatch(inboundBodyNorm, outBodyNorm)) {
    return { isReply: false, reason: "body_no_overlap", matchedOut: null };
  }
  return { isReply: true, reason: "subject_contact_body", matchedOut };
}

function buildOutboundCacheCandidates(rows, allowedSenders) {
  const result = [];
  for (const row of rows || []) {
    const fc = normalizeEmail(row?.fcAccount);
    const cp = normalizeEmail(row?.counterpartyEmail);
    const kp = String(row?.keyPersonPageId || "").trim();
    if (!fc || !cp || !kp) continue;
    if (allowedSenders && !allowedSenders.has(fc)) continue;
    result.push({
      fcAccount: fc,
      counterpartyEmail: cp,
      keyPersonId: kp,
      row,
    });
  }
  return result;
}

function buildInboundDedupKey(fcAccount, inboundMsg) {
  const fc = normalizeEmail(fcAccount);
  const id = dedupeIdForInboundMessage(inboundMsg);
  if (!fc || !id.value) return "";
  return `${fc}|${id.value}`;
}

function collectInboundDedupKeys(pages) {
  const keys = new Set();
  for (const page of pages || []) {
    const row = parseQueueRow(page);
    const fc = normalizeEmail(row?.fcAccount);
    const payload = row?.payload || {};
    const hid = String(payload?.headerMessageId || payload?.messageHeaderId || "").trim();
    const mid = String(payload?.messageId || "").trim();
    const id = hid || mid;
    if (fc && id) keys.add(`${fc}|${id}`);
  }
  return keys;
}

function findBestMatchingOutRow(rows, fcAccount, counterpartyEmail, subjectText) {
  const fc = normalizeEmail(fcAccount);
  const cp = normalizeEmail(counterpartyEmail);
  if (!fc || !cp) return null;
  const normalizedInboundSubject = normalizeSubjectForMatch(subjectText);
  let fallback = null;
  for (const row of rows || []) {
    if (normalizeEmail(row?.fcAccount) !== fc) continue;
    if (normalizeEmail(row?.counterpartyEmail) !== cp) continue;
    if (!fallback) fallback = row;
    const outNormalized = normalizeSubjectForMatch(row?.subject || "");
    if (outNormalized && normalizedInboundSubject && outNormalized === normalizedInboundSubject) return row;
    if (outNormalized && normalizedInboundSubject && String(subjectText || "").toLowerCase().includes(outNormalized)) {
      return row;
    }
  }
  return fallback;
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

async function queryInboundPages(notionCfg, databaseId, pageSize, startCursor) {
  const filter = {
    and: [
      { property: "Platform", select: { equals: "Email" } },
      { property: "InNOut", select: { equals: "In" } },
    ],
  };
  return await queryDatabase(notionCfg, databaseId, { pageSize, filter, startCursor });
}

function buildFcAccountFilter(localSenders, kind) {
  const emails = Array.from(new Set((localSenders || []).map((x) => normalizeEmail(x)).filter(Boolean)));
  if (emails.length === 0) return null;
  if (kind === "rich_text_equals") {
    return { or: emails.map((em) => ({ property: "FCAccount", rich_text: { equals: em } })) };
  }
  if (kind === "rich_text_contains") {
    return { or: emails.map((em) => ({ property: "FCAccount", rich_text: { contains: em } })) };
  }
  if (kind === "email_equals") {
    return { or: emails.map((em) => ({ property: "FCAccount", email: { equals: em } })) };
  }
  if (kind === "select_equals") {
    return { or: emails.map((em) => ({ property: "FCAccount", select: { equals: em } })) };
  }
  return null;
}

async function queryOutboundCandidatePages({
  notionCfg,
  databaseId,
  pageSize,
  maxScanRows,
  lowerBound,
  upperBound,
  localSenders = [],
  outreachStatusProp,
}) {
  const sorts = [{ property: "Trigger Time", direction: "ascending" }];
  const statusCol = String(outreachStatusProp || "OutReach Status").trim() || "OutReach Status";
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
      name: "outreach_status=status(Todo)",
      filter: { and: [...baseClauses, { property: statusCol, status: { equals: "Todo" } }] },
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
  const fcPlanKinds = ["rich_text_equals", "rich_text_contains", "email_equals", "select_equals"];
  const fcPlans = [];
  for (const k of fcPlanKinds) {
    const fc = buildFcAccountFilter(localSenders, k);
    if (!fc) continue;
    fcPlans.push({
      name: `outreach_status=status(Todo),fc_filter=${k}`,
      filter: { and: [...baseClauses, { property: statusCol, status: { equals: "Todo" } }, fc] },
    });
    fcPlans.push({
      name: `status_filter=none,fc_filter=${k}`,
      filter: { and: [...baseClauses, fc] },
    });
  }
  const plans = fcPlans.length > 0 ? [...fcPlans, ...filterPlans] : filterPlans;

  let lastError = null;
  for (const plan of plans) {
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

function buildInboundCreateProperties(sourceRow, inboundMsg, propNames, keyPersonId) {
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
  /** 入站实际收件身份（谁收到回信写谁），优先扩展上报的 fcAccount / to_email */
  const fcResolved =
    normalizeEmail(inboundMsg.fcAccount || inboundMsg.to_email) || normalizeEmail(sourceRow?.fcAccount);

  const mappings = [
    ["Platform", "Email"],
    ["InNOut", "In"],
    ["Action", "Inbound Reply"],
    [p.Status || "Status", "Success"],
    [p.reply_status || "Reply Status", "Todo"],
    [p.executed_at || "Completion Time", new Date(inboundMsg.date || Date.now())],
    [p.execution_result_detail || "Result Remark", inboundMsg.snippet || inboundMsg.subject || "Inbound reply captured"],
    [p.payload || "Payload", JSON.stringify(inboundMsg.payload || {})],
    ["FCAccount", fcResolved],
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

  const kpTarget = String(keyPersonId || "").trim();
  if (kpTarget) {
    const kt = getPropertyType(srcPage, "KeyPerson ID");
    if (kt === "relation") props["KeyPerson ID"] = { relation: [{ id: kpTarget }] };
  }

  const replyEmailCol = String(p.reply_email || "Reply Email").trim();
  const replyAuthorEmail = extractEmail(inboundMsg?.authorEmail || inboundMsg?.author || "");
  if (replyEmailCol && replyAuthorEmail) {
    const rt = getPropertyType(srcPage, replyEmailCol);
    if (rt === "email") props[replyEmailCol] = notionFromValueByType("email", replyAuthorEmail);
  }

  const entityCol = String(p.entity_name || "Entity Name").trim();
  const entityPageIdForRow = String(inboundMsg.entityPageId || "").trim();
  if (entityPageIdForRow && entityCol) {
    const et = getPropertyType(srcPage, entityCol);
    if (et === "relation") props[entityCol] = { relation: [{ id: entityPageIdForRow }] };
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
  const outreachStatusCol = cfg.executor?.notionPropertyNames?.Status || "OutReach Status";
  const accountsPayload = await getAccountsPayload(cfg, enqueueAndWait, `inbound-${Date.now()}`);
  const allowedSenders = listAllowedSenderEmails(accountsPayload);
  const cacheState = loadInboundContactCache(cfg);
  const successOutPages = await queryAllSuccessOutPages(
    notionCfg,
    databaseId,
    Math.max(100, cfg.executor.pageSize),
    outreachStatusCol
  );
  const successOutRows = successOutPages
    .map((p) => parseQueueRow(p))
    .filter((r) =>
      r.platform === "Email" &&
      r.inNOut === "Out" &&
      r.status === "Success" &&
      (r.actionText === "Send Email" || r.actionText === "Reply Email")
    );
  const cacheCandidates = buildOutboundCacheCandidates(successOutRows, allowedSenders);
  let cacheInserted = 0;
  for (const c of cacheCandidates) {
    const key = buildInboundCacheKey(c.fcAccount, c.counterpartyEmail);
    if (!cacheState.byKey.has(key)) {
      cacheState.byKey.set(key, {
        fcAccount: c.fcAccount,
        counterpartyEmail: c.counterpartyEmail,
        keyPersonId: c.keyPersonId,
      });
      cacheInserted += 1;
    }
  }
  saveInboundContactCache(cacheState);
  const templateRow = successOutRows.find((r) => r?.raw) || null;
  if (!templateRow) {
    console.error("[executor][inbound] no success out rows found for schema template");
    return;
  }

  const inboundPages = await queryAllInboundPages(notionCfg, databaseId, Math.max(100, cfg.executor.pageSize));
  const existingInboundDedupKeys = collectInboundDedupKeys(inboundPages);
  mergeDedupeKeysInto(cfg, existingInboundDedupKeys);
  console.error("[executor][inbound] scanning", {
    successOutRows: successOutRows.length,
    cacheEntries: cacheState.byKey.size,
    cacheInserted,
    existingInbound: existingInboundDedupKeys.size,
    loggedInFcAccounts: allowedSenders.size,
  });

  const inboundLimit = Math.max(100, Number(cfg?.executor?.inboundMessageLimit) || 2000);
  for (const accountObj of accountsPayload.accounts || []) {
    const localFcAccounts = (accountObj.identities || [])
      .map((idn) => normalizeEmail(idn?.email))
      .filter((x) => x && allowedSenders.has(x));
    if (localFcAccounts.length === 0) continue;
    const inboxFolderId = findSpecialFolder(accountObj?.rootFolder, "inbox");
    if (!inboxFolderId) continue;
    const fromDateIso = cacheState.lastScanAtByAccount?.[accountObj.accountId] || "";
    const fromDate = fromDateIso ? new Date(fromDateIso) : null;
    const payload = {
      accountId: accountObj.accountId,
      folderId: inboxFolderId,
      includeBody: true,
      limit: inboundLimit,
      messagesPerPage: 50,
    };
    if (fromDate instanceof Date && !isNaN(fromDate.valueOf())) {
      payload.fromDate = fromDate.toISOString();
    }
    const findRes = await enqueueAndWait({
      request_id: `inbound-find-${accountObj.accountId}-${Date.now()}`,
      action: "findMessages",
      payload,
    });
    console.error("[executor][inbound] findMessages query", {
      accountId: accountObj.accountId,
      folderId: inboxFolderId,
      fromDate: fromDate instanceof Date ? fromDate.toISOString() : null,
      fcAccounts: localFcAccounts,
      limit: inboundLimit,
      messagesPerPage: 50,
    });
    if (!findRes?.success) {
      continue;
    }
    const items = findRes?.result?.items || [];
    console.error("[executor][inbound] findMessages result", {
      accountId: accountObj.accountId,
      totalItems: items.length,
      sampleHeaders: items.slice(0, 3).map((m) => ({
        messageId: m.messageId,
        headerMessageId: m.headerMessageId,
        author: m.author,
        subject: m.subject,
        date: m.date,
      })),
    });

    for (const target of items) {
      const authorEmail = extractEmail(target.author);
      if (!authorEmail) continue;
      let matchedFc = "";
      let matchedCache = null;
      for (const fc of localFcAccounts) {
        const key = buildInboundCacheKey(fc, authorEmail);
        if (cacheState.byKey.has(key)) {
          matchedFc = fc;
          matchedCache = cacheState.byKey.get(key);
          break;
        }
      }
      if (!matchedFc || !matchedCache?.keyPersonId) continue;
      const dedupKey = buildInboundDedupKey(matchedFc, target);
      if (!dedupKey || existingInboundDedupKeys.has(dedupKey)) continue;

      const matchedOut = findBestMatchingOutRow(successOutRows, matchedFc, authorEmail, target.subject || "");
      const metadataPayload = {
        messageId: target.messageId,
        headerMessageId: target.headerMessageId || "",
        replyToHeaderMessageId: target.headerMessageId || "",
        conversationAnchor: matchedOut?.payload?.conversationAnchor || matchedOut?.payload?.headerMessageId || target.headerMessageId || "",
        sourceOutPageId: matchedOut?.pageId || "",
        to_email: authorEmail,
        counterpartyEmail: authorEmail,
        from_email: matchedFc,
        cacheMatched: true,
        keyPersonId: matchedCache.keyPersonId,
      };
      const createProps = buildInboundCreateProperties(
        matchedOut || templateRow,
        {
          ...target,
          subject: target.subject || matchedOut?.subject || "",
          replyText: target.body || "",
          fcAccount: matchedFc,
          to_email: matchedFc,
          entityPageId: String(matchedCache.entityPageId || "").trim(),
          payload: metadataPayload,
        },
        cfg.executor?.notionPropertyNames,
        matchedCache.keyPersonId
      );
      if (Object.keys(createProps).length === 0) continue;
      await createPage(notionCfg, databaseId, createProps);
      if (matchedOut) {
        await markReplyDone(cfg, matchedOut, `inbound_reply_detected:${target.headerMessageId || target.messageId}`);
      }
      existingInboundDedupKeys.add(dedupKey);
      addDedupeKey(cfg, dedupKey);
      console.error("[executor][inbound] captured inbound", {
        outTaskId: matchedOut?.taskId || "",
        inboundHeaderMessageId: target.headerMessageId,
        inboundMessageId: target.messageId,
        fcAccount: matchedFc,
        keyPersonId: matchedCache.keyPersonId,
      });
    }

    cacheState.lastScanAtByAccount[accountObj.accountId] = nowIso();
    saveInboundContactCache(cacheState);
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
    const errCode = out?.error?.code || "";
    const errMsg = String(out?.error?.message || "");
    const isSendAction = actionName === "Send Email" || actionName === "Reply Email";
    const mayHaveSent = isSendAction && (
      errCode === "TIMEOUT" ||
      errMsg.toLowerCase().includes("fetch failed") ||
      errMsg.toLowerCase().includes("timeout")
    );
    const warningPrefix = mayHaveSent
      ? "⚠️ WARNING: Email may have been sent successfully despite this error. " +
        "The extension timed out or lost connection during send — please verify in Sent folder before retrying.\n\n"
      : "";
    const detailText = warningPrefix + makeDetail({
      ok: false,
      reason: mayHaveSent ? "send_uncertain_timeout" : "api_error",
      action: mapped.envelope.action,
      requestId: mapped.envelope.request_id,
      extensionError: out?.error ?? out,
    });
    return await failWriteback({ cfg, row, reason: mayHaveSent ? "send_uncertain_timeout" : "api_error", detail: detailText, externalEventId });
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
    partnerEmailResolved: resolvedPartnerEmail,
  });
}

function mapActionToEnvelope({ row, externalEventId, accountId, identityId, requestId, replyMessageId, migratedPayload, partnerEmail }) {
  const t = row.actionText;
  const toMailbox = normalizeEmail(partnerEmail || row.counterpartyEmail);
  const effectiveBodyFormat = migratedPayload?.bodyFormat ?? row.bodySourceFormat;
  const rawOutreachBody = String(row.body || "").trim();
  /** 扩展 `replyEmail` 要求 body 非空；未在 Notion 存正文时发单空格，由 TB 在 beginReply 中按原信展示。 */
  const bodySourceForReply =
    t === "Reply Email" && !rawOutreachBody ? " " : row.body;
  const bodyResolved = resolveBodyForCompose(
    t === "Reply Email" ? bodySourceForReply : row.body,
    effectiveBodyFormat
  );
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

async function successWriteback({ cfg, row, detail, externalEventId, payloadText, partnerEmailResolved }) {
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const propNames = cfg.executor?.notionPropertyNames;
  const props = buildWritebackProperties({
    statusName: "Success",
    executedAt: new Date(),
    detailText: detail,
    externalEventId,
    payloadText,
  }, propNames);
  try {
    await updatePage(notionCfg, row.pageId, props);
  } catch (e) {
    console.error("[executor] writeback failed (success)", { taskId: row.taskId, pageId: row.pageId, error: e?.message ?? e });
    throw e;
  }
  try {
    appendInboundCacheEntriesFromSendSuccess(cfg, row, partnerEmailResolved, payloadText);
  } catch (e) {
    console.error("[executor] inbound cache update after success failed", { taskId: row.taskId, error: e?.message ?? e });
  }
  try {
    appendOutboundAttributionFromSendSuccess(row);
  } catch (e) {
    console.error("[executor] outbound attribution cache update after success failed", {
      taskId: row.taskId,
      error: e?.message ?? e,
    });
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

async function expireWriteback({ cfg, row, detail, externalEventId }) {
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const propNames = cfg.executor?.notionPropertyNames;
  const preferredStatus = cfg.executor?.expiredStatusName || "Expired";
  const fallbackStatus = "Failed";
  const tryWrite = async (statusName) => {
    const props = buildWritebackProperties({
      statusName,
      executedAt: new Date(),
      detailText: detail,
      externalEventId: externalEventId ?? "",
    }, propNames);
    await updatePage(notionCfg, row.pageId, props);
    return { kind: "written", ok: false, reason: "expired", statusName };
  };
  try {
    return await tryWrite(preferredStatus);
  } catch (e) {
    if (preferredStatus === fallbackStatus) throw e;
    console.error("[executor] writeback failed (expired, fallback to Failed)", {
      taskId: row.taskId,
      pageId: row.pageId,
      preferredStatus,
      error: e?.message ?? e,
    });
    return await tryWrite(fallbackStatus);
  }
}

/** Max age (ms) for a Progress claim before it is considered stale and recovered. */
const STALE_CLAIM_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Recover rows stuck in Progress (claimed_by_executor) due to process crash.
 * Rolls them back to Todo so the next cycle can re-execute them.
 */
async function recoverStaleClaims({ cfg }) {
  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const databaseId = cfg.notion.databaseId;
  const outreachStatusCol = cfg.executor?.notionPropertyNames?.Status || "OutReach Status";
  const propNames = cfg.executor?.notionPropertyNames;

  try {
    const filter = {
      and: [
        { property: "Platform", select: { equals: "Email" } },
        { property: "InNOut", select: { equals: "Out" } },
        { property: outreachStatusCol, status: { equals: "Progress" } },
      ],
    };
    const data = await queryDatabase(notionCfg, databaseId, {
      pageSize: 20,
      filter,
      sorts: [{ property: "Completion Time", direction: "ascending" }],
    });
    const pages = Array.isArray(data?.results) ? data.results : [];
    const now = Date.now();
    let recovered = 0;

    for (const page of pages) {
      const row = parseQueueRow(page);
      if (!row.completionTime) continue;
      const claimedAt = row.completionTime instanceof Date ? row.completionTime.valueOf() : Date.parse(row.completionTime);
      if (!Number.isFinite(claimedAt)) continue;
      const age = now - claimedAt;
      if (age < STALE_CLAIM_MS) continue;

      // This row has been stuck in Progress for too long — roll back to Todo.
      try {
        const rollbackProps = buildWritebackProperties({
          statusName: "Todo",
          executedAt: new Date(),
          detailText: `⚠️ Auto-recovered from stale Progress (stuck for ${Math.round(age / 1000)}s). Previous claim was at ${row.completionTime instanceof Date ? row.completionTime.toISOString() : row.completionTime}. Will be re-executed next cycle.`,
          externalEventId: row.externalEventId || "",
        }, propNames);
        await updatePage(notionCfg, row.pageId, rollbackProps);
        recovered += 1;
        console.error("[executor][stale-recovery] recovered stale claim", {
          taskId: row.taskId,
          pageId: row.pageId,
          ageSeconds: Math.round(age / 1000),
        });
      } catch (e) {
        console.error("[executor][stale-recovery] rollback failed", {
          taskId: row.taskId,
          error: e?.message ?? e,
        });
      }
    }
    if (recovered > 0) {
      console.error("[executor][stale-recovery] recovered total", { recovered, scanned: pages.length });
    }
  } catch (e) {
    // Non-fatal: if the stale-recovery query fails, just proceed with normal execution.
    console.error("[executor][stale-recovery] query failed", { error: e?.message ?? e });
  }
}

async function runOnce({ cfg, enqueueAndWait }) {
  // Recover any rows stuck in Progress from a previous crash/restart.
  await recoverStaleClaims({ cfg });

  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const databaseId = cfg.notion.databaseId;
  const now = new Date();
  const lookbackMs = Number(cfg?.executor?.triggerLookbackMs) || 24 * 60 * 60 * 1000;
  const horizonMs = Number(cfg?.executor?.triggerHorizonMs) || 30 * 60 * 1000;
  const maxScanRows = Math.max(cfg.executor.pageSize, Number(cfg?.executor?.maxScanRows) || 200);
  const lowerBound = new Date(now.valueOf() - lookbackMs);
  const upperBound = new Date(now.valueOf() + horizonMs);
  let accountsPayload = null;
  let allowedSenders = new Set();
  try {
    accountsPayload = await getAccountsPayload(cfg, enqueueAndWait, `run-${Date.now()}`);
    allowedSenders = listAllowedSenderEmails(accountsPayload);
  } catch (e) {
    console.error("[executor][outbound] prefetch listAccounts failed", e?.message ?? e);
  }
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
      "Trigger Time in [now-lookback, now+horizon] (Notion coarse filter) AND local eligibility checks: Platform=Email, InNOut=Out, OutReach Status=Todo, Action in (Send Email, Reply Email), FCAccount in local identities",
  });
  let results = [];
  const outreachStatusCol = cfg.executor?.notionPropertyNames?.Status || "OutReach Status";
  try {
    const queryRes = await queryOutboundCandidatePages({
      notionCfg,
      databaseId,
      pageSize: cfg.executor.pageSize,
      maxScanRows,
      lowerBound,
      upperBound,
      localSenders: Array.from(allowedSenders),
      outreachStatusProp: outreachStatusCol,
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
    expired: 0,
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
      const timing = classifyWindowTiming(row.executeWindow, now, cfg?.executor?.executeWindowGraceMs);
      if (timing === "expired") {
        try {
          const externalEventId = computeExternalEventId(row.taskId, row.actionText || "unknown");
          await expireWriteback({
            cfg,
            row,
            detail: `expired_window:${row.executeWindow?.end ? row.executeWindow.end.toISOString() : "no_end"}`,
            externalEventId,
          });
          rejectStats.expired += 1;
          continue;
        } catch (e) {
          // If expire writeback fails, keep old behavior as out-of-window reject (no crash).
          console.error("[executor][outbound] expire writeback failed, keep as out_of_window", {
            taskId: row.taskId,
            error: e?.message ?? e,
          });
        }
      }
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
    if (!accountsPayload) {
      rejectStats.listAccountsFailed = preFc.length;
      console.error("[executor][outbound] listAccounts failed (Thunderbird extension not responding?)", {
        deferredTaskCount: preFc.length,
        hint: "Ensure the extension is enabled and polling GET /next on minimal-server.",
      });
    } else {
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
        const errMsg = String(e?.message ?? "");
        const isSendAction = row.actionText === "Send Email" || row.actionText === "Reply Email";
        const mayHaveSent = isSendAction && (
          errMsg.toLowerCase().includes("fetch failed") ||
          errMsg.toLowerCase().includes("timeout") ||
          errMsg.toLowerCase().includes("network")
        );
        const warningPrefix = mayHaveSent
          ? "⚠️ WARNING: Email may have been sent successfully despite this error. " +
            "The extension crashed or lost connection during send — please verify in Sent folder before retrying.\n\n"
          : "";
        const detail = warningPrefix + makeDetail({
          ok: false,
          reason: "executor_exception",
          action: row.actionText,
          requestId: `exec-${row.taskId}-${row.actionText}-exception`,
          extensionError: { message: e?.message ?? String(e), details: e?.details },
        });
        await failWriteback({
          cfg,
          row,
          reason: mayHaveSent ? "executor_exception_uncertain" : "executor_exception",
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

/**
 * One Notion row to copy property types from when creating webhook-driven In rows.
 */
async function queryFirstTemplateQueueRow(notionCfg, databaseId, outreachStatusCol) {
  const statusCol = String(outreachStatusCol || "OutReach Status").trim() || "OutReach Status";
  const outFilter = {
    and: [
      { property: "Platform", select: { equals: "Email" } },
      { property: "InNOut", select: { equals: "Out" } },
      {
        or: [
          { property: "Action", select: { equals: "Send Email" } },
          { property: "Action", select: { equals: "Reply Email" } },
        ],
      },
      { property: statusCol, status: { equals: "Success" } },
    ],
  };
  let data = await queryDatabase(notionCfg, databaseId, {
    pageSize: 1,
    filter: outFilter,
    sorts: [{ property: "Completion Time", direction: "descending" }],
  });
  let page = data?.results?.[0];
  if (!page) {
    const inFilter = {
      and: [
        { property: "Platform", select: { equals: "Email" } },
        { property: "InNOut", select: { equals: "In" } },
      ],
    };
    data = await queryDatabase(notionCfg, databaseId, { pageSize: 1, filter: inFilter });
    page = data?.results?.[0];
  }
  return page ? parseQueueRow(page) : null;
}

/**
 * TB Active Receiver: POST JSON webhook → optional contact-cache filter → Notion In row.
 * Headers: optional `X-TB-Receiver-Secret` when `executor.tb_receiver_webhook_secret` is set.
 *
 * @param {object} cfg loadConfig()
 * @param {object} payload parsed JSON body
 * @param {Record<string,string>} reqHeaders lower-case keys
 * @returns {Promise<{ status: number, body: object }>}
 */
async function handleTbActiveReceiverWebhook(cfg, payload, reqHeaders = {}) {
  const secret = String(cfg?.executor?.tbReceiverWebhookSecret || "").trim();
  if (secret) {
    const got = String(
      reqHeaders["x-tb-receiver-secret"] || reqHeaders["x-tb-webhook-secret"] || ""
    ).trim();
    if (got !== secret) {
      return { status: 401, body: { ok: false, error: "unauthorized" } };
    }
  }

  if (!payload || typeof payload !== "object") {
    return { status: 400, body: { ok: false, error: "invalid_payload" } };
  }
  if (Number(payload.schemaVersion) !== 1 || payload.type !== "tb-active-receiver.newMail") {
    return { status: 400, body: { ok: false, error: "schema_mismatch", expected: { schemaVersion: 1, type: "tb-active-receiver.newMail" } } };
  }

  const fc = normalizeEmail(payload.fcAccount);
  const author = extractEmail(payload.author);
  if (!fc || !author) {
    return { status: 400, body: { ok: false, error: "missing_fc_account_or_author" } };
  }

  const cacheMap = readContactCacheMapFresh(cfg);

  const bodyPlain = typeof payload.bodyPlain === "string" ? payload.bodyPlain : "";
  const bodyHtml = typeof payload.bodyHtml === "string" ? payload.bodyHtml : "";
  const replyText = bodyPlain.trim() ? bodyPlain : stripHtmlToPlain(bodyHtml);

  const replyProbe = await computeIsReplyForWebhook(cfg, payload, cacheMap, fc, author, replyText);
  if (!replyProbe.isReply) {
    return {
      status: 200,
      body: { ok: true, skipped: true, reason: "not_reply", is_reply: false, detail: replyProbe.reason },
    };
  }

  const dedupKey = buildInboundDedupKey(fc, {
    headerMessageId: payload.headerMessageId,
    messageId: payload.messageId,
  });
  if (!dedupKey) {
    return { status: 400, body: { ok: false, error: "missing_header_message_id_and_message_id" } };
  }
  if (hasDedupeKey(cfg, dedupKey)) {
    return { status: 200, body: { ok: true, skipped: true, reason: "dedupe" } };
  }

  let entityId = null;
  let matchReason = "unmatched";
  let classification = "Unknown";
  let outboundPageId = "";

  const inReplyTo = String(payload.inReplyTo || "").trim();
  const references = String(payload.references || "").trim();

  const headersToMatch = [];
  if (inReplyTo) {
    const n = normalizeMessageId(inReplyTo);
    if (n) headersToMatch.push(n);
  }
  if (references) {
    for (const r of references.split(/\s+/)) {
      const n = normalizeMessageId(r);
      if (n) headersToMatch.push(n);
    }
  }

  for (const ref of headersToMatch) {
    if (cacheMap.messageMap.has(ref)) {
      const msgInfo = cacheMap.messageMap.get(ref);
      entityId = msgInfo.entityId;
      outboundPageId = msgInfo.outboundPageId;
      matchReason = "header_chain_match";
      classification = "Human Reply In Thread";
      break;
    }
  }

  if (!entityId) {
    const authorDomainMatch = author.match(/@(.+)$/);
    if (authorDomainMatch) {
      const domain = authorDomainMatch[1].toLowerCase();
      if (cacheMap.domainMap.has(domain)) {
        const domainInfo = cacheMap.domainMap.get(domain);
        entityId = domainInfo.entityId;
        matchReason = "same_domain_forward";
        classification = "Human Reply Forwarded";
      }
    }
  }

  if (!entityId) {
    const cacheKey = buildInboundCacheKey(fc, author);
    const exactMatch = cacheMap.byKey.get(cacheKey);
    if (exactMatch) {
      entityId = exactMatch.entityPageId || exactMatch.keyPersonId;
      matchReason = "participant_match";
      classification = "Human Reply Out Of Thread";
    }
  }

  if (!entityId) {
    const unknownMatch = matchUnknownInboundByThreeSignals({
      cfg,
      payload,
      fcAccount: fc,
    });
    if (unknownMatch) {
      entityId = unknownMatch.entityId;
      outboundPageId = unknownMatch.outboundPageId || "";
      matchReason = unknownMatch.matchReason;
      classification = unknownMatch.classification;
    }
  }

  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const databaseId = cfg.notion.databaseId;
  const propNames = cfg.executor?.notionPropertyNames || {};

  const successOutRows = await getCachedSuccessOutRows(cfg);
  const rowCandidates = filterSuccessOutRowsForFcAndAuthor(successOutRows, fc, author);
  const matchedOutForLog =
    replyProbe.matchedOut || findBestMatchingOutRowFromCandidates(rowCandidates, payload.subject || "");
  const templateRow = successOutRows.find((r) => r?.raw) || matchedOutForLog || null;

  let keyPersonId = "";
  const ck = buildInboundCacheKey(fc, author);
  if (cacheMap.byKey.has(ck)) {
    keyPersonId = String(cacheMap.byKey.get(ck).keyPersonId || "").trim();
  }
  if (!keyPersonId && matchedOutForLog?.keyPersonPageId) {
    keyPersonId = String(matchedOutForLog.keyPersonPageId || "").trim();
  }

  /** 仅留「定位要回复的邮件 + 元数据」；正文/主题不必写入 Payload，执行 Reply 时由 TB 原信 + 占位 body 发信。 */
  const interactionPayload = {
    messageId: payload.messageId,
    headerMessageId: payload.headerMessageId ?? null,
    replyToHeaderMessageId: payload.headerMessageId != null ? String(payload.headerMessageId) : "",
    fcAccount: fc,
    from_email: fc,
    to_email: author,
    counterpartyEmail: author,
    is_reply: true,
    is_reply_reason: replyProbe.reason,
    entity_match: {
      entityId: entityId || null,
      matchReason,
      classification,
      outboundPageId: outboundPageId || null,
    },
    source: "tb-active-receiver.webhook",
  };

  const inboundMsg = {
    messageId: payload.messageId,
    headerMessageId: payload.headerMessageId,
    subject: payload.subject || "",
    body: replyText,
    replyText,
    date: payload.receivedAt ? new Date(payload.receivedAt) : new Date(),
    snippet: (replyText || "").slice(0, 240),
    author: payload.author,
    authorEmail: author,
    from_email: author,
    fcAccount: fc,
    to_email: fc,
    entityPageId: entityId ? String(entityId) : "",
    payload: interactionPayload,
  };

  let interactionLogCreated = false;
  let interactionLogError = null;
  if (templateRow) {
    try {
      const createProps = buildInboundCreateProperties(
        matchedOutForLog || templateRow,
        inboundMsg,
        propNames,
        keyPersonId
      );
      await createPage(notionCfg, databaseId, createProps);
      interactionLogCreated = true;
      if (matchedOutForLog?.pageId) {
        await markReplyDone(
          cfg,
          matchedOutForLog,
          `tb_webhook_inbound:${payload.headerMessageId || payload.messageId}`
        );
      }
    } catch (eLog) {
      interactionLogError = eLog?.message ?? String(eLog);
      console.error("[executor][webhook] InteractionLOG createPage failed", interactionLogError);
    }
  } else {
    console.error("[executor][webhook] skip InteractionLOG: no success Outbound template row in Notion");
  }

  const safeReplyText = replyText.slice(0, 1500) + (replyText.length > 1500 ? "..." : "");
  const timestamp = payload.receivedAt ? new Date(payload.receivedAt) : new Date();
  const shanghaiClock = formatShanghaiWallClockForHeading(timestamp);

  const blocks = [
    { object: "block", type: "divider", divider: {} },
    {
      object: "block",
      type: "heading_3",
      heading_3: {
        rich_text: [
          {
            type: "text",
            text: { content: `[${classification}] ${shanghaiClock} (+08 Asia/Shanghai)` },
          },
        ],
      },
    },
    {
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          { type: "text", text: { content: "From: " }, annotations: { bold: true } },
          { type: "text", text: { content: `${payload.author}\n` } },
          { type: "text", text: { content: "To: " }, annotations: { bold: true } },
          { type: "text", text: { content: `${fc}\n` } },
          { type: "text", text: { content: "Subject: " }, annotations: { bold: true } },
          { type: "text", text: { content: `${payload.subject}\n` } },
          { type: "text", text: { content: "Match Reason: " }, annotations: { bold: true, color: "gray" } },
          { type: "text", text: { content: `${matchReason}` }, annotations: { color: "gray" } },
        ],
      },
    },
    {
      object: "block",
      type: "quote",
      quote: {
        rich_text: [{ type: "text", text: { content: safeReplyText || "(No Content)" } }],
      },
    },
  ];

  const lastReplyCol = String(propNames.last_reply_time ?? "Last Reply Time").trim();

  let entityAppendOk = false;
  let lastReplyTimeUpdated = false;

  if (entityId) {
    try {
      await appendBlockChildren(notionCfg, entityId, blocks);
      entityAppendOk = true;
      if (lastReplyCol) {
        try {
          await updatePage(notionCfg, entityId, {
            [lastReplyCol]: notionDateTimeAsiaShanghai(timestamp),
          });
          lastReplyTimeUpdated = true;
        } catch (e2) {
          console.error("[executor][webhook] Last Reply Time property update failed", {
            entityId,
            column: lastReplyCol,
            detail: e2?.message ?? String(e2),
          });
        }
      }
    } catch (e) {
      console.error("[executor][webhook] appendBlockChildren failed", e?.message ?? e);
      return {
        status: 502,
        body: {
          ok: false,
          error: "notion_append_failed",
          detail: e?.message ?? String(e),
          interactionLogCreated,
          interactionLogError,
        },
      };
    }
  }

  if (interactionLogCreated || entityAppendOk) {
    addDedupeKey(cfg, dedupKey);
  }

  if (!interactionLogCreated && !entityAppendOk) {
    return {
      status: 502,
      body: {
        ok: false,
        error: "notion_no_row_written",
        detail: interactionLogError || "no_entity_match_and_interaction_log_not_created",
        is_reply_reason: replyProbe.reason,
      },
    };
  }

  console.error("[executor][webhook] processed", {
    entityId: entityId || null,
    dedupKey,
    classification,
    matchReason,
    is_reply_reason: replyProbe.reason,
    interactionLogCreated,
    entityAppendOk,
    lastReplyTimeUpdated,
  });

  return {
    status: 201,
    body: {
      ok: true,
      is_reply: true,
      is_reply_reason: replyProbe.reason,
      entityId: entityId || "",
      matchReason,
      classification,
      outboundPageId: outboundPageId || "",
      interactionLogCreated,
      interactionLogError: interactionLogError || undefined,
      entityAppendOk,
      lastReplyTimeUpdated,
      lastReplyTimeShanghai: shanghaiClock,
    },
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
  console.error("  init_resolver_cache_on_startup =", !!cfg.executor.initResolverCacheOnStartup);
  console.error("  inbound_poll_interval_ms =", cfg.executor.inboundPollIntervalMs);
  console.error("  max_inbound_checks_per_cycle =", cfg.executor.maxInboundChecksPerCycle);
  if (!cfg.executor.enableOutbound && !cfg.executor.enableInbound) {
    console.error("[executor] both outbound and inbound are disabled; executor loop will stay idle");
  }

  try {
     await initResolverCache(cfg);
  } catch (e) {
     console.error("[executor] initResolverCache failed:", e?.message ?? e);
  }
  try {
    await initOutboundAttributionCache(cfg);
  } catch (e) {
    console.error("[executor] initOutboundAttributionCache failed:", e?.message ?? e);
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

module.exports = { startExecutor, handleTbActiveReceiverWebhook };

