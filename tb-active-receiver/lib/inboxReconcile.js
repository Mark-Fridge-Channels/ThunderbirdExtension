/**
 * Daily-style Inbox scan: last 3 local calendar days (today + 2 prior), per-account Inbox folder.
 * Watermark is tracked per inbox for audit/observability (current window is fixed 3 local days).
 */

import * as registry from "./registry.js";
import * as state from "./state.js";
import { enqueueInboxReportJob, drainReportQueue } from "./reportDelivery.js";

const browser = globalThis.browser ?? globalThis.messenger;
const WM_KEY = "tbActiveReceiverInboxReconcileWatermark";

/** Local midnight at start of the calendar day that is `daysAgo` before today (0 = today). */
export function startOfLocalCalendarDay(daysAgo) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

/** Inclusive window: from 00:00 local on (today - 2) through now. */
export function getLocalThreeCalendarDayRange() {
  const fromDate = startOfLocalCalendarDay(2);
  const toDate = new Date();
  return { fromDate, toDate };
}

function inboxKey(accountId, inboxFolderId) {
  return `${accountId}:${inboxFolderId}`;
}

async function readWatermarks() {
  const { [WM_KEY]: raw } = await browser.storage.local.get(WM_KEY);
  return raw && typeof raw === "object" ? { ...raw } : {};
}

async function writeWatermarks(map) {
  await browser.storage.local.set({ [WM_KEY]: map });
}

/**
 * Query all messages in Inbox between fromDate and toDate (paginated).
 */
async function queryInboxRange(accountId, folderId, fromDate, toDate) {
  const queryInfo = {
    accountId,
    folderId,
    fromDate,
    toDate,
    messagesPerPage: 100,
  };
  const out = [];
  let page = await browser.messages.query(queryInfo);
  while (true) {
    const msgs = page?.messages ?? [];
    for (const m of msgs) {
      if (m?.id != null) out.push(m.id);
    }
    if (!page?.id) break;
    page = await browser.messages.continueList(page.id);
  }
  return out;
}

/**
 * Enqueue every Inbox message in the 3-day local window (per polling-enabled account).
 */
export async function runInboxReconcile() {
  const options = await state.loadOptions();
  if (!options.enabled) return;

  const accounts = await registry.getPollingAccounts();
  const { fromDate, toDate } = getLocalThreeCalendarDayRange();
  const watermarks = await readWatermarks();

  for (const acc of accounts) {
    const fid = acc.inboxFolderId;
    if (!fid) continue;
    const key = inboxKey(acc.accountId, fid);
    try {
      const ids = await queryInboxRange(acc.accountId, fid, fromDate, toDate);
      for (const messageId of ids) {
        await enqueueInboxReportJob({
          messageId,
          accountId: acc.accountId,
          folderId: fid,
          reason: "reconcile",
        });
      }
      watermarks[key] = new Date().toISOString();
    } catch (e) {
      console.warn("[TB Active Receiver] inbox reconcile failed", acc.accountId, e?.message ?? e);
    }
  }

  await writeWatermarks(watermarks);
  await drainReportQueue(300);
}
