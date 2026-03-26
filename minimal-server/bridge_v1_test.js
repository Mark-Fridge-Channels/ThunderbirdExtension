#!/usr/bin/env node
/**
 * Bridge V1 HTTP tests against minimal-server POST /command.
 *
 * Usage (examples):
 *   node minimal-server/bridge_v1_test.js
 *   STEP=listAccounts node minimal-server/bridge_v1_test.js
 *   STEP=findMessages TEST_ACCOUNT_ID=acc1 TEST_SUBJECT=invoice node minimal-server/bridge_v1_test.js
 *   STEP=sendEmail TEST_ACCOUNT_ID=... TEST_IDENTITY_ID=... TEST_TO=a@b.com TEST_BODY=hi SEND_REAL=1 node ...
 *   STEP=replyEmail TEST_MESSAGE_ID=12345 TEST_ACCOUNT_ID=... TEST_IDENTITY_ID=... TEST_BODY=thanks SEND_REAL=1 node ...
 *   STEP=restoreToInbox TEST_MESSAGE_ID=123 TEST_INBOX_FOLDER_ID=folder-... SEND_REAL=1 node ...
 *
 * SEND_REAL=1 runs sendEmail / replyEmail / restoreToInbox for real (otherwise those steps are skipped).
 * Defaults STEP=all runs listAccounts + findMessages (if env set) only unless SEND_REAL=1.
 */

const BASE = process.env.BASE || "http://127.0.0.1:3939";
const STEP = (process.env.STEP || "all").toLowerCase();
const SEND_REAL = process.env.SEND_REAL === "1" || process.env.SEND_REAL === "true";

function stepsRequested() {
  if (STEP === "all") {
    return new Set(["listAccounts", "findMessages", "sendEmail", "replyEmail", "restoreToInbox"]);
  }
  return new Set(
    STEP.split(/[, ]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

async function postCommand(action, payload, requestId) {
  const rid = requestId || `${action}-${Date.now()}`;
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: rid, action, payload }),
  });
  const data = await res.json().catch(() => ({}));
  return { httpStatus: res.status, ...data };
}

function findInboxFolderId(root) {
  if (!root) return null;
  if (Array.isArray(root.specialUse) && root.specialUse.includes("inbox")) return root.folderId;
  for (const s of root.subFolders || []) {
    const x = findInboxFolderId(s);
    if (x) return x;
  }
  return null;
}

async function run() {
  const want = stepsRequested();
  const results = [];

  if (want.has("listAccounts")) {
    console.error("\n=== listAccounts ===");
    const r = await postCommand("listAccounts", { includeSubFolders: true });
    console.log(JSON.stringify(r, null, 2));
    results.push({ step: "listAccounts", ok: r.success === true });
    if (!r.success) return results;

    const accounts = r.result?.accounts || [];
    if (accounts.length) {
      const a0 = accounts[0];
      const inbox = findInboxFolderId(a0.rootFolder);
      console.error("Hint: first accountId =", a0.accountId, " sample inboxFolderId =", inbox || "(missing)");
    }
  }

  if (want.has("findMessages")) {
    const accountId = process.env.TEST_ACCOUNT_ID;
    const folderId = process.env.TEST_FOLDER_ID;
    const subject = process.env.TEST_SUBJECT;
    console.error("\n=== findMessages ===");
    if (!accountId && !folderId && !subject && !process.env.TEST_HEADER_MSG_ID) {
      console.error("Skip: set TEST_ACCOUNT_ID and/or TEST_FOLDER_ID / TEST_SUBJECT / TEST_HEADER_MSG_ID");
      results.push({ step: "findMessages", ok: true, skipped: true });
    } else {
      const payload = { limit: 20, messagesPerPage: 50 };
      if (accountId) payload.accountId = accountId;
      if (folderId) payload.folderId = folderId;
      if (subject) payload.subject = subject;
      if (process.env.TEST_HEADER_MSG_ID) payload.headerMessageId = process.env.TEST_HEADER_MSG_ID;
      const r = await postCommand("findMessages", payload);
      console.log(JSON.stringify(r, null, 2));
      results.push({ step: "findMessages", ok: r.success === true });
    }
  }

  if (want.has("sendEmail")) {
    console.error("\n=== sendEmail ===");
    if (!SEND_REAL) {
      console.error("Skip: set SEND_REAL=1 and TEST_ACCOUNT_ID + TEST_IDENTITY_ID + TEST_TO + TEST_BODY");
      results.push({ step: "sendEmail", ok: true, skipped: true });
    } else {
      const r = await postCommand("sendEmail", {
        accountId: process.env.TEST_ACCOUNT_ID,
        identityId: process.env.TEST_IDENTITY_ID,
        to: [(process.env.TEST_TO || "test@example.com").trim()],
        cc: [],
        bcc: [],
        subject: process.env.TEST_SUBJECT || "Bridge V1 test",
        body: process.env.TEST_BODY || "Hello from bridge_v1_test.js",
        bodyFormat: "plain",
        sendMode: "sendNow",
      });
      console.log(JSON.stringify(r, null, 2));
      results.push({ step: "sendEmail", ok: r.success === true });
    }
  }

  if (want.has("replyEmail")) {
    console.error("\n=== replyEmail ===");
    const messageId = process.env.TEST_MESSAGE_ID;
    if (!SEND_REAL || messageId == null || messageId === "") {
      console.error("Skip: set SEND_REAL=1 and TEST_MESSAGE_ID (TB internal id) + account/identity");
      results.push({ step: "replyEmail", ok: true, skipped: true });
    } else {
      const r = await postCommand("replyEmail", {
        accountId: process.env.TEST_ACCOUNT_ID,
        identityId: process.env.TEST_IDENTITY_ID,
        messageId: Number(messageId),
        body: process.env.TEST_BODY || "Reply from bridge_v1_test.js",
        bodyFormat: "plain",
        sendMode: "sendNow",
        replyType: process.env.TEST_REPLY_TYPE || "replyToSender",
      });
      console.log(JSON.stringify(r, null, 2));
      results.push({ step: "replyEmail", ok: r.success === true });
    }
  }

  if (want.has("restoreToInbox")) {
    console.error("\n=== restoreToInbox ===");
    const messageId = process.env.TEST_MESSAGE_RESTORE_ID || process.env.TEST_MESSAGE_ID;
    const inboxFolderId = process.env.TEST_INBOX_FOLDER_ID;
    if (!SEND_REAL || messageId == null || !inboxFolderId) {
      console.error("Skip: set SEND_REAL=1, TEST_MESSAGE_RESTORE_ID (or TEST_MESSAGE_ID), TEST_INBOX_FOLDER_ID");
      results.push({ step: "restoreToInbox", ok: true, skipped: true });
    } else {
      const r = await postCommand("restoreToInbox", {
        messageId: Number(messageId),
        inboxFolderId,
        clearJunk: process.env.TEST_CLEAR_JUNK !== "0",
        treatAsUserAction: process.env.TEST_USER_ACTION !== "0",
      });
      console.log(JSON.stringify(r, null, 2));
      results.push({ step: "restoreToInbox", ok: r.success === true });
    }
  }

  return results;
}

run()
  .then((results) => {
    const failed = results.filter((x) => x.ok === false);
    if (failed.length) {
      console.error("\nSome steps failed:", failed);
      process.exit(1);
    }
    console.error("\nDone.", results);
  })
  .catch((e) => {
    console.error(e?.message || e);
    process.exit(1);
  });
