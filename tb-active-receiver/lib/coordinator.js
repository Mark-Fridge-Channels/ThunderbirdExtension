/**
 * Orchestrates registry, scheduler, experiment fetch, settle fallback, reply detector.
 * Public façade: init, start, stop, fetchNowAll, fetchNowAccount, getStatus
 */

import * as state from "./state.js";
import * as registry from "./registry.js";
import * as scheduler from "./scheduler.js";
import * as activeFetcher from "./activeFetcher.js";
import { attachNewMailListener } from "./replyDetector.js";
import { runInboxReconcile } from "./inboxReconcile.js";
import { drainReportQueue } from "./reportDelivery.js";

const browser = globalThis.browser ?? globalThis.messenger;

let detachNewMail = null;

async function runMailTabFallback() {
  const accounts = await registry.getPollingAccounts();
  const tabs = await browser.mailTabs.query({});
  const firstTabId = tabs?.[0]?.id;

  for (const a of accounts) {
    if (!a.inboxFolderId) continue;
    try {
      if (firstTabId != null) {
        await browser.mailTabs.update(firstTabId, { displayedFolderId: a.inboxFolderId });
      } else {
        await browser.mailTabs.create({ displayedFolderId: a.inboxFolderId });
      }
    } catch (e) {
      console.warn("[TB Active Receiver] mailTabs fallback", e?.message ?? e);
    }
  }
}

async function beginFetchRound() {
  await browser.storage.session.set({ tbActiveReceiverRoundHadNewMail: false });
}

async function runNativeFetchForPoll() {
  const options = await state.loadOptions();
  const pollable = await registry.getPollingAccounts();
  const ids = pollable.map((a) => a.accountId);

  if (!ids.length) {
    return;
  }

  if (options.pollAllAccounts) {
    await activeFetcher.fetchAllAccounts();
    await state.touchFetchComplete(ids);
  } else {
    let idx = await state.getRoundRobinIndex();
    idx = idx % ids.length;
    const id = ids[idx];
    await activeFetcher.fetchAccount(id);
    await state.touchFetchComplete([id]);
    await state.setRoundRobinIndex(idx + 1);
  }
}

async function scheduleSettleFromOptions() {
  const options = await state.loadOptions();
  await scheduler.scheduleSettleAlarm(options.settleAfterFetchMs);
}

export async function runPollCycle() {
  const options = await state.loadOptions();
  if (!options.enabled) return;

  try {
    await beginFetchRound();
    await runNativeFetchForPoll();
    await scheduleSettleFromOptions();
  } catch (e) {
    console.warn("[TB Active Receiver] poll cycle", e?.message ?? e);
  } finally {
    await drainReportQueue(25);
  }
}

async function onSettleAlarm() {
  const options = await state.loadOptions();
  const { tbActiveReceiverRoundHadNewMail } = await browser.storage.session.get({
    tbActiveReceiverRoundHadNewMail: false,
  });
  if (!options.useMailTabFallback) return;
  if (tbActiveReceiverRoundHadNewMail) return;
  try {
    await runMailTabFallback();
  } catch (e) {
    console.warn("[TB Active Receiver] settle fallback", e?.message ?? e);
  }
}

export async function fetchNowAll() {
  await beginFetchRound();
  try {
    await activeFetcher.fetchAllAccounts();
    const all = await state.getCachedAccounts();
    await state.touchFetchComplete(all.map((a) => a.accountId).filter(Boolean));
  } finally {
    await scheduleSettleFromOptions();
  }
}

export async function fetchNowAccount(accountId) {
  if (!accountId) throw new Error("accountId required");
  await beginFetchRound();
  try {
    await activeFetcher.fetchAccount(accountId);
    await state.touchFetchComplete([accountId]);
  } finally {
    await scheduleSettleFromOptions();
  }
}

export async function fetchNowCurrentAccount() {
  await beginFetchRound();
  try {
    const r = await activeFetcher.fetchCurrentAccount();
    if (r?.accountId) {
      await state.touchFetchComplete([r.accountId]);
    }
  } finally {
    await scheduleSettleFromOptions();
  }
}

