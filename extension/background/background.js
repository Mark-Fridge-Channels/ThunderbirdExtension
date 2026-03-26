/**
 * Bridge V1: poll local minimal-server (127.0.0.1:3939).
 * - Envelope actions are camelCase only: listAccounts, sendEmail, replyEmail, findMessages, restoreToInbox.
 * - Poll GET /next every 2s; on command, run router → handler, then POST /done.
 * - alarms API: periodic wake-up (every ALARM_PERIOD_MINUTES) so that when the
 *   background Service Worker is terminated by the platform, it is auto-restarted
 *   and runs poll() once; no user reload required (see docs/explore-background-wakeup.md).
 * Init guarded by session storage to avoid double execution on re-entry (reference.md).
 */

import { route } from "./router.js";
import { log } from "../shared/logger.js";

const BASE = "http://127.0.0.1:3939";
const POLL_MS = 2000;
/** Alarm interval in minutes; 0.5 = 30s. Use 1 if target Thunderbird does not support 0.5. */
const ALARM_PERIOD_MINUTES = 0.5;

const browser = globalThis.browser ?? globalThis.messenger;
let pollCount = 0;

// Top-level: when alarm fires (e.g. after worker was killed), run poll() to resume command pull.
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "poll") {
    log("[bg] onAlarm poll", { when: Date.now() });
    poll();
  }
});

async function ping() {
  try {
    const res = await fetch(`${BASE}/ping`);
    const data = await res.json().catch(() => ({}));
    log("GET /ping:", res.status, data);
  } catch (e) {
    log("GET /ping failed:", e?.message ?? e);
  }
}

async function runOneCommand(cmd) {
  const { request_id, action, payload, idempotency_key } = cmd;
  if (!request_id || !action) return;
  let response;
  try {
    const envelope = { request_id, action, payload: payload ?? {} };
    if (idempotency_key != null) envelope.idempotency_key = idempotency_key;
    const startedAt = Date.now();
    log("[bg] runOneCommand start", { request_id, action });
    response = await route(envelope);
    log("[bg] runOneCommand done(route)", { request_id, action, ms: Date.now() - startedAt });
  } catch (e) {
    log("route error", e);
    response = {
      request_id,
      success: false,
      error: { code: "INTERNAL", message: e?.message ?? String(e) },
    };
  }
  try {
    log("[bg] POST /done", { request_id, action, success: response?.success });
    await fetch(`${BASE}/done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    });
    log("[bg] POST /done ok", { request_id, action });
  } catch (e) {
    log("POST /done failed:", e?.message);
  }
}

async function poll() {
  pollCount += 1;
  try {
    const res = await fetch(`${BASE}/next`);
    if (pollCount % 10 === 0) {
      log("[bg] poll tick", { pollCount, nextStatus: res.status });
    }
    if (res.status === 204) return;
    if (!res.ok) return;
    const cmd = await res.json();
    if (cmd?.request_id && cmd?.action) {
      log("[bg] /next hit", { request_id: cmd.request_id, action: cmd.action });
      await runOneCommand(cmd);
    }
  } catch (e) {
    log("[bg] poll error", { pollCount, error: e?.message ?? String(e) });
  }
}

async function init() {
  const { initialized } = await browser.storage.session.get({ initialized: false });
  if (initialized) {
    log("[bg] init skipped (session initialized=true)");
    return;
  }
  await browser.storage.session.set({ initialized: true });

  await ping();
  setInterval(poll, POLL_MS);
  // Ensure periodic alarm exists so worker is woken when terminated (MV3); create only if missing.
  const existing = await browser.alarms.get("poll");
  if (!existing) {
    await browser.alarms.create("poll", { periodInMinutes: ALARM_PERIOD_MINUTES });
    log("alarm 'poll' created, periodInMinutes=" + ALARM_PERIOD_MINUTES);
  }
  log("minimal-server polling started, BASE=" + BASE);
}

browser.runtime.onStartup.addListener(() => {});
init();
