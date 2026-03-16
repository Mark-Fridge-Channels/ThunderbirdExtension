/**
 * open_message: resolve message by query (folder + headerMessageId/subject/from/date), then open in tab/window.
 */

import { queryMessages, toStableRef, findFolderId } from "../adapters/messagesAdapter.js";
import { openMessageByMessageId, openMessageByHeaderMessageId } from "../adapters/tabsAdapter.js";

const browser = globalThis.browser ?? globalThis.messenger;
import { makeError, CODES } from "../shared/errors.js";

export async function handleOpenMessage({ payload, context }) {
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
      error: makeError(CODES.NOT_FOUND, "No message matching query", { payload: { folderPath, headerMessageId: payload.headerMessageId } }),
    };
  }

  const openMode = payload.open_mode ?? "tab";
  const location = openMode === "window" ? "window" : "tab";

  let tab;
  if (payload.useHeaderMessageId) {
    const header = await browser.messages.get(messageId);
    tab = await openMessageByHeaderMessageId(header?.headerMessageId ?? payload.headerMessageId, location);
  } else {
    tab = await openMessageByMessageId(messageId, location);
  }

  const header = await browser.messages.get(messageId);
  const stableRef = toStableRef(accountId, folderPath, header);
  const sideEffectRead = "Opening a message may mark it as read depending on Thunderbird settings.";
  return {
    success: true,
    result: {
      tabId: tab?.id,
      windowId: tab?.windowId,
      messageId,
      stableIdentifiers: stableRef,
      details: { open_mode: openMode, sideEffectRead },
    },
  };
}
