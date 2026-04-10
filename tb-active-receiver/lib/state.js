/**
 * Options, persisted account ledger (last fetch / new mail), and getStatus() payload.
 */

import { effectiveReportUrl } from "./constants.js";

const browser = globalThis.browser ?? globalThis.messenger;

const K = {
  options: "tbActiveReceiverOptions",
  accountMeta: "tbActiveReceiverAccountMeta",
  accounts: "tbActiveReceiverAccounts",
  roundRobin: "tbActiveReceiverRoundRobin",
};

const DEFAULT_OPTIONS = {
  enabled: true,
  pollIntervalMinutes: 1,
  pollAllAccounts: true,
  monitorAllFolders: true,
  /** Persisted override; empty means use built-in default (see loadOptions). */
  reportUrl: "",
  /** When true (default), decode message bodies for webhook (plain + HTML). */
  reportIncludeBody: true,
  /** Sent as X-TB-Receiver-Secret when non-empty (must match minimal-server tb_receiver_webhook_secret). */
  reportSecret: "",
  useMailTabFallback: false,
  settleAfterFetchMs: 3000,
  pollingDisabledAccountIds: [],
  /** Inbox reconcile alarm period (minutes); default 24h. Scans last 3 local calendar days. */
  reconcileInboxMinutes: 1440,
};

export async function loadOptions() {
  const { [K.options]: raw } = await browser.storage.local.get(K.options);
  const o = raw && typeof raw === "object" ? raw : {};
  const merged = { ...DEFAULT_OPTIONS, ...o };
  merged.reportUrl = effectiveReportUrl(merged.reportUrl);
  return merged;
}

export async function saveOptions(partial) {
  const { [K.options]: raw } = await browser.storage.local.get(K.options);
  const o = raw && typeof raw === "object" ? raw : {};
  const next = { ...DEFAULT_OPTIONS, ...o, ...partial };
  next.reportUrl = effectiveReportUrl(next.reportUrl);
  await browser.storage.local.set({ [K.options]: next });
  return next;
}

export async function getAccountMetaMap() {
  const { [K.accountMeta]: prev } = await browser.storage.local.get(K.accountMeta);
  return prev && typeof prev === "object" ? { ...prev } : {};
}

export async function getCachedAccounts() {
  const { [K.accounts]: list } = await browser.storage.local.get(K.accounts);
  return Array.isArray(list) ? list : [];
}

export async function setCachedAccounts(entries, mergedMeta) {
  await browser.storage.local.set({
    [K.accounts]: entries,
    [K.accountMeta]: mergedMeta,
  });
}

export async function touchFetchComplete(accountIds) {
  const now = new Date().toISOString();
  const map = await getAccountMetaMap();
  const ids = accountIds?.length ? accountIds : Object.keys(map);
  for (const id of ids) {
    if (!map[id]) map[id] = {};
    map[id].lastFetchAt = now;
  }
  await browser.storage.local.set({ [K.accountMeta]: map });
}

export async function touchNewMail(accountId) {
  if (!accountId) return;
  const now = new Date().toISOString();
  const map = await getAccountMetaMap();
  if (!map[accountId]) map[accountId] = {};
  map[accountId].lastNewMailAt = now;
  await browser.storage.local.set({ [K.accountMeta]: map });
}

export async function getRoundRobinIndex() {
  const { [K.roundRobin]: n } = await browser.storage.local.get(K.roundRobin);
  return Math.max(0, Number(n) || 0);
}

export async function setRoundRobinIndex(n) {
  await browser.storage.local.set({ [K.roundRobin]: n });
}

export async function getStatus() {
  const options = await loadOptions();
  const accounts = await getCachedAccounts();
  const meta = await getAccountMetaMap();
  const disabled = new Set(
    Array.isArray(options.pollingDisabledAccountIds)
      ? options.pollingDisabledAccountIds.map(String)
      : []
  );

  return {
    running: !!options.enabled,
    intervalMinutes: Math.max(1, Number(options.pollIntervalMinutes) || 1),
    accounts: accounts.map((a) => ({
      accountId: a.accountId,
      name: a.name ?? "",
      enabled: !disabled.has(a.accountId),
      lastFetchAt: meta[a.accountId]?.lastFetchAt,
      lastNewMailAt: meta[a.accountId]?.lastNewMailAt,
    })),
  };
}
