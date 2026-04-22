/**
 * Send-side dedup — last line of defense against accidental duplicate sends.
 *
 * Policy: refuse to send when a message with the *exact same*
 *   (from, to, cc, bcc, subject, body)
 * was already sent within DEDUP_WINDOW_MS. Recipients are normalized
 * (lowercased + sorted + de-duplicated) because SMTP addressing is
 * case-insensitive and order does not change the outgoing message.
 * subject/body are compared verbatim (exact match).
 *
 * Persisted in browser.storage.local so the record survives background
 * Service Worker restarts — critical for catching duplicates that happen
 * minutes or hours apart.
 */

const browser = globalThis.browser ?? globalThis.messenger;

const STORAGE_KEY = "sendDedupV1";
export const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
/** Hard cap to prevent unbounded storage growth; oldest entries are pruned first. */
const MAX_ENTRIES = 2000;

function normalizeEmail(v) {
  return String(v ?? "").trim().toLowerCase();
}

function normalizeRecipientList(v) {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const e = normalizeEmail(raw);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  out.sort();
  return out;
}

/**
 * Compute a stable SHA-256 fingerprint for a prospective outgoing email.
 * Returns a hex string.
 *
 * @param {object} input
 * @param {string} input.from     sender email (identity)
 * @param {string[]} [input.to]
 * @param {string[]} [input.cc]
 * @param {string[]} [input.bcc]
 * @param {string} [input.subject]
 * @param {string} [input.body]
 */
export async function computeSendFingerprint(input) {
  const canonical = JSON.stringify({
    from: normalizeEmail(input?.from),
    to: normalizeRecipientList(input?.to),
    cc: normalizeRecipientList(input?.cc),
    bcc: normalizeRecipientList(input?.bcc),
    subject: String(input?.subject ?? ""),
    body: String(input?.body ?? ""),
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i += 1) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

async function loadEntries() {
  try {
    const got = await browser.storage.local.get(STORAGE_KEY);
    const raw = got?.[STORAGE_KEY];
    if (!raw || !Array.isArray(raw.entries)) return [];
    return raw.entries;
  } catch (_) {
    return [];
  }
}

function pruneEntries(entries, now) {
  const cutoff = now - DEDUP_WINDOW_MS;
  const fresh = entries.filter((e) => Number.isFinite(e?.at) && e.at >= cutoff);
  if (fresh.length <= MAX_ENTRIES) return fresh;
  fresh.sort((a, b) => a.at - b.at);
  return fresh.slice(fresh.length - MAX_ENTRIES);
}

async function saveEntries(entries) {
  try {
    await browser.storage.local.set({ [STORAGE_KEY]: { entries } });
  } catch (_) {
    // Storage quota or disabled — fail open so legitimate sends still go out.
  }
}

/**
 * Return duplicate info when a matching fingerprint was recorded within the window.
 * Returns null when no match (safe to send).
 *
 * @param {string} fingerprint
 * @param {number} [windowMs]
 */
export async function findRecentDuplicate(fingerprint, windowMs = DEDUP_WINDOW_MS) {
  if (!fingerprint) return null;
  const now = Date.now();
  const cutoff = now - windowMs;
  const entries = await loadEntries();
  let match = null;
  for (const e of entries) {
    if (!e || e.fp !== fingerprint) continue;
    if (!Number.isFinite(e.at) || e.at < cutoff) continue;
    if (!match || e.at > match.at) match = e;
  }
  return match ? { prevAt: match.at, from: match.from, to: match.to } : null;
}

/**
 * Record a successful send. Old entries (>24h) are pruned during the same write.
 *
 * @param {string} fingerprint
 * @param {object} meta     lightweight, non-sensitive metadata for diagnostics
 * @param {string} [meta.from]
 * @param {string[]} [meta.to]
 */
export async function recordSend(fingerprint, meta = {}) {
  if (!fingerprint) return;
  const now = Date.now();
  const entries = await loadEntries();
  const pruned = pruneEntries(entries, now);
  pruned.push({
    fp: fingerprint,
    at: now,
    from: normalizeEmail(meta.from),
    to: normalizeRecipientList(meta.to),
  });
  await saveEntries(pruned);
}
