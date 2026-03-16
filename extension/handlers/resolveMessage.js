/**
 * resolve_message: resolve one message by query (same as open_message), return messageId and headerMessageId without opening.
 * Use for multi-round flows when you only need the reference for reply/star.
 */

import { queryMessages, findFolderId, getMessage } from "../adapters/messagesAdapter.js";
import { makeError, CODES } from "../shared/errors.js";

export async function handleResolveMessage({ payload, context }) {
  const accountId = payload.accountId ?? context.accountId;
  if (!accountId) {
    return {
      success: false,
      error: makeError(CODES.CONTEXT_NOT_SET, "accountId required"),
    };
  }

  const folderPath = payload.folderPath ?? payload.folderId ?? "INBOX";
  const folderId = await findFolderId(accountId, folderPath);
  if (!folderId) {
    return {
      success: false,
      error: makeError(CODES.NOT_FOUND, "Folder not found", { accountId, folderPath }),
    };
  }

  let messageId = payload.messageId;
  if (!messageId && payload.headerMessageId) {
    const list = await queryMessages({ folderId, headerMessageId: payload.headerMessageId });
    messageId = list.length ? list[0].id : null;
  }
  if (!messageId && (payload.subject || payload.from || payload.to)) {
    const opts = { folderId };
    if (payload.subject) opts.subject = payload.subject;
    if (payload.from) opts.author = payload.from;
    if (payload.to) opts.recipients = payload.to;
    if (payload.fromDate) opts.fromDate = new Date(payload.fromDate);
    if (payload.toDate) opts.toDate = new Date(payload.toDate);
    const list = await queryMessages(opts);
    messageId = list.length ? list[0].id : null;
  }
  if (!messageId) {
    return {
      success: false,
      error: makeError(CODES.NOT_FOUND, "No message matching query", { payload: { folderPath } }),
    };
  }

  const msg = await getMessage(messageId);
  const headerMessageId = msg?.headerMessageId ?? null;
  const resolvedFolderPath = payload.folderPath ?? msg?.folderPath ?? folderPath;

  return {
    success: true,
    result: {
      messageId,
      headerMessageId,
      accountId,
      folderPath: resolvedFolderPath,
      stableIdentifiers: { accountId, folderPath: resolvedFolderPath, headerMessageId },
    },
  };
}
