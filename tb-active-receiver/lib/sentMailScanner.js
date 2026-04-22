/**
 * Sent-mail scanner: walks the Sent folder of every local account, builds a
 * `tb-active-receiver.sentMail` webhook for each message, and POSTs it to the
 * minimal-server. The server matches the recipient to a Notion Entity page and
 * inserts a card in the page's inline "Email Timeline" database.
 *
 * Persistence:
 *   - `tbActiveReceiverSentMailAck`: map of messageId -> iso timestamp so we
 *     don't re-POST the same message on subsequent scans. Pruned by 8 days.
 *   - `tbActiveReceiverSentMailWatermark`: per-account ISO timestamp of the
 *     newest message we've already delivered. On next scan we only query
 *     messages received after that watermark (per-account fast path).
 *
 * The scanner is idempotent and safe to re-run.
 */

import * as state from "./state.js";
import { extractBodyFromMessagePart } from "./messageBody.js";
import { resolveDefaultIdentityEmail } from "./reportBuild.js";

function extractEmail(text) {
  const s = String(text || "").trim();
  const m = s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : s.toLowerCase();
}

function extractEmailFromRecipient(text) {
  const em = extractEmail(text);
  if (em && /@/.test(em)) return em;
  return "";
}

const browser = globalThis.browser ?? globalThis.messenger;

const ACK_KEY = "tbActiveReceiverSentMailAck";
const WATERMARK_KEY = "tbActiveReceiverSentMailWatermark";
const ACK_RETAIN_MS = 8 * 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_MESSAGES_PER_ACCOUNT = 1000;

function msgKey(accountId, messageId) {
  return `${accountId}:${messageId}`;
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
  for (const [k, iso] of Object.entries(map || {})) {
    const t = Date.parse(String(iso));
    if (Number.isFinite(t) && t >= cutoff) out[k] = iso;
  }
  return out;
}

async function readWatermarks() {
  const { [WATERMARK_KEY]: raw } = await browser.storage.local.get(WATERMARK_KEY);
  return raw && typeof raw === "object" ? { ...raw } : {};
}

async function writeWatermarks(map) {
  await browser.storage.local.set({ [WATERMARK_KEY]: map });
}

