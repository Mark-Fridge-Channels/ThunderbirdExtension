/**
 * Single command entry: poll local minimal-server (no Native Messaging).
 * - On load: GET /ping to verify 127.0.0.1 is reachable (log result).
 * - Poll GET /next every 2s; on command, run router → handler, then POST /done.
 * Init guarded by session storage to avoid double execution on re-entry (reference.md).
 */

import { route } from "./router.js";
import { log } from "../shared/logger.js";

const BASE = "http://127.0.0.1:3939";
const POLL_MS = 2000;

const browser = globalThis.browser ?? globalThis.messenger;

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
    response = await route(envelope);
  } catch (e) {
    log("route error", e);
    response = {
      request_id,
      success: false,
      error: { code: "INTERNAL", message: e?.message ?? String(e) },
    };
  }
  try {
    await fetch(`${BASE}/done`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    });
  } catch (e) {
    log("POST /done failed:", e?.message);
  }
}

async function poll() {
  try {
    const res = await fetch(`${BASE}/next`);
    if (res.status === 204) return;
    if (!res.ok) return;
    const cmd = await res.json();
    if (cmd?.request_id && cmd?.action) await runOneCommand(cmd);
  } catch (_) {}
}

async function init() {
  const { initialized } = await browser.storage.session.get({ initialized: false });
  if (initialized) return;
  await browser.storage.session.set({ initialized: true });

  await ping();
  setInterval(poll, POLL_MS);
  log("minimal-server polling started, BASE=" + BASE);
}

browser.runtime.onStartup.addListener(() => {});
init();
