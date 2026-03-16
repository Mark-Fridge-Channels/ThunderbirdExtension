/**
 * Demo 1: Switch to account by email, then send one email. Run with Node against minimal-server.
 * Prereq: node minimal-server/server.js running; Thunderbird with extension loaded.
 *
 * node demos/demo1_switch_and_send.js
 */

const BASE = "http://127.0.0.1:3939";

async function run() {
  const requestId = `demo1-${Date.now()}`;

  const switchPayload = {
    request_id: requestId,
    action: "switch_account_context",
    payload: { email: process.env.TEST_ACCOUNT_EMAIL || "your@example.com" },
  };
  const switchRes = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(switchPayload),
  });
  const switchData = await switchRes.json();
  console.log("switch_account_context:", JSON.stringify(switchData, null, 2));
  if (!switchData.success) {
    console.error("Switch failed");
    return;
  }

  const sendPayload = {
    request_id: `demo1-send-${Date.now()}`,
    action: "send_email",
    payload: {
      to: process.env.TEST_TO || "your@example.com",
      subject: "Mail Automation Demo 1",
      plainTextBody: "Sent by demo1_switch_and_send.js",
      isPlainText: true,
      dry_run: process.env.DRY_RUN === "1",
      idempotency_key: `demo1-${requestId}`,
    },
  };
  const sendRes = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sendPayload),
  });
  const sendData = await sendRes.json();
  console.log("send_email:", JSON.stringify(sendData, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
