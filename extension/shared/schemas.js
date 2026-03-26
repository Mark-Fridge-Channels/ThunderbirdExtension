/**
 * Bridge V1 payload validation. Actions are camelCase only.
 */

const ACTIONS = new Set(["listAccounts", "sendEmail", "replyEmail", "findMessages", "restoreToInbox"]);

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isString(v) {
  return typeof v === "string";
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validateEnvelope(obj) {
  if (!isObject(obj)) return { ok: false, error: "Envelope must be an object" };
  if (!isNonEmptyString(obj.request_id)) return { ok: false, error: "request_id required" };
  if (!isNonEmptyString(obj.action)) return { ok: false, error: "action required" };
  if (!ACTIONS.has(obj.action)) return { ok: false, error: `Unknown action: ${obj.action} (Bridge V1 camelCase only)` };
  if (!isObject(obj.payload) && obj.payload !== undefined) return { ok: false, error: "payload must be object" };
  return { ok: true, payload: obj.payload || {} };
}

export function validateListAccountsPayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  if (p.includeSubFolders !== undefined && typeof p.includeSubFolders !== "boolean") {
    return { ok: false, error: "includeSubFolders must be boolean" };
  }
  return { ok: true, payload: p };
}

function recipientArraysOk(to, cc, bcc) {
  const norm = (x) => {
    if (x == null) return [];
    if (Array.isArray(x)) return x.every((y) => isString(y));
    return isString(x);
  };
  return norm(to) && norm(cc) && norm(bcc);
}

export function validateSendEmailPayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  if (!recipientArraysOk(p.to, p.cc, p.bcc)) return { ok: false, error: "to, cc, bcc must be strings or string arrays" };
  const to = p.to == null ? [] : Array.isArray(p.to) ? p.to : [p.to];
  const cc = p.cc == null ? [] : Array.isArray(p.cc) ? p.cc : [p.cc];
  const bcc = p.bcc == null ? [] : Array.isArray(p.bcc) ? p.bcc : [p.bcc];
  const hasTo = to.some((s) => isString(s) && s.trim());
  const hasCc = cc.some((s) => isString(s) && s.trim());
  const hasBcc = bcc.some((s) => isString(s) && s.trim());
  if (!hasTo && !hasCc && !hasBcc) {
    return { ok: false, error: "At least one recipient required among to, cc, bcc" };
  }
  if (p.body == null || !isString(p.body) || !p.body.length) {
    return { ok: false, error: "body is required" };
  }
  if (!p.identityId && !p.accountId) {
    return { ok: false, error: "identityId or accountId required" };
  }
  if (p.identityId != null && !isString(p.identityId)) return { ok: false, error: "identityId must be string" };
  if (p.accountId != null && !isString(p.accountId)) return { ok: false, error: "accountId must be string" };
  if (p.bodyFormat != null && p.bodyFormat !== "plain" && p.bodyFormat !== "html") {
    return { ok: false, error: "bodyFormat must be plain | html" };
  }
  if (p.sendMode != null && !["default", "sendNow", "sendLater"].includes(p.sendMode)) {
    return { ok: false, error: "sendMode must be default | sendNow | sendLater" };
  }
  if (p.saveCopyToFolderId !== undefined && p.saveCopyToFolderId !== null && typeof p.saveCopyToFolderId !== "string") {
    return { ok: false, error: "saveCopyToFolderId must be string when provided" };
  }
  if (p.deliveryFormat != null && !["auto", "both", "html", "plaintext"].includes(p.deliveryFormat)) {
    return { ok: false, error: "invalid deliveryFormat" };
  }
  return { ok: true, payload: p };
}

export function validateReplyEmailPayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  if (p.messageId == null || (!Number.isFinite(Number(p.messageId)) && !isNonEmptyString(String(p.messageId)))) {
    return { ok: false, error: "messageId is required" };
  }
  if (p.body == null || !isString(p.body) || !p.body.length) {
    return { ok: false, error: "body is required" };
  }
  if (!p.identityId && !p.accountId) {
    return { ok: false, error: "identityId or accountId required" };
  }
  if (p.identityId != null && !isString(p.identityId)) return { ok: false, error: "identityId must be string" };
  if (p.accountId != null && !isString(p.accountId)) return { ok: false, error: "accountId must be string" };
  if (p.replyType != null && !["replyToSender", "replyToAll", "replyToList"].includes(p.replyType)) {
    return { ok: false, error: "replyType invalid" };
  }
  if (p.bodyFormat != null && p.bodyFormat !== "plain" && p.bodyFormat !== "html") {
    return { ok: false, error: "bodyFormat must be plain | html" };
  }
  if (p.sendMode != null && !["default", "sendNow", "sendLater"].includes(p.sendMode)) {
    return { ok: false, error: "sendMode invalid" };
  }
  if (p.saveCopyToFolderId !== undefined && p.saveCopyToFolderId !== null && typeof p.saveCopyToFolderId !== "string") {
    return { ok: false, error: "saveCopyToFolderId must be string when provided" };
  }
  return { ok: true, payload: p };
}

export function validateFindMessagesPayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  const has =
    p.accountId != null ||
    p.folderId != null ||
    (p.author && isString(p.author)) ||
    (p.recipients && isString(p.recipients)) ||
    (p.subject && isString(p.subject)) ||
    (p.body && isString(p.body)) ||
    (p.fullText && isString(p.fullText)) ||
    (p.headerMessageId && isString(p.headerMessageId)) ||
    p.fromDate != null ||
    p.toDate != null ||
    p.read !== undefined ||
    p.flagged !== undefined ||
    p.junk !== undefined ||
    p.fromMe !== undefined ||
    p.toMe !== undefined ||
    p.attachment !== undefined;
  if (!has) {
    return { ok: false, error: "At least one search filter is required" };
  }
  if (p.includeSubFolders !== undefined && typeof p.includeSubFolders !== "boolean") {
    return { ok: false, error: "includeSubFolders must be boolean" };
  }
  if (p.limit != null && typeof p.limit !== "number" && typeof p.limit !== "string") {
    return { ok: false, error: "limit must be number" };
  }
  return { ok: true, payload: p };
}

export function validateRestoreToInboxPayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  if (p.messageId == null || (!Number.isFinite(Number(p.messageId)) && !isNonEmptyString(String(p.messageId)))) {
    return { ok: false, error: "messageId is required" };
  }
  if (!isNonEmptyString(p.inboxFolderId)) return { ok: false, error: "inboxFolderId is required" };
  if (p.clearJunk !== undefined && typeof p.clearJunk !== "boolean") {
    return { ok: false, error: "clearJunk must be boolean" };
  }
  if (p.treatAsUserAction !== undefined && typeof p.treatAsUserAction !== "boolean") {
    return { ok: false, error: "treatAsUserAction must be boolean" };
  }
  return { ok: true, payload: p };
}

export function getValidator(action) {
  switch (action) {
    case "listAccounts":
      return validateListAccountsPayload;
    case "sendEmail":
      return validateSendEmailPayload;
    case "replyEmail":
      return validateReplyEmailPayload;
    case "findMessages":
      return validateFindMessagesPayload;
    case "restoreToInbox":
      return validateRestoreToInboxPayload;
    default:
      return () => ({ ok: false, error: "Unknown action" });
  }
}
