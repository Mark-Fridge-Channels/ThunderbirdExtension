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

function asNonNegativeInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
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

function normalizeExecutorMode(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "outbound") return "outbound";
  if (s === "inbound") return "inbound";
  return "both";
}

function loadConfig() {
  const configPath = resolveConfigPath();
  const cfg = readJsonFile(configPath);

  const notion = cfg?.notion ?? {};
  const executor = cfg?.executor ?? {};

  const defaultPropNames = {
    Status: "Status",
    subject: "Outreach Subject",
    body: "Outreach Body",
    executed_at: "Completion Time",
    execution_result_detail: "Result Remark",
    reply_status: "Reply Status",
    reply: "Reply Body",
    payload: "Payload",
    external_event_id: "",
  };
  const notionPropertyNames = executor?.notion_property_names && typeof executor.notion_property_names === "object"
    ? { ...defaultPropNames, ...executor.notion_property_names }
    : defaultPropNames;

  const mode = normalizeExecutorMode(process.env.EXECUTOR_MODE ?? executor.mode ?? "both");
  const modeEnableOutbound = mode === "both" || mode === "outbound";
  const modeEnableInbound = mode === "both" || mode === "inbound";

  const out = {
    configPath,
    notion: {
      token: requireNonEmptyString(notion.token, "notion.token"),
      databaseId: requireNonEmptyString(notion.database_id, "notion.database_id"),
      notionVersion: (typeof notion.notion_version === "string" && notion.notion_version.trim()) || "2022-06-28",
      keyPersonDatabaseId:
        typeof notion.key_person_database_id === "string" && notion.key_person_database_id.trim()
          ? notion.key_person_database_id.trim()
          : "",
    },
    executor: {
      enabled: asBoolean(process.env.EXECUTOR_ENABLED ?? executor.enabled, true),
      mode,
      enableOutbound: asBoolean(process.env.EXECUTOR_ENABLE_OUTBOUND, modeEnableOutbound),
      enableInbound: asBoolean(process.env.EXECUTOR_ENABLE_INBOUND, modeEnableInbound),
      pollIntervalMs: asPositiveInt(executor.poll_interval_ms, 60000),
      pageSize: Math.min(100, Math.max(1, asPositiveInt(executor.page_size, 20))),
      maxScanRows: Math.min(2000, Math.max(20, asPositiveInt(executor.max_scan_rows, 200))),
      /** 0 = no cap. Else at most N outbound Todo rows processed per poll (avoids one huge batch blocking inbound / next Notion query). */
      maxTasksPerCycle: (() => {
        const n = Number(executor.max_tasks_per_cycle);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.min(500, Math.floor(n));
      })(),
      triggerLookbackMs: Math.min(
        7 * 24 * 60 * 60 * 1000,
        Math.max(5 * 60 * 1000, asPositiveInt(executor.trigger_lookback_ms, 24 * 60 * 60 * 1000))
      ),
      triggerHorizonMs: Math.min(
        24 * 60 * 60 * 1000,
        Math.max(60 * 1000, asPositiveInt(executor.trigger_horizon_ms, 30 * 60 * 1000))
      ),
      executeWindowGraceMs: Math.min(
        24 * 60 * 60 * 1000,
        asNonNegativeInt(executor.execute_window_grace_ms, 15 * 60 * 1000)
      ),
      expiredStatusName:
        typeof executor.expired_status_name === "string" && executor.expired_status_name.trim()
          ? executor.expired_status_name.trim()
          : "Expired",
      accountsCacheMs: Math.min(
        7 * 24 * 60 * 60 * 1000,
        Math.max(60 * 1000, asPositiveInt(executor.accounts_cache_ms, 6 * 60 * 60 * 1000))
      ),
      inboundPollIntervalMs: Math.min(
        24 * 60 * 60 * 1000,
        Math.max(30 * 1000, asPositiveInt(executor.inbound_poll_interval_ms, 3 * 60 * 1000))
      ),
      maxInboundChecksPerCycle: Math.min(
        200,
        Math.max(1, asPositiveInt(executor.max_inbound_checks_per_cycle, 5))
      ),
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
  console.error("  notion.key_person_database_id =", cfg.notion.keyPersonDatabaseId || "(empty)");
  console.error("  notion.token =", masked);
  console.error("  notion.version =", cfg.notion.notionVersion);
  console.error("  executor.enabled =", cfg.executor.enabled);
  console.error("  executor.mode =", cfg.executor.mode);
  console.error("  executor.enable_outbound =", cfg.executor.enableOutbound);
  console.error("  executor.enable_inbound =", cfg.executor.enableInbound);
  console.error("  executor.poll_interval_ms =", cfg.executor.pollIntervalMs);
  console.error("  executor.page_size =", cfg.executor.pageSize);
  console.error("  executor.max_scan_rows =", cfg.executor.maxScanRows);
  console.error("  executor.max_tasks_per_cycle =", cfg.executor.maxTasksPerCycle || "(unlimited)");
  console.error("  executor.trigger_lookback_ms =", cfg.executor.triggerLookbackMs);
  console.error("  executor.trigger_horizon_ms =", cfg.executor.triggerHorizonMs);
  console.error("  executor.execute_window_grace_ms =", cfg.executor.executeWindowGraceMs);
  console.error("  executor.expired_status_name =", cfg.executor.expiredStatusName);
  console.error("  executor.accounts_cache_ms =", cfg.executor.accountsCacheMs);
  console.error("  executor.inbound_poll_interval_ms =", cfg.executor.inboundPollIntervalMs);
  console.error("  executor.max_inbound_checks_per_cycle =", cfg.executor.maxInboundChecksPerCycle);
  console.error("  executor.address_book_id =", cfg.executor.addressBookId ? cfg.executor.addressBookId : "(empty)");
}

module.exports = { loadConfig, printConfigSummary };