async function debugLogInboxMessages() {
  const accounts = await registry.getPollingAccounts();
  console.log("[TB Active Receiver] --- Inbox Debug Log Start ---");
  for (const acc of accounts) {
    if (!acc.inboxFolderId) continue;
    console.log(`[TB Active Receiver] Account: ${acc.name || acc.accountId} (${acc.type})`);
    try {
      // Paginate through all messages in the inbox
      const allMessages = [];
      let page = await browser.messages.query({ folderId: acc.inboxFolderId });
      while (page) {
        if (page.messages) allMessages.push(...page.messages);
        if (page.id) {
          page = await browser.messages.continueList(page.id);
        } else {
          break;
        }
      }
      if (allMessages.length > 0) {
        const sortedMessages = allMessages.sort((a, b) => {
          const dateA = a.date ? new Date(a.date).getTime() : 0;
          const dateB = b.date ? new Date(b.date).getTime() : 0;
          return dateB - dateA;
        });
        for (const m of sortedMessages) {
          const dateStr = m.date ? new Date(m.date).toLocaleString() : 'Unknown Date';
          console.log(`  - [${dateStr}] Subject: ${m.subject} | From: ${m.author}`);
        }
      } else {
        console.log(`  (No messages found in inbox)`);
      }
    } catch (e) {
      console.warn(`[TB Active Receiver] Failed to read messages for ${acc.name || acc.accountId}:`, e?.message ?? e);
    }
  }
  console.log("[TB Active Receiver] --- Inbox Debug Log End ---");
}

async function reattachNewMailListener() {
  const options = await state.loadOptions();
  if (detachNewMail) {
    detachNewMail();
    detachNewMail = null;
  }
  detachNewMail = attachNewMailListener(!!options.monitorAllFolders, () => state.loadOptions());
}

async function syncSchedulerWithOptions() {
  const options = await state.loadOptions();
  await scheduler.ensurePollAlarm(options.pollIntervalMinutes, options.enabled);
  await scheduler.ensureReconcileAlarm(options.enabled, options.reconcileInboxMinutes ?? 1440);
}

/**
 * One-time / reload setup: account + inbox cache, listener, alarm.
 */
export async function init() {
  await registry.refresh();
  await reattachNewMailListener();
  await syncSchedulerWithOptions();
}

export async function start() {
  await state.saveOptions({ enabled: true });
  await syncSchedulerWithOptions();
}

export async function stop() {
  await state.saveOptions({ enabled: false });
  await scheduler.clearPollAlarm();
  await scheduler.clearSettleAlarm();
  await scheduler.clearReconcileAlarm();
}

export async function getStatus() {
  return state.getStatus();
}

export function registerAlarmAndMessageHandlers() {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === scheduler.ALARM_POLL) {
      void runPollCycle();
    } else if (alarm.name === scheduler.ALARM_SETTLE) {
      void onSettleAlarm();
    } else if (alarm.name === scheduler.ALARM_RECONCILE) {
      void runInboxReconcile().catch((e) => console.warn("[TB Active Receiver] reconcile alarm", e?.message ?? e));
    }
  });

  browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;

    if (msg.type === "tbActiveRx.getStatus") {
      getStatus()
        .then((status) => sendResponse({ ok: true, status }))
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }

    if (msg.type === "tbActiveRx.init") {
      init()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }

    if (msg.type === "tbActiveRx.start") {
      start()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }

    if (msg.type === "tbActiveRx.stop") {
      stop()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }

    if (msg.type === "tbActiveRx.fetchNowAll") {
      fetchNowAll()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }

    if (msg.type === "tbActiveRx.fetchNowAccount") {
      fetchNowAccount(msg.accountId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }

    if (msg.type === "tbActiveRx.fetchNowCurrent") {
      fetchNowCurrentAccount()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }

    if (msg.type === "tbActiveRx.reloadSettings") {
      init()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }

    if (msg.type === "tbActiveRx.reconcileInboxNow") {
      runInboxReconcile(undefined, { entireInbox: true })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }

    if (msg.type === "tbActiveRx.debugLogInbox") {
      debugLogInboxMessages()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
      return true;
    }

    return false;
  });
}

export async function bootstrap() {
  browser.runtime.onStartup.addListener(() => {});
  registerAlarmAndMessageHandlers();
  await init();
  setTimeout(() => {
    runInboxReconcile().catch((e) => console.warn("[TB Active Receiver] startup reconcile", e?.message ?? e));
  }, 12000);
}
