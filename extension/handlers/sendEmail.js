/**
 * Bridge V1: sendEmail — compose.beginNew + compose.sendMessage.
 */

import { normalizeSendResult } from "../shared/bridgeNormalize.js";
import { makeError, CODES } from "../shared/errors.js";
import { waitForAfterSend, cancelAfterSendWait } from "../shared/composeAfterSend.js";

const browser = globalThis.browser ?? globalThis.messenger;
const AFTER_SEND_TIMEOUT_MS = 90000;

async function resolveIdentity(accountId, identityId) {
  if (identityId) return identityId;
  if (!accountId) return null;
  const def = await browser.identities.getDefault(accountId);
  return def?.id ?? null;
}

function asRecipientArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s.length > 0);
  return String(v).trim() ? [String(v).trim()] : [];
}

export async function handleSendEmail({ payload }) {
  const to = asRecipientArray(payload.to);
  const cc = asRecipientArray(payload.cc);
  const bcc = asRecipientArray(payload.bcc);
  if (!to.length && !cc.length && !bcc.length) {
    return { success: false, error: makeError(CODES.VALIDATION, "At least one of to, cc, bcc must be non-empty") };
  }
  if (payload.body == null || String(payload.body).length === 0) {
    return { success: false, error: makeError(CODES.VALIDATION, "body is required") };
  }

  const identityId = await resolveIdentity(payload.accountId, payload.identityId);
  if (!identityId) {
    return {
      success: false,
      error: makeError(CODES.VALIDATION, "identityId or resolvable accountId required"),
    };
  }

  const bodyFormat = payload.bodyFormat === "html" ? "html" : "plain";
  const details = {
    identityId,
    to,
    cc,
    bcc,
    subject: payload.subject ?? "",
    attachVCard: payload.attachVCard === true,
  };
  if (bodyFormat === "html") {
    details.isPlainText = false;
    details.body = String(payload.body);
    if (payload.deliveryFormat) details.deliveryFormat = payload.deliveryFormat;
  } else {
    details.isPlainText = true;
    details.plainTextBody = String(payload.body);
  }
  if (payload.saveCopyToFolderId !== undefined) {
    details.overrideDefaultFccFolderId = payload.saveCopyToFolderId;
  }

  const sendMode = payload.sendMode ?? "sendNow";
  if (!["default", "sendNow", "sendLater"].includes(sendMode)) {
    return { success: false, error: makeError(CODES.VALIDATION, "sendMode must be default | sendNow | sendLater") };
  }

  let composeTabId = null;
  try {
    const tab = await browser.compose.beginNew(undefined, details);
    if (!tab?.id) {
      return { success: false, error: makeError(CODES.API_ERROR, "compose.beginNew did not return a tab") };
    }
    composeTabId = tab.id;
    const afterSendPromise = waitForAfterSend(composeTabId, AFTER_SEND_TIMEOUT_MS);
    const result = await browser.compose.sendMessage(composeTabId, { mode: sendMode });
    const afterSend = await afterSendPromise;
    if (afterSend?.error) {
      return {
        success: false,
        error: makeError(CODES.API_ERROR, afterSend.error, {
          phase: "onAfterSend",
          mode: afterSend?.mode ?? sendMode,
          sendInfo: afterSend,
          sendMessageResult: normalizeSendResult(result),
        }),
      };
    }
    const normalized = normalizeSendResult(afterSend?.mode ? afterSend : result);
    if (normalized.mode !== "sendLater" && !normalized.headerMessageId) {
      return {
        success: false,
        error: makeError(CODES.API_ERROR, "Missing headerMessageId after send", {
          phase: "onAfterSend",
          mode: normalized.mode,
          sendInfo: afterSend,
          sendMessageResult: normalizeSendResult(result),
        }),
      };
    }
    return { success: true, result: normalized };
  } catch (e) {
    if (e?.message && /compose\.onAfterSend timeout/i.test(String(e.message))) {
      return {
        success: false,
        error: makeError(CODES.TIMEOUT, e.message),
      };
    }
    return {
      success: false,
      error: makeError(CODES.API_ERROR, e?.message ?? String(e)),
    };
  } finally {
    // Avoid dangling waiters when sendMessage throws before onAfterSend resolves.
    // Safe no-op when no pending waiter exists.
    try {
      if (composeTabId != null) cancelAfterSendWait(composeTabId);
    } catch (_) {
      // ignore
    }
  }
}
