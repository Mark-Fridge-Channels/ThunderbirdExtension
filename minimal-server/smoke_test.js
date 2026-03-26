#!/usr/bin/env node
/**
 * Minimal HTTP smoke: POST /command with Bridge V1 listAccounts.
 *
 * Usage: node minimal-server/smoke_test.js
 * Prereq: node minimal-server/server.js + Thunderbird extension loaded.
 */

const BASE = "http://127.0.0.1:3939";

async function main() {
  const requestId = `smoke-${Date.now()}`;
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      action: "listAccounts",
      payload: { includeSubFolders: true },
    }),
  });
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
  if (data.success) {
    const n = data.result?.accounts?.length ?? 0;
    console.log("\nOK: accounts =", n);
  } else {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e.message || e);
  console.error("Ensure: 1) node minimal-server/server.js  2) extension loaded in Thunderbird");
  process.exit(1);
});
