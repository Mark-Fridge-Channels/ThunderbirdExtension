#!/usr/bin/env node
/**
 * Smoke helper: run one Notion poll & print candidate count.
 *
 * This script does NOT execute actions. It helps verify:
 * - minimal-server/config.json is readable
 * - Notion token + database_id are valid
 * - Execute Window sorting/query works
 *
 * Usage:
 *   node minimal-server/smoke_warmup_executor.js
 */

const { loadConfig, printConfigSummary } = require("./config.js");
const { queryDatabase } = require("./notion.js");
const { parseQueueRow, isWithinWindow } = require("./queueParser.js");

async function main() {
  const cfg = loadConfig();
  printConfigSummary(cfg);

  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };
  const data = await queryDatabase(notionCfg, cfg.notion.databaseId, {
    pageSize: cfg.executor.pageSize,
    sorts: [{ property: "Execute Window", direction: "ascending" }],
  });

  const results = Array.isArray(data?.results) ? data.results : [];
  const now = new Date();
  const candidates = [];
  for (const page of results) {
    const row = parseQueueRow(page);
    if (!row.plannedEventType) continue;
    if (row.status !== "Pending") continue;
    if (row.auditDecision !== "Keep") continue;
    if (!isWithinWindow(row.executeWindow, now)) continue;
    candidates.push(row);
  }

  console.log("queried rows:", results.length);
  console.log("candidates:", candidates.length);
  for (const r of candidates.slice(0, 5)) {
    console.log("-", { taskId: r.taskId, type: r.plannedEventType, actor: r.actorEmail, target: r.counterpartyEmail });
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});

