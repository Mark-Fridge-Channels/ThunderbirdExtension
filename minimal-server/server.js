#!/usr/bin/env node
/**
 * Minimal HTTP server for "方案 A" (extension fetch): no Native Messaging.
 * - GET /ping: returns 200 (for verifying extension can fetch 127.0.0.1)
 * - POST /command: body { request_id, action, payload }; enqueues and blocks until /done
 * - GET /next: extension polls; returns next command or 204
 * - POST /done: body { request_id, result }; resolves the waiting POST /command client
 *
 * Usage: node minimal-server/server.js
 * Port: 3939 (set PORT=3939 by default)
 */

const http = require("http");
const { loadConfig, printConfigSummary } = require("./config.js");
const { startExecutor, handleTbActiveReceiverWebhook } = require("./executor.js");
const fileLogger = require("./fileLogger.js");

fileLogger.initFileLogging({});

/** Set when config loads; used by TB Active Receiver webhook. */
let runtimeCfg = null;

const PORT = parseInt(process.env.PORT || "3939", 10);
/** Command wait timeout (ms). Reply/send may open UI or wait for network; default 120s. */
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || "120000", 10);

/**
 * In-memory command queue.
 * Extension polls GET /next, executes one command, then POST /done with result.
 */
const queue = [];
let nextCallCount = 0;

/**
 * Pending requests waiting for extension completion.
 *
 * - For external HTTP clients (POST /command): we keep the Node http response `res` and reply when done.
 * - For internal callers (executor): we keep only a promise resolver (no `res`), and return the result.
 *
 * Map: request_id -> { res?: http.ServerResponse, resolve: (resultBody)=>void, timeout: NodeJS.Timeout }
 */
const pending = new Map();

/** CORS headers so extension (different origin) can fetch this server */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function send(res, status, body, extraHeaders = {}) {
  const headers = { ...CORS, ...extraHeaders };
  if (body !== undefined && body !== null) headers["Content-Type"] = "application/json";
  res.writeHead(status, headers);
  res.end(body === undefined || body === null ? "" : typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * Enqueue a command and wait for extension completion.
 *
 * @param {object} envelope
 * @param {string} envelope.request_id
 * @param {string} envelope.action
 * @param {object} [envelope.payload]
 * @param {string|null} [envelope.idempotency_key]
 * @param {http.ServerResponse|null} [clientRes]
 * @returns {Promise<object>} resolved with extension result body (same as POST /done body)
 */
function enqueueAndWait(envelope, clientRes = null) {
  const request_id = envelope?.request_id || `req-${Date.now()}`;
  const action = envelope?.action;
  const payload = envelope?.payload || {};
  const idempotency_key = envelope?.idempotency_key ?? null;
  if (!action) {
    return Promise.resolve({ request_id, success: false, error: { code: "VALIDATION", message: "action required" } });
  }

  // Note: queue is pulled by the extension; this function only enqueues + waits.
  const isInternal = !clientRes;
  console.error("[minimal-server] enqueue", { request_id, action, isInternal, hasPayload: payload && Object.keys(payload).length > 0 });
  queue.push({ request_id, action, payload, idempotency_key });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (!pending.has(request_id)) return;
      const pendingSize = pending.size;
      console.error("[minimal-server] command timeout", { request_id, action, pendingSize, queueSize: queue.length });
      pending.delete(request_id);
      const timeoutBody = {
        request_id,
        success: false,
        error: { code: "TIMEOUT", message: `Extension did not complete within ${COMMAND_TIMEOUT_MS / 1000}s` },
      };
      // External callers get an HTTP 504, internal callers get the JSON body.
      if (clientRes) send(clientRes, 504, timeoutBody);
      resolve(timeoutBody);
    }, COMMAND_TIMEOUT_MS);

    pending.set(request_id, { res: clientRes, resolve, timeout });
  });
}

try {
  runtimeCfg = loadConfig();
  fileLogger.initFileLogging(runtimeCfg.logging);
  if (runtimeCfg.logging.mirrorConsole !== false) {
    fileLogger.installConsoleMirror();
  }
  printConfigSummary(runtimeCfg);
  if (runtimeCfg.executor.enabled) {
    startExecutor({ cfg: runtimeCfg, enqueueAndWait });
  } else {
    console.error("[executor] disabled by config/env (executor.enabled=false or EXECUTOR_ENABLED=0)");
  }
} catch (e) {
  fileLogger.installConsoleMirror();
  console.error("[executor] not started:", e?.message ?? e);
  console.error("  Hint: copy minimal-server/config.example.json to minimal-server/config.json and fill it.");
}

