/**
 * Periodic poll via alarms (MV3-friendly).
 */

const browser = globalThis.browser ?? globalThis.messenger;

export const ALARM_POLL = "tbActiveReceiver.poll";
export const ALARM_SETTLE = "tbActiveReceiver.settle";
/** Daily Inbox reconcile (3 local calendar days). */
export const ALARM_RECONCILE = "tbActiveReceiver.reconcile";

export async function ensurePollAlarm(intervalMinutes, enabled) {
  const existing = await browser.alarms.get(ALARM_POLL);
  const period = Math.max(1, Number(intervalMinutes) || 1);

  if (!enabled) {
    if (existing) await browser.alarms.clear(ALARM_POLL);
    return;
  }

  if (!existing || existing.periodInMinutes !== period) {
    await browser.alarms.clear(ALARM_POLL);
    await browser.alarms.create(ALARM_POLL, { periodInMinutes: period });
  }
}

export async function clearPollAlarm() {
  await browser.alarms.clear(ALARM_POLL);
}

export async function scheduleSettleAlarm(delayMs) {
  await browser.alarms.clear(ALARM_SETTLE);
  const ms = Math.max(500, Math.min(120000, Number(delayMs) || 3000));
  const when = Date.now() + ms;
  await browser.alarms.create(ALARM_SETTLE, { when });
}

export async function clearSettleAlarm() {
  await browser.alarms.clear(ALARM_SETTLE);
}

/** ~24h period for Inbox backfill (TB alarm minimum is 1 minute). */
export async function ensureReconcileAlarm(enabled, periodMinutes) {
  const period = Math.max(60, Math.min(7 * 24 * 60, Number(periodMinutes) || 24 * 60));
  const existing = await browser.alarms.get(ALARM_RECONCILE);
  if (!enabled) {
    if (existing) await browser.alarms.clear(ALARM_RECONCILE);
    return;
  }
  if (!existing || existing.periodInMinutes !== period) {
    await browser.alarms.clear(ALARM_RECONCILE);
    await browser.alarms.create(ALARM_RECONCILE, { periodInMinutes: period });
  }
}

export async function clearReconcileAlarm() {
  await browser.alarms.clear(ALARM_RECONCILE);
}
