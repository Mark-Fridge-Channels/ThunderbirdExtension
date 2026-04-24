/**
 * When compose.onAfterSend times out, infer success from a copy in Sent
 * (source of truth), matching envelope + time window.
 */

import { normalizeSendResult } from "./bridgeNormalize.js";

const browser = globalThis.browser ?? globalThis.messenger;

const OPEN_BUFFER_MS = 120_000;
const MAX_PAGES = 6;
const MSGS_PER_PAGE = 100;

function extractLowerEmail(text) {
  const s = String(text || "").trim();
  const m = s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return (m ? m[0] : s).toLowerCase();
}

function recipientEmailsFromHeader(m) {
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const flat = (list) =>
    list
      .flatMap((x) =>
        typeof x === "string"
          ? x.split(/[,;]/).map((y) => y.trim()).filter(Boolean)
          : [String(x).trim()].filter(Boolean)
      )
      .map((x) => extractLowerEmail(x))
      .filter(Boolean);
  return {
    to: new Set(flat(arr(m?.recipients))),
    cc: new Set(flat(arr(m?.ccList))),
    bcc: new Set(flat(arr(m?.bccList))),
  };
}

function normSubject(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Sent copy may omit Bcc; require To+Cc match, and Bcc match only when the
 * message header still lists the same Bcc addresses.
 */
function envelopeMatchesMessage(expected, msg) {
  const got = recipientEmailsFromHeader(msg);
  if (!setsEqual(expected.to, got.to)) return false;
  if (!setsEqual(expected.cc, got.cc)) return false;
  if (expected.bcc.size === 0 && got.bcc.size === 0) return true;
  if (got.bcc.size === 0) return true;
  return setsEqual(expected.bcc, got.bcc);
}

async function getAccountIdentityEmails(accountId) {
  const out = new Set();
  if (!accountId) return out;
  try {
    const acc = await browser.accounts.get(accountId);
    const identities = Array.isArray(acc?.identities) ? acc.identities : [];
    for (const id of identities) {
      const em = id?.email ? String(id.email).trim().toLowerCase() : "";
      if (em) out.add(em);
    }
  } catch (_) {
    /* ignore */
  }
  return out;
}

async function findSentFolder(accountId) {
  try {
    const sent = await browser.folders.query({ accountId, specialUse: ["sent"] });
    if (Array.isArray(sent) && sent[0]) return sent[0];
  } catch (_) {
    /* some account types fail specialUse query */
  }
  try {
    const all = await browser.folders.query({ accountId });
    const list = Array.isArray(all) ? all : [];
    const lowerNames = ["sent", "sent items", "已发送", "已发送邮件", "已寄出"];
    for (const f of list) {
      const n = String(f?.name || "").trim().toLowerCase();
      if (lowerNames.includes(n)) return f;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

export async function resolveAccountIdForSent(accountId, identityId) {
  if (accountId) return accountId;
  if (!identityId) return null;
  try {
    const idn = await browser.identities.get(identityId);
    return idn?.accountId ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {object} p
 * @param {string|null} p.accountId
 * @param {string} p.identityId
 * @param {{ to: string[], cc: string[], bcc: string[], subject: string }} p.envelope
 * @param {number} p.openedAtMs - performance time when compose tab was opened
 * @returns {Promise<object|null>} normalizeSendResult shape or null
 */
export async function reconcileSentAfterComposeTimeout(p) {
  const accountId = await resolveAccountIdForSent(p.accountId, p.identityId);
  if (!accountId) return null;

  const sentFolder = await findSentFolder(accountId);
  if (!sentFolder?.id) return null;

  const identityEmails = await getAccountIdentityEmails(accountId);
  if (!identityEmails.size) return null;

  const openedAtMs = Number(p.openedAtMs);
  if (!Number.isFinite(openedAtMs)) return null;

  const toArr = p.envelope?.to || [];
  const ccArr = p.envelope?.cc || [];
  const bccArr = p.envelope?.bcc || [];
  if (!toArr.length && !ccArr.length && !bccArr.length) {
    return null;
  }

  const cutoff = new Date(openedAtMs - OPEN_BUFFER_MS);
  const expected = {
    to: new Set(toArr.map((x) => extractLowerEmail(x)).filter(Boolean)),
    cc: new Set(ccArr.map((x) => extractLowerEmail(x)).filter(Boolean)),
    bcc: new Set(bccArr.map((x) => extractLowerEmail(x)).filter(Boolean)),
  };
  const subj = normSubject(p.envelope?.subject ?? "");

  const queryInfo = {
    accountId,
    folderId: sentFolder.id,
    fromDate: cutoff,
    messagesPerPage: MSGS_PER_PAGE,
  };

  const candidates = [];
  let page = await browser.messages.query(queryInfo);
  for (let pageIdx = 0; pageIdx < MAX_PAGES; pageIdx++) {
    const msgs = page?.messages ?? [];
    for (const m of msgs) {
      if (m?.id != null) candidates.push(m);
    }
    if (!page?.id) break;
    page = await browser.messages.continueList(page.id);
  }

  const tMin = openedAtMs - OPEN_BUFFER_MS;
  const filtered = candidates.filter((m) => {
    const t = m.date != null ? new Date(m.date).valueOf() : 0;
    return Number.isFinite(t) && t >= tMin;
  });

  filtered.sort((a, b) => {
    const ta = a.date != null ? new Date(a.date).valueOf() : 0;
    const tb = b.date != null ? new Date(b.date).valueOf() : 0;
    return ta - tb;
  });

  for (const m of filtered) {
    const authorEm = extractLowerEmail(m.author ?? "");
    if (!authorEm || !identityEmails.has(authorEm)) continue;
    if (normSubject(m.subject) !== subj) continue;
    if (!envelopeMatchesMessage(expected, m)) continue;

    const headerMessageId = m.headerMessageId ?? null;
    const d = m.date != null ? new Date(m.date) : null;
    const fakeResult = {
      mode: "sendNow",
      headerMessageId,
      messages: [
        {
          id: m.id,
          headerMessageId,
          subject: m.subject ?? "",
          date: d && !isNaN(d.valueOf()) ? d : new Date(),
        },
      ],
    };
    return normalizeSendResult(fakeResult);
  }

  return null;
}