const server = http.createServer((req, res) => {
  const url = req.url || "";
  const path = url.split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS, "Access-Control-Max-Age": "86400" });
    res.end();
    return;
  }

  if (req.method === "GET" && path === "/ping") {
    send(res, 200, { ok: true, message: "pong" });
    return;
  }

  if (req.method === "GET" && path === "/next") {
    nextCallCount += 1;
    if (queue.length === 0) {
      if (nextCallCount % 10 === 0) {
        console.error("[minimal-server] /next tick", { nextCallCount });
      }
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const item = queue.shift();
    console.error("[minimal-server] /next =>", { request_id: item.request_id, action: item.action, remainingQueue: queue.length });
    const nextPayload = {
      request_id: item.request_id,
      action: item.action,
      payload: item.payload || {},
    };
    if (item.idempotency_key != null) nextPayload.idempotency_key = item.idempotency_key;
    send(res, 200, nextPayload);
    return;
  }

  if (req.method === "POST" && path === "/done") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const rid = data?.request_id;
        if (rid && pending.has(rid)) {
          const { res: clientRes, resolve, timeout } = pending.get(rid);
          clearTimeout(timeout);
          pending.delete(rid);
          console.error("[minimal-server] /done <=", {
            request_id: rid,
            success: data?.success,
            code: data?.error?.code,
          });
          if (clientRes) send(clientRes, 200, data);
          resolve(data);
        }
      } catch (_) {
        send(res, 400, { error: "Invalid JSON" });
      }
    });
    return;
  }

  const webhookPath = String(runtimeCfg?.executor?.tbReceiverReportPath || "/tb-active-receiver/report").split("?")[0];
  if (req.method === "POST" && path === webhookPath) {
    const client = req.socket?.remoteAddress || "";
    if (!runtimeCfg) {
      fileLogger.logTbReceiverWebhook({
        outcome: "no_config",
        client,
        path,
        httpStatus: 503,
      });
      send(res, 503, { ok: false, error: "server_config_unavailable" });
      return;
    }
    const maxBytes = Number(runtimeCfg?.executor?.tbReportMaxBodyBytes) || 100 * 1024 * 1024;
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total <= maxBytes) chunks.push(chunk);
    });
    req.on("end", async () => {
      if (total > maxBytes) {
        fileLogger.logTbReceiverWebhook({
          outcome: "payload_too_large",
          client,
          path,
          bytes: total,
          maxBytes,
          httpStatus: 413,
        });
        send(res, 413, { ok: false, error: "payload_too_large", maxBytes });
        return;
      }
      let payload;
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        payload = JSON.parse(raw);
      } catch (e) {
        fileLogger.logTbReceiverWebhook({
          outcome: "invalid_json",
          client,
          path,
          bytes: total,
          httpStatus: 400,
          error: e?.message ?? String(e),
        });
        send(res, 400, { ok: false, error: "invalid_json_or_handler", detail: e?.message ?? String(e) });
        return;
      }
      try {
        const headers = {};
        for (const [k, v] of Object.entries(req.headers || {})) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
        }
        const out = await handleTbActiveReceiverWebhook(runtimeCfg, payload, headers);
        fileLogger.logTbReceiverWebhook({
          outcome: out.status >= 400 ? "handler_rejected" : "handled",
          client,
          path,
          bytes: total,
          httpStatus: out.status,
          payload: fileLogger.summarizeWebhookPayload(payload),
          response: fileLogger.summarizeWebhookResponse(out.body),
        });
        send(res, out.status, out.body);
      } catch (e) {
        console.error("[minimal-server] webhook error", e?.message ?? e);
        fileLogger.logTbReceiverWebhook({
          outcome: "handler_exception",
          client,
          path,
          bytes: total,
          httpStatus: 400,
          payload: fileLogger.summarizeWebhookPayload(payload),
          error: e?.message ?? String(e),
        });
        send(res, 400, { ok: false, error: "invalid_json_or_handler", detail: e?.message ?? String(e) });
      }
    });
    return;
  }

  if (req.method === "POST" && path === "/command") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const envelope = JSON.parse(body);
        const action = envelope?.action;
        if (action == null || typeof action !== "string" || !String(action).trim()) {
          send(res, 400, { success: false, error: { code: "VALIDATION", message: "action required" } });
          return;
        }
        await enqueueAndWait(envelope, res);
        // enqueueAndWait is the single response path: 200 from /done or 504 on timeout.
      } catch (_) {
        send(res, 400, { error: "Invalid JSON" });
      }
    });
    return;
  }

  send(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.error("[minimal-server] listening on http://127.0.0.1:" + PORT);
  console.error("  GET  /ping    - verification (extension fetch test)");
  console.error("  POST /command - enqueue command (block until extension POST /done)");
  console.error("  GET  /next    - extension polls for next command");
  console.error("  POST /done    - extension posts result");
  const wh = String(runtimeCfg?.executor?.tbReceiverReportPath || "/tb-active-receiver/report");
  console.error("  POST", wh, "- TB Active Receiver inbound webhook (JSON)");
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`[minimal-server] listen failed: ${err.code} 127.0.0.1:${PORT} already in use`);
    console.error("  Hint: stop the other minimal-server process, or set PORT to a free port.");
    return;
  }
  console.error("[minimal-server] server error:", err);
});

// Export for internal callers (Warmup Executor). CommonJS export is safe in node.
module.exports = { enqueueAndWait };
