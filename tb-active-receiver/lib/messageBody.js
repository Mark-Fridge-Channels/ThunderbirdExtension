/**
 * Extract text/plain and text/html from messages.getFull parts (aligned with bridge findMessages).
 */

function coerceToString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;

  if (typeof TextDecoder !== "undefined") {
    try {
      if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
      if (v instanceof ArrayBuffer) return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(v));
      if (Array.isArray(v)) return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(v));
    } catch (_) {
      /* ignore */
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

export function extractBodyFromMessagePart(part) {
  if (!part) return { plain: "", htmlFallback: "" };

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
