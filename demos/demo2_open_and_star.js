/**
 * Demo 2: Open a message by query (folder + subject or headerMessageId) and star it.
 * Prereq: switch_account_context first, or pass accountId in payload.
 *
 * node demos/demo2_open_and_star.js
 */

const BASE = "http://127.0.0.1:3939";

async function run() {
  const accountEmail = process.env.TEST_ACCOUNT_EMAIL || "your@example.com";
  const requestId = `demo2-${Date.now()}`;

  await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: `${requestId}-switch`,
      action: "switch_account_context",
      payload: { email: accountEmail },
    }),
  });

  const openPayload = {
    request_id: `${requestId}-open`,
    action: "open_message",
    payload: {
      accountId: null,
      folderPath: "INBOX",
      subject: process.env.TEST_SUBJECT || "Mail Automation Demo",
      open_mode: "tab",
    },
  };
  const openRes = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(openPayload),
  });
  const openData = await openRes.json();
  console.log("open_message:", JSON.stringify(openData, null, 2));
  if (!openData.success) {
    console.error("Open failed");
    return;
  }

  const accountId = openData.result?.stableIdentifiers?.accountId ?? null;
  const starPayload = {
    request_id: `${requestId}-star`,
    action: "star_message",
    payload: {
      accountId,
      folderPath: "INBOX",
      headerMessageId: openData.result?.stableIdentifiers?.headerMessageId,
      starred: true,
    },
  };
  const starRes = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(starPayload),
  });
  const starData = await starRes.json();
  console.log("star_message:", JSON.stringify(starData, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
