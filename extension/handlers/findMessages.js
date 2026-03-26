/**
 * Bridge V1: findMessages — messages.query + messages.continueList with limit/truncated.
 */

import { normalizeMessageHeader } from "../shared/bridgeNormalize.js";
import { makeError, CODES } from "../shared/errors.js";

const browser = globalThis.browser ?? globalThis.messenger;

function extractBodyFromMessagePart(part) {
  if (!part) return { plain: "", htmlFallback: "" };

  const contentType = String(part.contentType || "").toLowerCase();
  const body = typeof part.body === "string" ? part.body : typeof part.content === "string" ? part.content : "";

  let plain = "";
  let htmlFallback = "";

  if (contentType.startsWith("text/plain") && body) {
    plain = body;
  } else if (contentType.startsWith("text/html") && body && !htmlFallback) {
    htmlFallback = body;
  }

  if (Array.isArray(part.parts)) {
    for (const p of part.parts) {
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
