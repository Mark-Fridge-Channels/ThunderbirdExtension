/**
 * Adapter: messages query, get, update (flagged). Uses MessageList.messages access pattern.
 */

const browser = globalThis.browser ?? globalThis.messenger;

/**
 * Find folderId by accountId + folderPath (e.g. "Inbox", "INBOX" or full path).
 */
export async function findFolderId(accountId, folderPath) {
  const folders = await browser.folders.query({ accountId });
  if (!Array.isArray(folders)) return null;
  const normalized = (folderPath || "").toLowerCase().replace(/^\/+|\/+$/g, "");
  const match = folders.find(
    (f) =>
      f.path?.toLowerCase() === normalized ||
      f.path?.toLowerCase().endsWith("/" + normalized) ||
      (f.name && f.name.toLowerCase() === normalized)
  );
  return match?.id ?? null;
}

/**
 * Query messages. query() returns MessageList; use .messages array.
 */
export async function queryMessages(options) {
  const list = await browser.messages.query(options);
  const messages = list?.messages ?? [];
  return Array.isArray(messages) ? messages : [];
}

/**
 * Get one message by id.
 */
export async function getMessage(messageId) {
  return await browser.messages.get(messageId);
}

/**
 * Update message properties (e.g. flagged for star).
 */
export async function updateMessage(messageId, newProperties) {
  await browser.messages.update(messageId, newProperties);
}

/**
 * Resolve messageId from stable ref: accountId + folderPath + headerMessageId (or subject).
 */
export async function resolveMessageId(accountId, folderPath, opts = {}) {
  const folderId = await findFolderId(accountId, folderPath || "INBOX");
  if (!folderId) return null;
  const queryOpts = { folderId };
  if (opts.headerMessageId) queryOpts.headerMessageId = opts.headerMessageId;
  if (opts.subject) queryOpts.subject = opts.subject;
  const list = await browser.messages.query(queryOpts);
  const messages = list?.messages ?? [];
  if (messages.length === 0) return null;
  return messages[0].id;
}

/**
 * Build stable identifier for a message header.
 */
export function toStableRef(accountId, folderPath, header) {
  const path = folderPath ?? header?.folderPath ?? "";
  const headerMessageId = header?.headerMessageId ?? "";
  return { accountId, folderPath: path, headerMessageId };
}
