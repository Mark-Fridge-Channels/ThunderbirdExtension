/**
 * reply_message: resolve message by messageId/headerMessageId, open reply compose, set body, send.
 * Supports idempotency_key: same key returns cached result without sending again.
 */

import * as state from "../background/state.js";
import { getMessage, findFolderId, queryMessages, resolveMessageId } from "../adapters/messagesAdapter.js";
import { replyToMessage } from "../adapters/composeAdapter.js";
import { makeError, CODES } from "../shared/errors.js";

const browser = globalThis.browser ?? globalThis.messenger;
const IDEMPOTENCY_KEY = "reply_message_idempotency";

export async function handleReplyMessage({ requestId, payload, context, idempotencyKey }) {
  const accountId = payload.accountId ?? context.accountId;
  if (!accountId) {
    return {
      success: false,
      error: makeError(CODES.CONTEXT_NOT_SET, "accountId required"),
    };
  }

  let messageId = payload.messageId;
  if (!messageId && payload.headerMessageId) {
    const folderPath = payload.folderPath ?? "INBOX";
    const folderId = await findFolderId(accountId, folderPath);
    if (folderId) {
      const list = await queryMessages({ folderId, headerMessageId: payload.headerMessageId });
      messageId = list.length ? list[0].id : null;
    }
  }
  if (!messageId && payload.folderPath && payload.subject) {
    messageId = await resolveMessageId(accountId, payload.folderPath, { subject: payload.subject });
  }
  if (!messageId) {
    return {
      success: false,
      error: makeError(CODES.NOT_FOUND, "Message not found for reply", { payload }),
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

  let identityId = payload.identityId ?? context.identityId;
  if (!identityId) {
    const def = await browser.identities.getDefault(accountId);
    identityId = def?.id ?? null;
  }
  if (!identityId) {
    return {
      success: false,
      error: makeError(CODES.CONTEXT_NOT_SET, "identityId or default identity required"),
    };
  }

  const body = payload.plainTextBody ?? payload.body ?? "";
  const details = {
    identityId,
    plainTextBody: body,
    isPlainText: payload.isPlainText ?? true,
    replyType: payload.replyType ?? "replyToSender",
  };

  try {
    const result = await replyToMessage(messageId, details, { dry_run: payload.dry_run === true });
    if (payload.dry_run) {
      return {
        success: true,
        result: {
          dry_run: true,
          messageId,
          details: result,
        },
      };
    }
    const msg = await getMessage(messageId);
    const stableIdentifiers = {
      accountId,
      sourceMessageId: messageId,
      sourceHeaderMessageId: msg?.headerMessageId,
      sentHeaderMessageId: result.headerMessageId,
    };
    const replyResult = {
      messageId,
      headerMessageId: msg?.headerMessageId,
      replyResult: result,
      stableIdentifiers,
    };
    if (idempotencyKey) {
      const stored = await browser.storage.local.get(IDEMPOTENCY_KEY);
      const map = stored[IDEMPOTENCY_KEY] || {};
      map[idempotencyKey] = replyResult;
      await browser.storage.local.set({ [IDEMPOTENCY_KEY]: map });
    }
    return { success: true, result: replyResult };
  } catch (e) {
    return {
      success: false,
      error: makeError(CODES.API_ERROR, e?.message ?? String(e)),
    };
  }
}
