/**
 * messages.onNewMailReceived: reply heuristics + optional HTTP report + lastNewMailAt.
 * Report JSON includes schemaVersion, plain+HTML bodies (optional), and fcAccount for minimal-server webhook.
 */

import * as state from "./state.js";
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

/** Default identity email for this mail account (normalized lowercase). Used as FCAccount on the server. */
async function resolveDefaultIdentityEmail(accountId) {
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

async function postReport(url, body, secret) {
  if (!url) return;
  try {
    const headers = { "Content-Type": "application/json" };
    const s = String(secret || "").trim();
    if (s) headers["X-TB-Receiver-Secret"] = s;
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.warn("[TB Active Receiver] report failed", r.status);
    }
  } catch (e) {
    console.warn("[TB Active Receiver] report error", e?.message ?? e);
  }
}

export async function handleNewMailFolderBatch(folder, messages) {
  const options = await state.loadOptions();
  const reportUrl = options.reportUrl ? String(options.reportUrl).trim() : "";
  const includeBody = options.reportIncludeBody !== false;

  await browser.storage.session.set({ tbActiveReceiverRoundHadNewMail: true });

  const trackedIds = await loadTrackedIds();
  const msgList = messages?.messages ?? [];
  for (const header of msgList) {
    if (!header?.id) continue;
    let inReplyTo = "";
    let references = "";
    let bodyPlain = "";
    let bodyHtml = "";

    try {
      const full = await browser.messages.getFull(header.id, { decodeContent: includeBody });
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

    const { isReply, reason } = replyHeuristic({
      subject: header.subject,
      inReplyTo,
      references,
      trackedIds,
    });

    const accountId = header.folder?.accountId ?? folder?.accountId ?? null;
    if (accountId) {
      await state.touchNewMail(accountId);
    }

    if (reportUrl) {
      const fcAccount = await resolveDefaultIdentityEmail(accountId);
      if (!fcAccount) {
        console.warn("[TB Active Receiver] skip report: no identity email for account", accountId);
        continue;
      }
      const hasAttachments = await messageHasAttachments(header.id);
      await postReport(
        reportUrl,
        {
        schemaVersion: 1,
        type: "tb-active-receiver.newMail",
        receivedAt: new Date().toISOString(),
        fcAccount,
        accountId,
        folderId: folder?.id ?? header.folder?.id ?? null,
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
        },
        options.reportSecret
      );
    }
  }
}

/**
 * @param {boolean} monitorAllFolders maps to messages.onNewMailReceived flag (TB 121+)
 * @param {() => Promise<object>} getOptions
 */
export function attachNewMailListener(monitorAllFolders, getOptions) {
  const listener = async (folder, messages) => {
    const opt = await getOptions();
    if (!opt.enabled) return;
    try {
      await handleNewMailFolderBatch(folder, messages);
    } catch (e) {
      console.warn("[TB Active Receiver] onNewMail handler", e?.message ?? e);
    }
  };

  browser.messages.onNewMailReceived.addListener(listener, !!monitorAllFolders);
  return () => browser.messages.onNewMailReceived.removeListener(listener);
}
