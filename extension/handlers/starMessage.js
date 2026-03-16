/**
 * star_message: set/clear flagged (starred); return previous and new state.
 */

import { getMessage, updateMessage, resolveMessageId, findFolderId, queryMessages, toStableRef } from "../adapters/messagesAdapter.js";
import { makeError, CODES } from "../shared/errors.js";

export async function handleStarMessage({ payload, context }) {
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
      error: makeError(CODES.NOT_FOUND, "Message not found", { payload }),
    };
  }

  const previous = await getMessage(messageId);
  const previousFlagged = previous?.flagged ?? false;
  const targetFlagged = payload.starred !== undefined ? payload.starred : true;

  if (previousFlagged === targetFlagged) {
    const folderPath = payload.folderPath ?? previous?.folderPath ?? "";
    return {
      success: true,
      result: {
        messageId,
        stableIdentifiers: toStableRef(accountId, folderPath, previous),
        previousState: { starred: previousFlagged },
        newState: { starred: targetFlagged },
        idempotent: true,
      },
    };
  }

  await updateMessage(messageId, { flagged: targetFlagged });
  const updated = await getMessage(messageId);
  const folderPath = payload.folderPath ?? updated?.folderPath ?? "";
  return {
    success: true,
    result: {
      messageId,
      stableIdentifiers: toStableRef(accountId, folderPath, updated),
      previousState: { starred: previousFlagged },
      newState: { starred: updated?.flagged ?? targetFlagged },
    },
  };
}
