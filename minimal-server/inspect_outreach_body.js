#!/usr/bin/env node
/**
 * Fetch one Notion page and print the raw Outreach Body property + a rich_text link summary.
 *
 * Helps debug why links don't survive queueParser (plain_text) -> email (plain/html).
 *
 * Usage:
 *   node minimal-server/inspect_outreach_body.js "https://www.notion.so/..."
 *   node minimal-server/inspect_outreach_body.js 06c9166fd9fd836dae3401214be8b5d0
 *   OUTREACH_BODY_PROP="Outreach Body" node minimal-server/inspect_outreach_body.js <url>
 *
 * Requires minimal-server/config.json (notion.token, notion.notion_version).
 */

const path = require("path");
const { loadConfig, printConfigSummary } = require("./config.js");
const { getPage } = require("./notion.js");

function pageIdFromInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    const m = seg.match(/([0-9a-f]{32})/i);
    if (m) return m[1];
  } catch (_) {
    /* not a URL */
  }
  const m2 = s.match(/([0-9a-f]{32})/i);
  return m2 ? m2[1] : s.replace(/-/g, "");
}

function summarizeRichText(prop) {
  if (prop?.type !== "rich_text" || !Array.isArray(prop.rich_text)) {
    return { kind: prop?.type || "unknown", note: "not rich_text array" };
  }
  const runs = [];
  let plainConcat = "";
  for (const rt of prop.rich_text) {
    const t = rt?.plain_text ?? "";
    plainConcat += t;
    runs.push({
      plain_text: t,
      href: rt?.text?.link?.url ?? rt?.href ?? null,
      annotations: rt?.annotations ?? null,
    });
  }
  return { kind: "rich_text", plain_text_concat: plainConcat, runs, run_count: runs.length };
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("Usage: node inspect_outreach_body.js <notion_page_url_or_32hex_id>");
    process.exit(1);
  }

  const pageId = pageIdFromInput(input);
  if (!pageId || pageId.length < 32) {
    console.error("Could not parse page id from:", input);
    process.exit(1);
  }

  const propName = (process.env.OUTREACH_BODY_PROP || "Outreach Body").trim();

  process.env.CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
  const cfg = loadConfig();
  printConfigSummary(cfg);

  const notionCfg = { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion };

  console.error("\n[inspect] page_id (raw 32) =", pageId);
  console.error("[inspect] property =", propName);

  const page = await getPage(notionCfg, pageId);
  const props = page?.properties || {};

  const names = Object.keys(props).sort();
  console.log("\n=== Page properties (name : type) ===");
  for (const n of names) {
    console.log(`${n}: ${props[n]?.type}`);
  }

  const p = props[propName];
  if (!p) {
    console.error("\n[inspect] Property not found:", propName);
    console.error("Tip: set OUTREACH_BODY_PROP to an exact column name from the list above.");
    process.exit(2);
  }

  console.log("\n=== Raw property JSON ===");
  console.log(JSON.stringify(p, null, 2));

  console.log("\n=== Parsed summary (links vs plain_text) ===");
  console.log(JSON.stringify(summarizeRichText(p), null, 2));
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
