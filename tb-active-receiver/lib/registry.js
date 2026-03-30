/**
 * Account registry: accounts.list + type/name + inbox ids; merges telemetry fields from storage.
 */

const browser = globalThis.browser ?? globalThis.messenger;

import * as inboxResolver from "./inboxResolver.js";
import * as state from "./state.js";

export async function refresh() {
  const accounts = await browser.accounts.list(false);
  const list = Array.isArray(accounts) ? accounts : [];
  const inboxRows = await inboxResolver.resolveInboxMap(list);
  const inboxById = Object.fromEntries(inboxRows.map((r) => [r.accountId, r]));

  const meta = await state.getAccountMetaMap();
  const mergedMeta = { ...meta };

  const entries = [];
  for (const acc of list) {
    if (!acc?.id) continue;
    const row = inboxById[acc.id] || {};
    if (!mergedMeta[acc.id]) mergedMeta[acc.id] = {};
    entries.push({
      accountId: acc.id,
      type: acc.type ?? "",
      name: acc.name ?? "",
      inboxFolderId: row.inboxFolderId ?? null,
      inboxPath: row.inboxPath ?? null,
    });
  }

  for (const id of Object.keys(mergedMeta)) {
    if (!entries.some((e) => e.accountId === id)) {
      delete mergedMeta[id];
    }
  }

  await state.setCachedAccounts(entries, mergedMeta);
  return entries;
}

export async function getPollingAccounts() {
  const options = await state.loadOptions();
  const disabled = new Set(
    Array.isArray(options.pollingDisabledAccountIds)
      ? options.pollingDisabledAccountIds.map(String)
      : []
  );
  const all = await state.getCachedAccounts();
  return all.filter((a) => a.accountId && !disabled.has(a.accountId) && a.inboxFolderId);
}
