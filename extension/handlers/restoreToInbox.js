/**
 * Bridge V1: restoreToInbox — messages.get, optional junk clear, messages.move.
 */

import { makeError, CODES } from "../shared/errors.js";

const browser = globalThis.browser ?? globalThis.messenger;

export async function handleRestoreToInbox({ payload }) {
  const mid = payload.messageId;
  if (mid == null || mid === "" || !Number.isFinite(Number(mid))) {
    return { success: false, error: makeError(CODES.VALIDATION, "messageId is required (numeric Thunderbird id)") };
  }
  const messageId = Number(mid);
  if (!payload.inboxFolderId || typeof payload.inboxFolderId !== "string" || !payload.inboxFolderId.trim()) {
    return { success: false, error: makeError(CODES.VALIDATION, "inboxFolderId is required") };
  }
  const inboxFolderId = payload.inboxFolderId.trim();
  const clearJunk = payload.clearJunk !== false;
  const treatAsUserAction = payload.treatAsUserAction !== false;

  try {
    const original = await browser.messages.get(messageId);
    if (!original) {
      return { success: false, error: makeError(CODES.NOT_FOUND, "Message not found") };
    }

    if (clearJunk && original.junk === true) {
      await browser.messages.update(messageId, { junk: false });
    }

    await browser.messages.move([messageId], inboxFolderId, { isUserAction: treatAsUserAction });

    return {
      success: true,
      result: {
        requested: "restoreToInbox",
        originalMessageId: messageId,
        originalHeaderMessageId: original.headerMessageId ?? null,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: makeError(CODES.API_ERROR, e?.message ?? String(e)),
    };
  }
}