async function findSentFolder(accountId) {
  try {
    const sent = await browser.folders.query({ accountId, specialUse: ["sent"] });
    if (Array.isArray(sent) && sent[0]) return sent[0];
  } catch (_) {
    /* some account types fail specialUse query */
  }
  // Fallback: heuristic on name
  try {
    const all = await browser.folders.query({ accountId });
    const list = Array.isArray(all) ? all : [];
    const lowerNames = [
      "sent",
      "sent items",
      "已发送",
      "已发送邮件",
      "已寄出",
      "outbox",
    ];
    for (const f of list) {
      const n = String(f?.name || "").trim().toLowerCase();
      if (lowerNames.includes(n)) return f;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

async function queryMessagesInFolder(folder, fromDate) {
  const queryInfo = {
    accountId: folder.accountId,
    folderId: folder.id,
    messagesPerPage: 100,
  };
  if (fromDate instanceof Date && Number.isFinite(fromDate.valueOf())) {
    queryInfo.fromDate = fromDate;
  }
  const out = [];
  let page = await browser.messages.query(queryInfo);
  while (true) {
    const msgs = page?.messages ?? [];
    for (const m of msgs) {
      if (m?.id != null) out.push(m);
      if (out.length >= MAX_MESSAGES_PER_ACCOUNT) break;
    }
    if (out.length >= MAX_MESSAGES_PER_ACCOUNT) break;
    if (!page?.id) break;
    page = await browser.messages.continueList(page.id);
  }
  return out;
}

function asIso(date, fallback) {
  if (date instanceof Date && Number.isFinite(date.valueOf())) return date.toISOString();
  if (typeof date === "number" && Number.isFinite(date)) return new Date(date).toISOString();
  if (typeof date === "string" && date.trim()) {
    const d = new Date(date);
    if (Number.isFinite(d.valueOf())) return d.toISOString();
  }
  return fallback || new Date().toISOString();
}

function collectRecipients(header) {
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const norm = (list) =>
    list
      .flatMap((x) =>
        typeof x === "string"
          ? x.split(/[,;]/).map((y) => y.trim()).filter(Boolean)
          : [String(x).trim()].filter(Boolean)
      )
      .map((x) => extractEmailFromRecipient(x))
      .filter(Boolean);
  return {
    to: norm(arr(header?.recipients)),
    cc: norm(arr(header?.ccList)),
    bcc: norm(arr(header?.bccList)),
  };
}

async function buildSentMailPayload(header) {
  const accountId = header?.folder?.accountId;
  let bodyPlain = "";
  let bodyHtml = "";
  try {
    const full = await browser.messages.getFull(header.id, { decodeContent: true });
    const extracted = extractBodyFromMessagePart(full);
    bodyPlain = extracted.plain || "";
    bodyHtml = extracted.htmlFallback || "";
  } catch (_) {
    /* message body unavailable */
  }
  const { to, cc, bcc } = collectRecipients(header);
  const sentAt = asIso(header?.date, new Date().toISOString());
  const authorEmail = extractEmailFromRecipient(header?.author);
  const fcAccount = authorEmail || (await resolveDefaultIdentityEmail(accountId));
  return {
    schemaVersion: 1,
    type: "tb-active-receiver.sentMail",
    sentAt,
    fcAccount,
    accountId,
    folderId: header?.folder?.id ?? null,
    messageId: header.id,
    headerMessageId: header.headerMessageId ?? null,
    to,
    cc,
    bcc,
    subject: header.subject ?? "",
    bodyPlain,
    bodyHtml,
    threadId: header.threadId ?? null,
    reportSource: "sentScan",
  };
}

async function postPayload(url, body, secret) {
  const headers = { "Content-Type": "application/json" };
  const s = String(secret || "").trim();
  if (s) headers["X-TB-Receiver-Secret"] = s;
  try {
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    return { ok: r.ok, status: Number(r.status) || 0 };
  } catch (e) {
    console.warn("[TB Active Receiver] sentMail POST error", e?.message ?? e);
    return { ok: false, status: 0 };
  }
}

/**
 * Scan Sent folders across all polling-enabled accounts.
 * @param {{ lookbackDays?: number, entireSent?: boolean }} opts
 * @returns {Promise<{ perAccount: Array<{accountId:string, scanned:number, posted:number, skipped:number, failed:number}>, totalPosted:number }>}
 */
export async function scanSentMailAllAccounts(opts = {}) {
  const options = await state.loadOptions();
  const reportUrl = options.reportUrl ? String(options.reportUrl).trim() : "";
  if (!reportUrl) {
    return { perAccount: [], totalPosted: 0, error: "no_report_url" };
  }
  const secret = options.reportSecret ?? "";

  const lookbackDays = Math.max(1, Math.min(365, Number(opts.lookbackDays) || DEFAULT_LOOKBACK_DAYS));
  const entireSent = !!opts.entireSent;

  const cachedAccounts = await state.getCachedAccounts();
  const disabled = new Set(
    Array.isArray(options.pollingDisabledAccountIds) ? options.pollingDisabledAccountIds.map(String) : []
  );
  const accountIds = cachedAccounts
    .map((a) => a.accountId)
    .filter((id) => id && !disabled.has(id));

  if (accountIds.length === 0) {
    // Fallback to live accounts list in case the cache is stale.
    try {
      const live = await browser.accounts.list(false);
      for (const acc of live || []) {
        if (acc?.id && !disabled.has(acc.id)) accountIds.push(acc.id);
      }
    } catch (_) {
      /* ignore */
    }
  }

  const watermarks = await readWatermarks();
  let ack = pruneAck(await readAck());
  const perAccount = [];
  let totalPosted = 0;

  for (const accountId of accountIds) {
    const result = { accountId, scanned: 0, posted: 0, skipped: 0, failed: 0 };
    const sentFolder = await findSentFolder(accountId);
    if (!sentFolder?.id) {
      result.skipped = -1;
      perAccount.push(result);
      continue;
    }
    let fromDate;
    if (entireSent) {
      fromDate = undefined;
    } else {
      const wm = Date.parse(String(watermarks[accountId] || ""));
      if (Number.isFinite(wm)) {
        fromDate = new Date(wm);
      } else {
        const d = new Date();
        d.setDate(d.getDate() - lookbackDays);
        fromDate = d;
      }
    }

    let messages = [];
    try {
      messages = await queryMessagesInFolder(sentFolder, fromDate);
    } catch (e) {
      console.warn("[TB Active Receiver] sentMail query failed", accountId, e?.message ?? e);
      perAccount.push(result);
      continue;
    }
    result.scanned = messages.length;

    let newestIsoForAccount = watermarks[accountId] || null;
    for (const header of messages) {
      if (!header?.id) continue;
      const key = msgKey(accountId, header.id);
      if (ack[key]) {
        result.skipped += 1;
        continue;
      }
      let payload;
      try {
        payload = await buildSentMailPayload(header);
      } catch (e) {
        console.warn("[TB Active Receiver] sentMail build failed", header.id, e?.message ?? e);
        result.failed += 1;
        continue;
      }
      const post = await postPayload(reportUrl, payload, secret);
      if (post.ok) {
        result.posted += 1;
        totalPosted += 1;
        ack[key] = new Date().toISOString();
        const isoSent = payload.sentAt;
        if (!newestIsoForAccount || Date.parse(isoSent) > Date.parse(newestIsoForAccount)) {
          newestIsoForAccount = isoSent;
        }
      } else {
        result.failed += 1;
        // 4xx other than 429 is unrecoverable for same payload — ack it so we don't retry forever.
        if (post.status >= 400 && post.status < 500 && post.status !== 429) {
          ack[key] = new Date().toISOString();
        }
      }
    }

    if (newestIsoForAccount) {
      watermarks[accountId] = newestIsoForAccount;
    }
    perAccount.push(result);
  }

  await writeAck(ack);
  await writeWatermarks(watermarks);

  return { perAccount, totalPosted };
}

/** Reset the watermark + ack (used by "Scan entire Sent" button to re-report). */
export async function resetSentMailState() {
  await browser.storage.local.remove([ACK_KEY, WATERMARK_KEY]);
}
