/**
 * minimal-server configuration loader.
 *
 * Source of truth: local config file (default: minimal-server/config.json).
 * Token is expected to be stored locally (user accepted plaintext on local machine).
 *
 * You may override the config path with CONFIG_PATH env.
 */

const fs = require("fs");
const path = require("path");

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function resolveConfigPath() {
  const p = process.env.CONFIG_PATH;
  if (p && p.trim()) return p;
  return path.join(__dirname, "config.json");
}

function requireNonEmptyString(v, name) {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`Missing config: ${name}`);
  }
  return v.trim();
}

function asPositiveInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function asBoolean(v, fallback) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on", "enable", "enabled"].includes(s)) return true;
    if (["0", "false", "no", "n", "off", "disable", "disabled"].includes(s)) return false;
  }
  return fallback;
}

function loadConfig() {
  const configPath = resolveConfigPath();
  const cfg = readJsonFile(configPath);

  const notion = cfg?.notion ?? {};
  const executor = cfg?.executor ?? {};

  const defaultPropNames = {
    Status: "Status",
    executed_at: "Completion Time",
    execution_result_detail: "Result Remark",
    reply_status: "Reply Status",
    payload: "Payload",
    external_event_id: "",
  };
  const notionPropertyNames = executor?.notion_property_names && typeof executor.notion_property_names === "object"
    ? { ...defaultPropNames, ...executor.notion_property_names }
    : defaultPropNames;

  const out = {
    configPath,
    notion: {
      token: requireNonEmptyString(notion.token, "notion.token"),
      databaseId: requireNonEmptyString(notion.database_id, "notion.database_id"),
      notionVersion: (typeof notion.notion_version === "string" && notion.notion_version.trim()) || "2022-06-28",
    },
    executor: {
      enabled: asBoolean(process.env.EXECUTOR_ENABLED ?? executor.enabled, true),
      pollIntervalMs: asPositiveInt(executor.poll_interval_ms, 60000),
      pageSize: Math.min(100, Math.max(1, asPositiveInt(executor.page_size, 20))),
      addressBookId: typeof executor.address_book_id === "string" ? executor.address_book_id.trim() : "",
      notionPropertyNames,
    },
  };

  return out;
}

function printConfigSummary(cfg) {
  const masked = cfg.notion.token.slice(0, 6) + "…" + cfg.notion.token.slice(-4);
  console.error("[minimal-server] config loaded from", cfg.configPath);
  console.error("  notion.database_id =", cfg.notion.databaseId);
  console.error("  notion.token =", masked);
  console.error("  notion.version =", cfg.notion.notionVersion);
  console.error("  executor.enabled =", cfg.executor.enabled);
  console.error("  executor.poll_interval_ms =", cfg.executor.pollIntervalMs);
  console.error("  executor.page_size =", cfg.executor.pageSize);
  console.error("  executor.address_book_id =", cfg.executor.addressBookId ? cfg.executor.addressBookId : "(empty)");
}

module.exports = { loadConfig, printConfigSummary };

