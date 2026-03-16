/**
 * forward_message: resolve message, open forward compose, set recipients/body, send.
 */

import * as state from "../background/state.js";
import { getMessage, findFolderId, queryMessages } from "../adapters/messagesAdapter.js";
import { forwardMessage } from "../adapters/composeAdapter.js";
import { makeError, CODES } from "../shared/errors.js";

const browser = globalThis.browser ?? globalThis.messenger;

export async function handleForwardMessage({ requestId, payload, context }) {
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
  if (!messageId) {
    return {
      success: false,
      error: makeError(CODES.NOT_FOUND, "Message not found for forward", { payload }),
    };
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

  const to = Array.isArray(payload.to) ? payload.to : (payload.recipients ? (Array.isArray(payload.recipients) ? payload.recipients : [payload.recipients]) : [payload.to]);
  const forwardMode = payload.forward_mode === "inline" ? "forwardInline" : "forwardAsAttachment";
  const details = {
    identityId,
    to,
    cc: payload.cc ?? [],
    bcc: payload.bcc ?? [],
    subject: payload.subject,
    body: payload.body,
    plainTextBody: payload.plainTextBody,
    isPlainText: payload.isPlainText ?? false,
    extraBody: payload.extraBody,
    forwardInline: forwardMode === "forwardInline",
  };

  try {
    const result = await forwardMessage(messageId, details, { dry_run: payload.dry_run === true });
    if (payload.dry_run) {
      return {
        success: true,
        result: {
          dry_run: true,
          messageId,
          stableIdentifiers: { accountId, messageId },
          details: result,
        },
      };
    }
    const msg = await getMessage(messageId);
    return {
      success: true,
      result: {
        messageId,
        headerMessageId: msg?.headerMessageId,
        forwardResult: result,
        stableIdentifiers: {
          accountId,
          sourceMessageId: messageId,
          sourceHeaderMessageId: msg?.headerMessageId,
          sentHeaderMessageId: result.headerMessageId,
        },
      },
    };
  } catch (e) {
    return {
      success: false,
      error: makeError(CODES.API_ERROR, e?.message ?? String(e)),
    };
  }
}
