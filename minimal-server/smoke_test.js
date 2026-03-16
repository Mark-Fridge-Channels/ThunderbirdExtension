#!/usr/bin/env node
/**
 * Smoke test for scheme A: POST /command (switch_account_context), wait for response.
 * Usage: TEST_ACCOUNT_EMAIL=you@example.com node minimal-server/smoke_test.js
 */

const BASE = "http://127.0.0.1:3939";
const email = process.env.TEST_ACCOUNT_EMAIL || "mark@fridgechannels.com";

async function main() {
  const requestId = `smoke-${Date.now()}`;
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      action: "switch_account_context",
      payload: { email },
    }),
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  if (data.success) {
    console.log("\nOK: accountId =", data.result?.accountId, "folders =", data.result?.folders?.length ?? 0);
  } else {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message || e);
  console.error("Ensure: 1) node minimal-server/server.js is running 2) extension is loaded in Thunderbird");
  process.exit(1);
});
