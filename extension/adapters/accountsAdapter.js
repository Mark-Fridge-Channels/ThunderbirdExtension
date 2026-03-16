/**
 * Adapter: accounts, identities, folders. Uses only official API.
 * - accounts.list() returns array of MailAccount
 * - identities.get/list return MailIdentity or array
 * - folders.query() returns array of MailFolder
 */

const browser = globalThis.browser ?? globalThis.messenger;

export async function resolveAccountBySelector(selector) {
  const list = await browser.accounts.list(true);
  if (!list || !list.length) return { account: null, identity: null };

  const byId = list.find((a) => a.id === selector);
  if (byId) {
    const identity = byId.identities?.[0] ?? null;
    return { account: byId, identity, accountId: byId.id, identityId: identity?.id ?? null };
  }

  const byEmail = list.find((a) => {
    const ids = a.identities || [];
    return ids.some((i) => i.email === selector);
  });
  if (byEmail) {
    const identity = byEmail.identities?.find((i) => i.email === selector) ?? byEmail.identities?.[0];
    return { account: byEmail, identity, accountId: byEmail.id, identityId: identity?.id ?? null };
  }

  for (const a of list) {
    const ids = await browser.identities.list(a.id);
    const identity = (ids || []).find((i) => i.id === selector || i.email === selector);
    if (identity) {
      return { account: a, identity, accountId: a.id, identityId: identity.id };
    }
  }
  return { account: null, identity: null };
}

export async function getFoldersForAccount(accountId) {
  const folders = await browser.folders.query({ accountId });
  if (!Array.isArray(folders)) return [];
  return folders.map((f) => ({
    id: f.id,
    path: f.path,
    name: f.name,
    accountId: f.accountId,
  }));
}

export async function getAccountWithFolders(accountId) {
  const account = await browser.accounts.get(accountId, true);
  if (!account) return null;
  const root = account.rootFolder;
  let folders = root?.subFolders
    ? collectPaths(root.subFolders, root.path || "")
    : [];
  if (folders.length === 0) folders = await getFoldersForAccount(accountId);
  return {
    accountId: account.id,
    name: account.name,
    identities: (account.identities || []).map((i) => ({ id: i.id, email: i.email, label: i.label })),
    folders,
  };
}

function collectPaths(nodes, prefix) {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const n of nodes) {
    const path = n.path || `${prefix}/${n.name}`.replace(/\/\/+/g, "/");
    out.push({ id: n.id, path, name: n.name, accountId: n.accountId });
    if (n.subFolders?.length) out.push(...collectPaths(n.subFolders, path));
  }
  return out;
}
