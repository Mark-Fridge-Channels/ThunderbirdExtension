/**
 * Payload validation helpers. All external input must pass schema checks.
 * We do minimal runtime checks (no external JSON Schema lib) to avoid dependencies.
 */

const ACTIONS = new Set([
  "switch_account_context",
  "send_email",
  "open_message",
  "star_message",
  "add_contact",
  "forward_message",
  "reply_message",
  "resolve_message",
]);

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isString(v) {
  return typeof v === "string";
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isArrayOfStrings(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export function validateEnvelope(obj) {
  if (!isObject(obj)) return { ok: false, error: "Envelope must be an object" };
  if (!isNonEmptyString(obj.request_id)) return { ok: false, error: "request_id required" };
  if (!isNonEmptyString(obj.action)) return { ok: false, error: "action required" };
  if (!ACTIONS.has(obj.action)) return { ok: false, error: `Unknown action: ${obj.action}` };
  if (!isObject(obj.payload) && obj.payload !== undefined) return { ok: false, error: "payload must be object" };
  return { ok: true, payload: obj.payload || {} };
}

export function validateSwitchAccountPayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  const accountSelector = p.accountId ?? p.email ?? p.identityId;
  if (accountSelector === undefined || accountSelector === null) {
    return { ok: false, error: "One of accountId, email, or identityId required" };
  }
  if (!isString(accountSelector)) return { ok: false, error: "account selector must be string" };
  return { ok: true, payload: p };
}

export function validateSendEmailPayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  // identityId/accountId optional: handler may use context from switch_account_context
  const to = p.to;
  if (to === undefined || (Array.isArray(to) && to.length === 0) || (isString(to) && !to.trim()))
    return { ok: false, error: "to required" };
  if (p.dry_run && typeof p.dry_run !== "boolean") return { ok: false, error: "dry_run must be boolean" };
  return { ok: true, payload: p };
}

export function validateOpenMessagePayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  if (!isNonEmptyString(p.accountId)) return { ok: false, error: "accountId required" };
  const hasQuery =
    isNonEmptyString(p.headerMessageId) ||
    isNonEmptyString(p.subject) ||
    isNonEmptyString(p.from) ||
    isNonEmptyString(p.to) ||
    (p.fromDate && (p.toDate || true));
  if (!hasQuery && !isNonEmptyString(p.folderPath))
    return { ok: false, error: "Need folderPath or query (headerMessageId/subject/from/to/date)" };
  return { ok: true, payload: p };
}

export function validateStarMessagePayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  if (!isNonEmptyString(p.accountId)) return { ok: false, error: "accountId required" };
  const hasTarget =
    isNonEmptyString(p.headerMessageId) ||
    isNonEmptyString(p.messageId) ||
    (isNonEmptyString(p.folderPath) && isNonEmptyString(p.subject));
  if (!hasTarget) return { ok: false, error: "Need messageId, headerMessageId, or folderPath+subject" };
  if (p.starred !== undefined && typeof p.starred !== "boolean")
    return { ok: false, error: "starred must be boolean" };
  return { ok: true, payload: p };
}

export function validateAddContactPayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  if (!isNonEmptyString(p.email)) return { ok: false, error: "email required" };
  const parentId = p.addressBookId ?? p.parentId;
  if (!isNonEmptyString(parentId)) return { ok: false, error: "addressBookId or parentId required" };
  return { ok: true, payload: p };
}

export function validateForwardMessagePayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  if (!isNonEmptyString(p.accountId)) return { ok: false, error: "accountId required" };
  const hasTarget =
    isNonEmptyString(p.messageId) || isNonEmptyString(p.headerMessageId);
  if (!hasTarget) return { ok: false, error: "messageId or headerMessageId required" };
  const to = p.to ?? p.recipients;
  if (
    (Array.isArray(to) && to.length === 0) ||
    (isString(to) && !to.trim())
  )
    return { ok: false, error: "to or recipients required" };
  return { ok: true, payload: p };
}

export function validateReplyMessagePayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  const hasTarget =
    isNonEmptyString(p.messageId) || isNonEmptyString(p.headerMessageId) ||
    (isNonEmptyString(p.folderPath) && isNonEmptyString(p.subject));
  if (!hasTarget) return { ok: false, error: "messageId, headerMessageId, or folderPath+subject required" };
  return { ok: true, payload: p };
}

export function validateResolveMessagePayload(p) {
  if (!isObject(p)) return { ok: false, error: "payload must be object" };
  if (!isNonEmptyString(p.accountId)) return { ok: false, error: "accountId required" };
  const hasQuery =
    isNonEmptyString(p.headerMessageId) ||
    isNonEmptyString(p.subject) ||
    isNonEmptyString(p.from) ||
    isNonEmptyString(p.to) ||
    (p.fromDate && (p.toDate || true));
  if (!hasQuery && !isNonEmptyString(p.folderPath))
    return { ok: false, error: "Need folderPath or query (headerMessageId/subject/from/to/date)" };
  return { ok: true, payload: p };
}

export function getValidator(action) {
  switch (action) {
    case "switch_account_context":
      return validateSwitchAccountPayload;
    case "send_email":
      return validateSendEmailPayload;
    case "open_message":
      return validateOpenMessagePayload;
    case "star_message":
      return validateStarMessagePayload;
    case "add_contact":
      return validateAddContactPayload;
    case "forward_message":
      return validateForwardMessagePayload;
    case "reply_message":
      return validateReplyMessagePayload;
    case "resolve_message":
      return validateResolveMessagePayload;
    default:
      return () => ({ ok: false, error: "Unknown action" });
  }
}
