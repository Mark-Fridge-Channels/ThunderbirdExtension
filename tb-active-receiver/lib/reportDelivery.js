/**
 * Persistent report queue + POST with retries. Successful deliveries ack by messageId (pruned weekly).
 */

import * as state from "./state.js";
import { buildTbWebhookPayload } from "./reportBuild.js";

const browser = globalThis.browser ?? globalThis.messenger;

const QUEUE_KEY = "tbActiveReceiverReportQueue";
const ACK_KEY = "tbActiveReceiverReportAckIds";
const MAX_QUEUE = 4000;
const ACK_RETAIN_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 50;

let drainRunning = false;

async function readQueue() {
  const { [QUEUE_KEY]: raw } = await browser.storage.local.get(QUEUE_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function writeQueue(items) {
  const trimmed = items.length > MAX_QUEUE ? items.slice(-MAX_QUEUE) : items;
  await browser.storage.local.set({ [QUEUE_KEY]: trimmed });
}

async function readAck() {
  const { [ACK_KEY]: raw } = await browser.storage.local.get(ACK_KEY);
  return raw && typeof raw === "object" ? { ...raw } : {};
}

async function writeAck(map) {
  await browser.storage.local.set({ [ACK_KEY]: map });
}

function pruneAck(map) {
  const cutoff = Date.now() - ACK_RETAIN_MS;
  const out = {};
  for (const [k, iso] of Object.entries(map)) {
    const t = Date.parse(String(iso));
    if (Number.isFinite(t) && t >= cutoff) out[k] = iso;
  }
  return out;
}

function jobKey(messageId) {
  return String(messageId);
}

/**
 * @returns {Promise<{ ok: boolean, status: number }>}
 */
async function postReport(url, body, secret) {
  if (!url) return { ok: false, status: 0 };
  try {
    const headers = { "Content-Type": "application/json" };
    const s = String(secret || "").trim();
    if (s) headers["X-TB-Receiver-Secret"] = s;
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return { ok: r.ok, status: Number(r.status) || 0 };
  } catch (e) {
    console.warn("[TB Active Receiver] report POST error", e?.message ?? e);
    return { ok: false, status: 0 };
  }
}

/**
 * Enqueue one Inbox message for webhook delivery (dedupes pending queue + recent ack).
 */
export async function enqueueInboxReportJob({ messageId, accountId, folderId, reason }) {
  if (messageId == null || !accountId) return;
  const k = jobKey(messageId);
  const ack = pruneAck(await readAck());
  if (ack[k]) return;

  const q = await readQueue();
  if (q.some((j) => jobKey(j.messageId) === k)) return;
  if (q.length >= MAX_QUEUE) {
    // Never drop queue head (oldest unprocessed item). Reject newest enqueue when full.
    console.warn("[TB Active Receiver] report queue is full; skip enqueue", { messageId, accountId, reason });
    return;
  }

  q.push({
    messageId,
    accountId,
    folderId: folderId ?? null,
    reason: reason === "reconcile" ? "reconcile" : "newMail",
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
  });
  await writeQueue(q);
}

/**
 * Drain queue (single-flight). Call after enqueue bursts and on alarms.
 * @param {number} [maxJobs=25] max successful/failed rotations per call
 */
export async function drainReportQueue(maxJobs = 25) {
  if (drainRunning) return;
  drainRunning = true;
  try {
    const options = await state.loadOptions();
    if (!options.enabled) return;
    const reportUrl = options.reportUrl ? String(options.reportUrl).trim() : "";
    if (!reportUrl) return;

    const includeBody = options.reportIncludeBody !== false;
    const secret = options.reportSecret ?? "";
    let budget = Math.max(1, Math.min(500, Number(maxJobs) || 25));

    while (budget-- > 0) {
      const q = await readQueue();
      if (q.length === 0) break;
      const job = q[0];
      const body = await buildTbWebhookPayload(
        job.messageId,
        job.accountId,
        job.folderId,
        includeBody,
        job.reason === "reconcile" ? "reconcile" : "newMail"
      );
      if (!body) {
        q.shift();
        await writeQueue(q);
        continue;
      }
      const post = await postReport(reportUrl, body, secret);
      if (post.ok) {
        console.log(
          `[TB Active Receiver] report sent: messageId=${job.messageId} account=${job.accountId} reason=${job.reason} status=${post.status}`
        );
        q.shift();
        await writeQueue(q);
        const ack = pruneAck(await readAck());
        ack[jobKey(job.messageId)] = new Date().toISOString();
        await writeAck(ack);
      } else {
        // 4xx (except 429) is usually unrecoverable for same payload (auth/validation).
        const unrecoverable4xx = post.status >= 400 && post.status < 500 && post.status !== 429;
        job.attempts = (job.attempts || 0) + 1;
        q.shift();
        if (unrecoverable4xx) {
          console.warn("[TB Active Receiver] report job dropped (unrecoverable 4xx)", {
            messageId: job.messageId,
            status: post.status,
          });
        } else if (job.attempts >= MAX_ATTEMPTS) {
          console.warn("[TB Active Receiver] report job dropped after max attempts", {
            messageId: job.messageId,
            attempts: job.attempts,
            status: post.status,
          });
        } else {
          q.push(job);
        }
        await writeQueue(q);
        break;
      }
    }
  } finally {
    drainRunning = false;
  }
}
