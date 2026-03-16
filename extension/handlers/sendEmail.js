/**
 * send_email: use context or payload identity, send mail; support dry_run and idempotency_key.
 */

import * as state from "../background/state.js";
import { makeError, CODES } from "../shared/errors.js";
import { createAndSend } from "../adapters/composeAdapter.js";
import { auditLog } from "../shared/logger.js";

const browser = globalThis.browser ?? globalThis.messenger;
const IDEMPOTENCY_KEY = "send_email_idempotency";

export async function handleSendEmail({
  requestId,
  payload,
  context,
  idempotencyKey,
}) {
  let identityId = payload.identityId ?? context.identityId;
  const accountId = payload.accountId ?? context.accountId;
  if (!identityId && accountId) {
    const def = await browser.identities.getDefault(accountId);
    identityId = def?.id ?? null;
  }
  if (!identityId) {
    return {
      success: false,
      error: makeError(
        CODES.CONTEXT_NOT_SET,
        "identityId or accountId required; set context with switch_account_context first"
      ),
    };
  }

  if (idempotencyKey) {
    const stored = await browser.storage.local.get(IDEMPOTENCY_KEY);
    const map = stored[IDEMPOTENCY_KEY] || {};
    if (map[idempotencyKey]) {
      return {
        success: true,
        result: {
          ...map[idempotencyKey],
          idempotent: true,
          stableIdentifiers: map[idempotencyKey].stableIdentifiers,
        },
      };
    }
  }

  const to = Array.isArray(payload.to) ? payload.to : [payload.to].filter(Boolean);
  const cc = Array.isArray(payload.cc) ? payload.cc : (payload.cc ? [payload.cc] : []);
  const bcc = Array.isArray(payload.bcc) ? payload.bcc : (payload.bcc ? [payload.bcc] : []);

  const details = {
    identityId,
    to,
    cc,
    bcc,
    subject: payload.subject ?? "",
    body: payload.body ?? undefined,
    plainTextBody: payload.plainTextBody ?? undefined,
    isPlainText: payload.isPlainText ?? true,
    attachments: payload.attachments?.length ? payload.attachments : undefined,
  };

  try {
    const sendResult = await createAndSend(details, { dry_run: payload.dry_run === true });
    if (payload.dry_run) {
      await auditLog("send_email", requestId, true, { dry_run: true });
      return {
        success: true,
        result: {
          dry_run: true,
          stableIdentifiers: {},
          details: sendResult,
        },
      };
    }
    const stableIdentifiers = {
      headerMessageId: sendResult.headerMessageId ?? null,
      identityId,
    };
    if (idempotencyKey) {
      const stored = await browser.storage.local.get(IDEMPOTENCY_KEY);
      const map = stored[IDEMPOTENCY_KEY] || {};
      map[idempotencyKey] = {
        headerMessageId: sendResult.headerMessageId,
        stableIdentifiers,
        details: sendResult,
      };
      await browser.storage.local.set({ [IDEMPOTENCY_KEY]: map });
    }
    await auditLog("send_email", requestId, true, {
      headerMessageId: sendResult.headerMessageId,
      identityId,
    });
    return {
      success: true,
      result: {
        headerMessageId: sendResult.headerMessageId,
        mode: sendResult.mode,
        stableIdentifiers,
        details: sendResult,
      },
    };
  } catch (e) {
    await auditLog("send_email", requestId, false, { error: e?.message });
    throw e;
  }
}
