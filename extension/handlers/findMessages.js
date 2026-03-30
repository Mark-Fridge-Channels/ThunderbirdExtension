/**
 * Bridge V1: findMessages — messages.query + messages.continueList with limit/truncated.
 */

import { normalizeMessageHeader } from "../shared/bridgeNormalize.js";
import { makeError, CODES } from "../shared/errors.js";

const browser = globalThis.browser ?? globalThis.messenger;

function extractBodyFromMessagePart(part) {
  if (!part) return { plain: "", htmlFallback: "" };

  function coerceToString(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;

    // WebExtension sometimes returns decoded content as typed arrays.
    if (typeof TextDecoder !== "undefined") {
      try {
        if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
        if (v instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(v));
        if (Array.isArray(v)) return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(v));
      } catch (_) {
        // ignore
      }
    }

    if (typeof v === "object") {
      if (typeof v.text === "string") return v.text;
      if (typeof v.data === "string") return v.data;
      if (v.data != null) return coerceToString(v.data);
      if (v.content != null) return coerceToString(v.content);
      if (v.body != null) return coerceToString(v.body);
    }

    return "";
  }

  // Thunderbird full message parts may use different keys.
  const contentType = String(
    part.contentType || part.mimeType || part.content_type || part.mime || ""
  ).toLowerCase();
  const body = coerceToString(part.body ?? part.content);

  let plain = "";
  let htmlFallback = "";

  if (contentType.startsWith("text/plain") && body) {
    plain = body;
  } else if (contentType.startsWith("text/html") && body && !htmlFallback) {
    htmlFallback = body;
  }

  const subParts = [];
  if (Array.isArray(part.parts)) subParts.push(...part.parts);
  if (Array.isArray(part.bodyParts)) subParts.push(...part.bodyParts);
  if (Array.isArray(part.subParts)) subParts.push(...part.subParts);
  if (part.body && Array.isArray(part.body.parts)) subParts.push(...part.body.parts);
  if (part.content && Array.isArray(part.content.parts)) subParts.push(...part.content.parts);

  if (subParts.length) {
    for (const p of subParts) {
      const r = extractBodyFromMessagePart(p);
      if (!plain && r.plain) plain = r.plain;
      if (!htmlFallback && r.htmlFallback) htmlFallback = r.htmlFallback;
      if (plain && htmlFallback) break;
    }
  }

  return { plain, htmlFallback };
}

function hasAnyFilter(p) {
  return (
    p.accountId != null ||
    p.folderId != null ||
    p.author != null ||
    p.recipients != null ||
    p.subject != null ||
    p.body != null ||
    p.fullText != null ||
    p.headerMessageId != null ||
    p.fromDate != null ||
    p.toDate != null ||
    p.read !== undefined ||
    p.flagged !== undefined ||
    p.junk !== undefined ||
    p.fromMe !== undefined ||
    p.toMe !== undefined ||
    p.attachment !== undefined
  );
}

function buildQueryInfo(payload) {
  const q = {};
  if (payload.accountId !== undefined && payload.accountId !== null) q.accountId = payload.accountId;
  if (payload.folderId !== undefined && payload.folderId !== null) q.folderId = payload.folderId;
  if (payload.includeSubFolders !== undefined) q.includeSubFolders = !!payload.includeSubFolders;
  if (payload.author) q.author = payload.author;
  if (payload.recipients) q.recipients = payload.recipients;
  if (payload.subject) q.subject = payload.subject;
  if (payload.body) q.body = payload.body;
  if (payload.fullText) q.fullText = payload.fullText;
  if (payload.headerMessageId) q.headerMessageId = payload.headerMessageId;
  if (payload.fromDate) q.fromDate = new Date(payload.fromDate);
  if (payload.toDate) q.toDate = new Date(payload.toDate);
  if (payload.read !== undefined) q.read = payload.read;
  if (payload.flagged !== undefined) q.flagged = payload.flagged;
  if (payload.junk !== undefined) q.junk = payload.junk;
  if (payload.fromMe !== undefined) q.fromMe = payload.fromMe;
  if (payload.toMe !== undefined) q.toMe = payload.toMe;
  if (payload.attachment !== undefined) q.attachment = payload.attachment;
  const mpp = payload.messagesPerPage;
  q.messagesPerPage = mpp != null && Number.isFinite(Number(mpp)) ? Math.max(1, Math.floor(Number(mpp))) : 100;
  if (payload.autoPaginationTimeout !== undefined) {
    const apt = Number(payload.autoPaginationTimeout);
    if (Number.isFinite(apt)) q.autoPaginationTimeout = apt;
  }
  return q;
}

export async function handleFindMessages({ payload }) {
  if (!hasAnyFilter(payload)) {
    return {
      success: false,
      error: makeError(CODES.VALIDATION, "At least one search filter is required (accountId, folderId, subject, etc.)"),
    };
  }

  const limit = payload.limit != null && Number.isFinite(Number(payload.limit))
    ? Math.max(1, Math.min(5000, Math.floor(Number(payload.limit))))
    : 500;

  const queryInfo = buildQueryInfo(payload);
  const includeBody = payload.includeBody === true;
  try {
    let page = await browser.messages.query(queryInfo);
    const items = [];

    while (true) {
      const msgs = page?.messages ?? [];
      for (const m of msgs) {
        const n = normalizeMessageHeader(m);
        if (n) {
          if (includeBody) {
            try {
              // getFull requires messagesRead and can be slower; only enabled when explicitly requested.
              const full = await browser.messages.getFull(m.id, { decodeContent: true });
              const extracted = extractBodyFromMessagePart(full);
              const body = extracted.plain || extracted.htmlFallback || "";
              n.body = body;
            } catch (_) {
              // Keep header data even if body extraction fails.
            }
          }
          items.push(n);
        }
        if (items.length >= limit) {
          return { success: true, result: { items, truncated: true } };
        }
      }
      if (!page?.id) break;
      page = await browser.messages.continueList(page.id);
    }
    return { success: true, result: { items, truncated: false } };
  } catch (e) {
    return {
      success: false,
      error: makeError(CODES.API_ERROR, e?.message ?? String(e)),
    };
  }
}
