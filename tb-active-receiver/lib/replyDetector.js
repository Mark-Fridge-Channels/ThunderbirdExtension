/**
 * messages.onNewMailReceived: Inbox-only enqueue for webhook + touch lastNewMailAt.
 * Actual POST runs through reportDelivery queue (retries, reconcile dedupe).
 */

import * as registry from "./registry.js";
import * as state from "./state.js";
import { enqueueInboxReportJob, drainReportQueue } from "./reportDelivery.js";

const browser = globalThis.browser ?? globalThis.messenger;

async function loadInboxKeys() {
  const accounts = await registry.getPollingAccounts();
  return new Set(accounts.map((a) => `${a.accountId}:${a.inboxFolderId}`));
}

function isPollingInboxFolder(folder, header, inboxKeys) {
  // folder is the MailFolder passed to onNewMailReceived; it reliably has accountId in TB 128+.
  // header.folder may lack accountId in some TB versions, causing all messages to be filtered out.
  const aid = folder?.accountId ?? header.folder?.accountId;
  const fid = folder?.id ?? header.folder?.id;
  if (!aid || fid == null) return false;
  return inboxKeys.has(`${aid}:${fid}`);
}

export async function handleNewMailFolderBatch(folder, messages) {
  const options = await state.loadOptions();
  const reportUrl = options.reportUrl ? String(options.reportUrl).trim() : "";

  await browser.storage.session.set({ tbActiveReceiverRoundHadNewMail: true });

  const inboxKeys = await loadInboxKeys();
  const msgList = messages?.messages ?? [];
  for (const header of msgList) {
    if (!header?.id) continue;
    if (!isPollingInboxFolder(folder, header, inboxKeys)) continue;

    const accountId = header.folder?.accountId ?? folder?.accountId ?? null;
    if (accountId) {
      await state.touchNewMail(accountId);
    }

    if (reportUrl && accountId) {
      const folderId = folder?.id ?? header.folder?.id ?? null;
      await enqueueInboxReportJob({
        messageId: header.id,
        accountId,
        folderId,
        reason: "newMail",
      });
    }
  }

  if (reportUrl) {
    await drainReportQueue();
  }
}

/**
 * @param {boolean} monitorAllFolders maps to messages.onNewMailReceived flag (TB 121+)
 * @param {() => Promise<object>} getOptions
 */
export function attachNewMailListener(monitorAllFolders, getOptions) {
  const listener = async (folder, messages) => {
    const opt = await getOptions();
    if (!opt.enabled) return;
    try {
      await handleNewMailFolderBatch(folder, messages);
    } catch (e) {
      console.warn("[TB Active Receiver] onNewMail handler", e?.message ?? e);
    }
  };

  browser.messages.onNewMailReceived.addListener(listener, !!monitorAllFolders);
  return () => browser.messages.onNewMailReceived.removeListener(listener);
}
