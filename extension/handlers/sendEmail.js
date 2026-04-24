/**
 * Bridge V1: sendEmail — compose.beginNew + compose.sendMessage.
 */

import { normalizeSendResult } from "../shared/bridgeNormalize.js";
import { makeError, CODES } from "../shared/errors.js";
import { waitForAfterSend, cancelAfterSendWait } from "../shared/composeAfterSend.js";
import { closeComposeTabSafely } from "../shared/composeTabUtils.js";
import { reconcileSentAfterComposeTimeout } from "../shared/sentReconcile.js";
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

  const fromEmail = await resolveFromEmail(identityId);
  const fingerprint = await computeSendFingerprint({
    from: fromEmail,
    to,
    cc,
    bcc,
    subject: payload.subject ?? "",
    body: String(payload.body),
  });
  const dup = await findRecentDuplicate(fingerprint);
  if (dup) {
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

  let composeTabId = null;
  let openedAtMs = 0;
  const reconcileEnvelope = {
    to,
    cc,
    bcc,
    subject: payload.subject ?? "",
  };
  try {
    const tab = await browser.compose.beginNew(undefined, details);
    if (!tab?.id) {
      return { success: false, error: makeError(CODES.API_ERROR, "compose.beginNew did not return a tab") };
    }
    composeTabId = tab.id;
    openedAtMs = Date.now();
    const afterSendPromise = waitForAfterSend(composeTabId, AFTER_SEND_TIMEOUT_MS);
    const result = await browser.compose.sendMessage(composeTabId, { mode: sendMode });
    const afterSend = await afterSendPromise;
    const normalized = normalizeSendResult(afterSend?.mode ? afterSend : result);
    if (afterSend?.error) {
      // If headerMessageId was obtained (from sendMessage result or afterSend),
      // treat as a warning instead of a hard failure — TB sometimes fills error
      // for cosmetic reasons (e.g. "Missing headerMessageId") even after success.
      if (normalized.headerMessageId) {
        normalized.warnings = (normalized.warnings || []).concat([
          `afterSend_error_downgraded: ${afterSend.error}`,
        ]);
      } else {
        if (composeTabId != null) {
          cancelAfterSendWait(composeTabId);
          await closeComposeTabSafely(composeTabId);
          composeTabId = null;
        }
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
    }
    if (normalized.mode !== "sendLater" && !normalized.headerMessageId) {
      // Thunderbird may complete SMTP send successfully but still omit headerMessageId.
      // Treat as success to avoid false-negative writeback; keep warning for observability.
      normalized.warnings = ["headerMessageId_missing_after_send"];
    }
    await recordSend(fingerprint, { from: fromEmail, to });
    return { success: true, result: normalized };
  } catch (e) {
    const isComposeWaitTimeout = e?.message && /compose\.onAfterSend timeout/i.test(String(e.message));
    if (composeTabId != null) {
      cancelAfterSendWait(composeTabId);
      await closeComposeTabSafely(composeTabId);
      composeTabId = null;
    }
    if (isComposeWaitTimeout) {
      const reconciled = await reconcileSentAfterComposeTimeout({
        accountId: payload.accountId ?? null,
        identityId,
        envelope: reconcileEnvelope,
        openedAtMs,
      });
      if (reconciled) {
        await recordSend(fingerprint, { from: fromEmail, to });
        return {
          success: true,
          result: reconciled,
          warnings: ["send_outcome_from_sent_folder_after_compose_timeout"],
        };
      }
      return {
        success: false,
        error: makeError(CODES.TIMEOUT, e.message, { sentReconcile: "no_matching_message_in_sent" }),
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
