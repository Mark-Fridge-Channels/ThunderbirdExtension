/**
 * Bridge V1: replyEmail — compose.beginReply + compose.sendMessage.
 * messageId is Thunderbird internal id (numeric), not RFC Message-ID header.
 */

import { normalizeSendResult } from "../shared/bridgeNormalize.js";
import { makeError, CODES } from "../shared/errors.js";
import { waitForAfterSend, cancelAfterSendWait } from "../shared/composeAfterSend.js";
import {
  computeSendFingerprint,
  findRecentDuplicate,
  recordSend,
  DEDUP_WINDOW_MS,
} from "../shared/sendDedupe.js";

const browser = globalThis.browser ?? globalThis.messenger;
const AFTER_SEND_TIMEOUT_MS = 90000;

async function resolveIdentity(accountId, identityId) {
  if (identityId) return identityId;
  if (!accountId) return null;
  const def = await browser.identities.getDefault(accountId);
  return def?.id ?? null;
}

async function resolveFromEmail(identityId) {
  try {
    const idn = await browser.identities.get(identityId);
    return idn?.email ?? "";
  } catch (_) {
    return "";
  }
}

function composeRecipientsToArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  const s = String(v).trim();
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

async function closeComposeTabSafely(tabId) {
  try {
    await browser.tabs.remove(tabId);
  } catch (_) {
    // Tab may already be gone (e.g. after sendMessage) — ignore.
  }
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
  const fromEmail = await resolveFromEmail(identityId);
  let fingerprint = "";
  let dedupTo = [];
  try {
    const tab = await browser.compose.beginReply(messageId, replyType, details);
    if (!tab?.id) {
      return { success: false, error: makeError(CODES.API_ERROR, "compose.beginReply did not return a tab") };
    }
    composeTabId = tab.id;

    // Recipients and final subject are filled in by Thunderbird based on the
    // original message; read them back before sending so the dedup fingerprint
    // reflects the *actual* outgoing envelope.
    let actualTo = [];
    let actualCc = [];
    let actualBcc = [];
    let actualSubject = "";
    try {
      const cd = await browser.compose.getComposeDetails(composeTabId);
      actualTo = composeRecipientsToArray(cd?.to);
      actualCc = composeRecipientsToArray(cd?.cc);
      actualBcc = composeRecipientsToArray(cd?.bcc);
      actualSubject = String(cd?.subject ?? "");
    } catch (_) {
      // If getComposeDetails fails, fall back to empty recipient arrays so the
      // fingerprint still matches a payload.body-only duplicate.
    }
    fingerprint = await computeSendFingerprint({
      from: fromEmail,
      to: actualTo,
      cc: actualCc,
      bcc: actualBcc,
      subject: actualSubject,
      body: String(payload.body),
    });
    dedupTo = actualTo;
    const dup = await findRecentDuplicate(fingerprint);
    if (dup) {
      await closeComposeTabSafely(composeTabId);
      composeTabId = null;
      return {
        success: false,
        error: makeError(
          CODES.DUPLICATE,
          "duplicate_recent_send: identical (from, to, cc, bcc, subject, body) was already sent within the dedup window",
          {
            fingerprint,
            previousSentAt: new Date(dup.prevAt).toISOString(),
            windowMs: DEDUP_WINDOW_MS,
          }
        ),
      };
    }

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
    if (fingerprint) await recordSend(fingerprint, { from: fromEmail, to: dedupTo });
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
