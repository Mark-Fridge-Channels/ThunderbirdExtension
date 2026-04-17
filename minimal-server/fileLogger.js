/**
 * Append-only file logging under minimal-server/log/, one file per local calendar day:
 *   log/minimal-server-YYYY-MM-DD.log
 * Optional mirror of console.error / .warn / .log to the same file.
 */

const fs = require("fs");
const path = require("path");

/** @type {{ enabled: boolean, directory: string, mirrorConsole: boolean }} */
let opts = {
  enabled: true,
  directory: path.join(__dirname, "log"),
  mirrorConsole: true,
};

let consolePatched = false;
const origConsole = {
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  log: console.log.bind(console),
};

function resolveDirectory(dir) {
  const d = String(dir || "log").trim() || "log";
  return path.isAbsolute(d) ? d : path.join(__dirname, d);
}

/**
 * @param {object} [logging] from cfg.logging
 * @param {boolean} [logging.enabled]
 * @param {string} [logging.directory] relative to minimal-server or absolute
 * @param {boolean} [logging.mirror_console] JSON key
 * @param {boolean} [logging.mirrorConsole] normalized (from config.js)
 */
function initFileLogging(logging = {}) {
  opts.enabled = logging.enabled !== false;
  opts.directory = resolveDirectory(logging.directory);
  if (logging.mirror_console === false || logging.mirrorConsole === false) {
    opts.mirrorConsole = false;
  } else {
    opts.mirrorConsole = true;
  }
}

function dailyLogFilePath() {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(opts.directory, `minimal-server-${day}.log`);
}

/**
 * @param {string} line single logical line (no trailing newline)
 */
function appendLine(line) {
  if (!opts.enabled) return;
  try {
    if (!fs.existsSync(opts.directory)) {
      fs.mkdirSync(opts.directory, { recursive: true });
    }
    const ts = new Date().toISOString();
    fs.appendFileSync(dailyLogFilePath(), `[${ts}] ${line}\n`, "utf8");
  } catch (e) {
    try {
      origConsole.error("[fileLogger] append failed", e?.message ?? e);
    } catch (_) {
      /* ignore */
    }
  }
}

function formatArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "object" && a !== null) {
    try {
      return JSON.stringify(a);
    } catch (_) {
      return String(a);
    }
  }
  return String(a);
}

function installConsoleMirror() {
  if (consolePatched || !opts.enabled || !opts.mirrorConsole) return;
  consolePatched = true;

  for (const method of ["error", "warn", "log"]) {
    const orig = origConsole[method];
    console[method] = (...args) => {
      try {
        const msg = args.map(formatArg).join(" ");
        appendLine(`[console.${method}] ${msg}`);
      } catch (_) {
        /* ignore mirror failures */
      }
      orig(...args);
    };
  }
}

/** Short JSON-safe summary for TB webhook request bodies (no raw mail text). */
function summarizeWebhookPayload(p) {
  if (!p || typeof p !== "object") return {};
  return {
    schemaVersion: p.schemaVersion,
    type: p.type,
    fcAccount: p.fcAccount,
    author: typeof p.author === "string" ? p.author.slice(0, 160) : p.author,
    subject: typeof p.subject === "string" ? p.subject.slice(0, 160) : "",
    messageId: p.messageId,
    headerMessageId: p.headerMessageId,
    bodyPlainLen: typeof p.bodyPlain === "string" ? p.bodyPlain.length : 0,
    bodyHtmlLen: typeof p.bodyHtml === "string" ? p.bodyHtml.length : 0,
    hasAttachments: p.hasAttachments,
    reportSource: p.reportSource,
  };
}

function summarizeWebhookResponse(body) {
  if (!body || typeof body !== "object") return { raw: String(body).slice(0, 200) };
  const o = {
    ok: body.ok,
    skipped: body.skipped,
    reason: body.reason,
    error: body.error,
    entityId: body.entityId,
    matchReason: body.matchReason,
    classification: body.classification,
    outboundPageId: body.outboundPageId,
    pageId: body.pageId,
    detail: typeof body.detail === "string" ? body.detail.slice(0, 300) : body.detail,
  };
  return o;
}

/** First-line audit: TCP/HTTP accepted for webhook path (before body fully read). */
function logTbReceiverRequestReceived({ client, path, contentLength }) {
  if (!opts.enabled) return;
  try {
    appendLine(
      `[webhook-audit] ${JSON.stringify({
        outcome: "http_received",
        client: client || "",
        path: path || "",
        contentLength:
          contentLength != null && contentLength !== "" && Number.isFinite(Number(contentLength))
            ? Number(contentLength)
            : null,
      })}`
    );
  } catch (_) {
    /* ignore */
  }
}

/** Write a line to the dedicated tb-receiver-report daily log file. */
function appendToReportLog(line) {
  if (!opts.enabled) return;
  try {
    const dir = opts.directory;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const filePath = path.join(dir, `tb-receiver-report-${day}.log`);
    const ts = new Date().toISOString();
    fs.appendFileSync(filePath, `[${ts}] ${line}\n`, "utf8");
  } catch (e) {
    try { origConsole.error("[fileLogger] report log append failed", e?.message ?? e); } catch (_) {}
  }
}

/**
 * Log raw incoming payload BEFORE any filtering/handler logic.
 * Written to both the main log and the dedicated tb-receiver-report log.
 */
function logRawReportPayload({ client, path, bytes, payload }) {
  if (!opts.enabled) return;
  try {
    const entry = JSON.stringify({
      outcome: "raw_received",
      client: client || "",
      path: path || "",
      bytes: bytes ?? null,
      payload,
    });
    appendLine(`[webhook-raw] ${entry}`);
    appendToReportLog(`[RAW] ${entry}`);
  } catch (_) {}
}

/**
 * One line per HTTP handling of POST /tb-active-receiver/report (or configured path).
 * Also mirrors to the dedicated report log.
 */
function logTbReceiverWebhook(event) {
  if (!opts.enabled) return;
  try {
    const line = `[webhook] ${JSON.stringify(event)}`;
    appendLine(line);
    appendToReportLog(line);
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  initFileLogging,
  installConsoleMirror,
  appendLine,
  summarizeWebhookPayload,
  summarizeWebhookResponse,
  logTbReceiverRequestReceived,
  logTbReceiverWebhook,
  logRawReportPayload,
};
