/**
 * Build minimal-server webhook JSON from a message id (shared by live new-mail path and reconcile queue).
 */

import { extractBodyFromMessagePart } from "./messageBody.js";

const browser = globalThis.browser ?? globalThis.messenger;

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const key = name.toLowerCase();
  const raw = headers[key];
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x)).join(" ");
  }
  return raw != null ? String(raw) : "";
}

function collectHeadersFromFull(part, out) {
  if (!part) return;
  if (part.headers && typeof part.headers === "object") {
    for (const k of Object.keys(part.headers)) {
      if (!out[k]) out[k] = part.headers[k];
    }
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) collectHeadersFromFull(p, out);
  }
}

function replyHeuristic({ subject = "", inReplyTo = "", references = "", trackedIds }) {
  const subj = String(subject || "").trim();
  const irt = String(inReplyTo || "").trim();
  const refs = String(references || "").trim();
  if (irt || refs) {
    if (trackedIds?.size) {
      const blob = `${irt} ${refs}`.toLowerCase();
      for (const id of trackedIds) {
        if (id && blob.includes(String(id).toLowerCase().replace(/[<>]/g, "").trim())) {
          return { isReply: true, reason: "in-reply-to-refs-tracked" };
        }
      }
    }
    return { isReply: true, reason: "in-reply-to-or-refs" };
  }
  if (/^re:\s/i.test(subj)) {
    return { isReply: true, reason: "subject-re-prefix" };
  }
  return { isReply: false, reason: "none" };
}

async function loadTrackedIds() {
  const { tbActiveReceiverTrackedIds } = await browser.storage.local.get("tbActiveReceiverTrackedIds");
  const list = Array.isArray(tbActiveReceiverTrackedIds) ? tbActiveReceiverTrackedIds : [];
  return new Set(list.map((x) => String(x).trim()).filter(Boolean));
}

export async function resolveDefaultIdentityEmail(accountId) {
  if (!accountId) return "";
  try {
    const acc = await browser.accounts.get(accountId);
    const identities = Array.isArray(acc?.identities) ? acc.identities : [];
    let preferred = null;
    if (acc.defaultIdentityId) {
      preferred = identities.find((i) => i && i.id === acc.defaultIdentityId);
    }
    if (!preferred) {
      preferred = identities.find((i) => i && i.default) || identities[0];
    }
    const em = preferred?.email ? String(preferred.email).trim().toLowerCase() : "";
    return em;
  } catch (_) {
    return "";
  }
}

async function messageHasAttachments(messageId) {
  try {
    const m = await browser.messages.get(messageId);
    return Array.isArray(m?.attachments) && m.attachments.length > 0;
  } catch (_) {
    return false;
  }
}

function messageReceivedAtIso(header) {
  const d = header?.date;
  if (d instanceof Date && Number.isFinite(d.valueOf())) {
    return d.toISOString();
  }
  if (typeof d === "number" && Number.isFinite(d)) {
    const n = new Date(d);
    if (Number.isFinite(n.valueOf())) return n.toISOString();
  }
  if (typeof d === "string" && d.trim()) {
    const s = new Date(d);
    if (Number.isFinite(s.valueOf())) return s.toISOString();
  }
  // Fallback when message header has no valid date.
  return new Date().toISOString();
}

/**
 * @param {number} messageId
 * @param {string} accountId
 * @param {string|null} folderId
 * @param {boolean} includeBody
 * @param {"newMail"|"reconcile"} reportSource
 * @returns {Promise<object|null>} body for POST or null if must skip (e.g. no fc)
 */
export async function buildTbWebhookPayload(messageId, accountId, folderId, includeBody, reportSource) {
  let header;
  try {
    header = await browser.messages.get(messageId);
  } catch (_) {
    return null;
  }
  if (!header?.id) return null;

  const fcAccount = await resolveDefaultIdentityEmail(accountId);
  if (!fcAccount) return null;

  let inReplyTo = "";
  let references = "";
  let bodyPlain = "";
  let bodyHtml = "";

  try {
    const full = await browser.messages.getFull(messageId, { decodeContent: includeBody });
    const merged = {};
    collectHeadersFromFull(full, merged);
    inReplyTo = headerValue(merged, "in-reply-to");
    references = headerValue(merged, "references");
    if (includeBody) {
      const extracted = extractBodyFromMessagePart(full);
      bodyPlain = extracted.plain || "";
      bodyHtml = extracted.htmlFallback || "";
    }
  } catch (_) {
    /* header/body unavailable */
  }

  const trackedIds = await loadTrackedIds();
  const { isReply, reason } = replyHeuristic({
    subject: header.subject,
    inReplyTo,
    references,
    trackedIds,
  });

  const hasAttachments = await messageHasAttachments(messageId);

  return {
    schemaVersion: 1,
    type: "tb-active-receiver.newMail",
    receivedAt: messageReceivedAtIso(header),
    fcAccount,
    accountId,
    folderId: folderId ?? header.folder?.id ?? null,
    messageId: header.id,
    headerMessageId: header.headerMessageId ?? null,
    author: header.author ?? "",
    subject: header.subject ?? "",
    bodyPlain,
    bodyHtml,
    hasAttachments,
    isReplyHint: isReply,
    replyHintReason: reason,
    inReplyTo: inReplyTo || null,
    references: references || null,
    threadId: header.threadId ?? null,
    reportSource,
  };
}
