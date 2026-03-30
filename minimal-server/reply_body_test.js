#!/usr/bin/env node
/**
 * Fetch reply/inbound message body via extension findMessages(includeBody=true).
 *
 * Goal:
 * - Use the FIRST account's FIRST inbox folder.
 * - Ensure we can retrieve `items[0].body` from findMessages.
 * - Ensure mapping: inboundPayload.body === (target.body || "").
 * - DO NOT write anything to Notion.
 *
 * Prereq:
 * - `node minimal-server/server.js` running
 * - Thunderbird extension loaded
 */

const BASE = process.env.BASE || "http://127.0.0.1:3939";

function postCommand(action, payload) {
  const requestId = `${action}-bodytest-${Date.now()}`;
  return fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: requestId, action, payload }),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    return { httpStatus: res.status, data, requestId };
  });
}

function findSpecialFolder(root, special) {
  if (!root) return null;
  if (Array.isArray(root.specialUse) && root.specialUse.includes(special)) return root.folderId;
  for (const s of root.subFolders || []) {
    const x = findSpecialFolder(s, special);
    if (x) return x;
  }
  return null;
}

function findFolderByName(root, name) {
  if (!root) return null;
  if (typeof root.name === "string" && root.name.trim().toLowerCase() === String(name).trim().toLowerCase()) {
    return root.folderId;
  }
  for (const s of root.subFolders || []) {
    const x = findFolderByName(s, name);
    if (x) return x;
  }
  return null;
}

async function main() {
  console.error(`[reply_body_test] BASE=${BASE}`);

  const a0Res = await postCommand("listAccounts", { includeSubFolders: true });
  if (!a0Res.data?.success) {
    console.error("[reply_body_test] listAccounts failed:", a0Res.data?.error || a0Res.data);
    process.exit(1);
  }

  const accounts = a0Res.data.result?.accounts || [];
  if (!accounts.length) {
    console.error("[reply_body_test] no accounts in listAccounts result");
    process.exit(1);
  }

  const a0 = accounts[0];
  const inboxFolderId = findSpecialFolder(a0.rootFolder, "inbox") || findFolderByName(a0.rootFolder, "Inbox");
  if (!inboxFolderId) {
    console.error("[reply_body_test] cannot locate first account inbox folderId");
    console.error("a0.accountId =", a0.accountId);
    process.exit(1);
  }

  console.error("[reply_body_test] using:", {
    accountId: a0.accountId,
    inboxFolderId,
    accountIdentities: (a0.identities || []).length,
  });

  const fmRes = await postCommand("findMessages", {
    accountId: a0.accountId,
    folderId: inboxFolderId,
    includeBody: true,
    limit: 1,
    messagesPerPage: 50,
  });

  if (!fmRes.data?.success) {
    console.error("[reply_body_test] findMessages failed:", fmRes.data?.error || fmRes.data);
    process.exit(1);
  }

  const items = fmRes.data.result?.items || [];
  const target = items[0];
  if (!target) {
    console.error("[reply_body_test] findMessages returned empty items (inbox might be empty)");
    process.exit(1);
  }

  const inboundPayload = { body: target.body || "" };

  const body = inboundPayload.body;
  if (typeof body !== "string" || body.trim().length === 0) {
    console.error("[reply_body_test] FAIL: inboundPayload.body is empty");
    console.error("target keys =", Object.keys(target));
    console.error("target.body =", target.body);
    process.exit(1);
  }

  // Mapping check: executor uses `target.body || ""` to populate inboundPayload.body.
  const mappingOk = String(inboundPayload.body) === String(target.body || "");
  console.error("[reply_body_test] mappingOk =", mappingOk);
  if (!mappingOk) {
    console.error("[reply_body_test] FAIL: inboundPayload.body !== target.body||''");
    process.exit(1);
  }

  console.log(JSON.stringify(
    {
      ok: true,
      messageId: target.messageId,
      headerMessageId: target.headerMessageId,
      author: target.author,
      subject: target.subject,
      bodyLength: body.length,
      bodyPreview: body.slice(0, 400),
    },
    null,
    2
  ));
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});

