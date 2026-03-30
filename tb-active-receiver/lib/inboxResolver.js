/**
 * Resolve Inbox folderId per account (specialUse inbox); used for mail tab fallback only.
 */

const browser = globalThis.browser ?? globalThis.messenger;

/**
 * @param {Array<{ id: string }>} accounts from browser.accounts.list
 * @returns {Promise<Array<{ accountId: string, inboxFolderId: string | null, inboxPath?: string }>>}
 */
export async function resolveInboxMap(accounts) {
  const rows = [];
  const list = Array.isArray(accounts) ? accounts : [];
  for (const acc of list) {
    if (!acc?.id) continue;
    const inboxFolders = await browser.folders.query({
      accountId: acc.id,
      specialUse: ["inbox"],
    });
    const inbox = Array.isArray(inboxFolders) && inboxFolders[0] ? inboxFolders[0] : null;
    rows.push({
      accountId: acc.id,
      inboxFolderId: inbox?.id ?? null,
      inboxPath: inbox?.path ?? null,
    });
  }
  return rows;
}
