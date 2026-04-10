/**
 * Bridge V1: replyEmail — compose.beginReply + compose.sendMessage.
 * messageId is Thunderbird internal id (numeric), not RFC Message-ID header.
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

const REPLY_TYPES = new Set(["replyToSender", "replyToAll", "replyToList"]);

export async function handleReplyEmail({ payload }) {
  const mid = payload.messageId;
  if (mid == null || mid === "" || !Number.isFinite(Number(mid))) {
    return { success: false, error: makeError(CODES.VALIDATION, "messageId is required (numeric Thunderbird id)") };
  }
  const messageId = Number(mid);
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

  const replyType = payload.replyType ?? "replyToSender";
  if (!REPLY_TYPES.has(replyType)) {
    return { success: false, error: makeError(CODES.VALIDATION, "replyType must be replyToSender | replyToAll | replyToList") };
  }

  const bodyFormat = payload.bodyFormat === "html" ? "html" : "plain";
  const details = {
    identityId,
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
    const tab = await browser.compose.beginReply(messageId, replyType, details);
    if (!tab?.id) {
      return { success: false, error: makeError(CODES.API_ERROR, "compose.beginReply did not return a tab") };
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
      // Thunderbird may complete SMTP send successfully but still omit headerMessageId.
      // Treat as success to avoid false-negative writeback; keep warning for observability.
      normalized.warnings = ["headerMessageId_missing_after_send"];
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
    try {
      if (composeTabId != null) cancelAfterSendWait(composeTabId);
    } catch (_) {
      // ignore
    }
  }
}
