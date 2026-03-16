#!/usr/bin/env node
/**
 * Smoke test covering all 6 actions. Uses minimal-server (POST /command).
 * Prereq: node minimal-server/server.js running; Thunderbird with extension loaded.
 *
 * Env:
 *   TEST_ACCOUNT_EMAIL   - required for switch_account_context (and context for send/open/star/forward)
 *   TEST_TO             - optional, for send_email to address (default your@example.com)
 *   ADDRESS_BOOK_ID     - optional, for add_contact; skip if unset
 *   TEST_SUBJECT        - optional, for open_message; skip if unset
 *   TEST_HEADER_MSG_ID  - optional, for forward_message; skip if unset
 *
 * Usage: TEST_ACCOUNT_EMAIL=you@example.com node demos/smoke_all_actions.js
 *        ADDRESS_BOOK_ID=... (optional) TEST_SUBJECT=... (optional)
 */

const BASE = "http://127.0.0.1:3939";

async function postCommand(action, payload, requestId) {
  const id = requestId || `smoke-${action}-${Date.now()}`;
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request_id: id, action, payload }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function run() {
  const email = process.env.TEST_ACCOUNT_EMAIL || "mark@fridgechannels.com";
  let accountId = null;

  // 1. switch_account_context (required)
  console.log("1. switch_account_context ...");
  const switchData = await postCommand("switch_account_context", { email });
  if (!switchData.success) {
    console.error(switchData.error);
    process.exit(1);
  }
  accountId = switchData.result?.accountId;
  console.log("   OK accountId:", accountId, "folders:", switchData.result?.folders?.length ?? 0);

  // 2. send_email (dry_run)
  console.log("2. send_email (dry_run) ...");
  const sendData = await postCommand("send_email", {
    to: process.env.TEST_TO || "your@example.com",
    subject: "Smoke test",
    plainTextBody: "smoke_all_actions.js",
    isPlainText: true,
    dry_run: true,
  });
  if (!sendData.success) {
    console.error("   FAIL", sendData.error);
  } else {
    console.log("   OK dry_run");
  }

  // 3. open_message (optional: needs TEST_SUBJECT)
  const subject = process.env.TEST_SUBJECT;
  if (subject) {
    console.log("3. open_message ...");
    const openData = await postCommand("open_message", {
      accountId,
      folderPath: "INBOX",
      subject,
      open_mode: "tab",
    });
    if (!openData.success) console.error("   FAIL", openData.error);
    else console.log("   OK tabId:", openData.result?.tabId);
  } else {
    console.log("3. open_message skipped (set TEST_SUBJECT to run)");
  }

  // 4. star_message (optional: needs message; use TEST_SUBJECT to target)
  if (subject && accountId) {
    console.log("4. star_message ...");
    const starData = await postCommand("star_message", {
      accountId,
      folderPath: "INBOX",
      subject,
      starred: true,
    });
    if (!starData.success) console.error("   FAIL", starData.error);
    else console.log("   OK idempotent:", starData.result?.idempotent);
  } else {
    console.log("4. star_message skipped (set TEST_SUBJECT to run)");
  }

  // 5. add_contact (optional: needs ADDRESS_BOOK_ID)
  const addressBookId = process.env.ADDRESS_BOOK_ID;
  if (addressBookId) {
    console.log("5. add_contact ...");
    const contactData = await postCommand("add_contact", {
      addressBookId,
      email: process.env.CONTACT_EMAIL || "smoke-contact@example.com",
      displayName: "Smoke Contact",
    });
    if (!contactData.success) console.error("   FAIL", contactData.error);
    else console.log("   OK duplicate:", contactData.result?.duplicate);
  } else {
    console.log("5. add_contact skipped (set ADDRESS_BOOK_ID to run)");
  }

  // 6. forward_message (dry_run, optional: needs TEST_HEADER_MSG_ID or skip)
  const headerMessageId = process.env.TEST_HEADER_MSG_ID;
  if (headerMessageId && accountId) {
    console.log("6. forward_message (dry_run) ...");
    const fwdData = await postCommand("forward_message", {
      accountId,
      headerMessageId,
      folderPath: "INBOX",
      to: process.env.TEST_TO || "your@example.com",
      dry_run: true,
    });
    if (!fwdData.success) console.error("   FAIL", fwdData.error);
    else console.log("   OK dry_run");
  } else {
    console.log("6. forward_message skipped (set TEST_HEADER_MSG_ID to run)");
  }

  console.log("\nDone. All 6 actions covered (some steps may be skipped without env).");
}

run().catch((e) => {
  console.error(e.message || e);
  console.error("Ensure: node minimal-server/server.js running, extension loaded in Thunderbird.");
  process.exit(1);
});
