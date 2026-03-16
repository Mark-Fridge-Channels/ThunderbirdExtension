/**
 * Standardized errors for all handlers. Every handler must return
 * { success, result?, error? } with error shape { code, message, details? }.
 */

export const CODES = {
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  DUPLICATE: "DUPLICATE",
  IDEMPOTENT_SKIP: "IDEMPOTENT_SKIP",
  API_ERROR: "API_ERROR",
  CONTEXT_NOT_SET: "CONTEXT_NOT_SET",
  TIMEOUT: "TIMEOUT",
  UNKNOWN: "UNKNOWN",
};

export function makeError(code, message, details = null) {
  return { code, message, details };
}

export function makeResponse(requestId, success, result = null, error = null) {
  const out = { request_id: requestId, success };
  if (success) out.result = result;
  else out.error = error;
  return out;
}

export function wrapApiError(e, requestId) {
  const message = e?.message ?? String(e);
  const code = e?.code ?? CODES.API_ERROR;
  return makeResponse(requestId, false, null, makeError(code, message, undefined));
}
