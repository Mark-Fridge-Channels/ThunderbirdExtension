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

const PORT = parseInt(process.env.PORT || "3939", 10);
/** Command wait timeout (ms). Reply/send may open UI or wait for network; default 120s. */
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || "120000", 10);

/** Queue: { request_id, action, payload, resolve } where resolve(responseBody) unblocks POST /command */
const queue = [];
/** Pending POST /command clients: request_id -> { res, resolve } */
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
    if (queue.length === 0) {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const item = queue.shift();
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
          const { res: clientRes } = pending.get(rid);
          pending.delete(rid);
          send(clientRes, 200, data);
        }
      } catch (_) {
        send(res, 400, { error: "Invalid JSON" });
      }
    });
    return;
  }

  if (req.method === "POST" && path === "/command") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const envelope = JSON.parse(body);
        const request_id = envelope?.request_id || `req-${Date.now()}`;
        const action = envelope?.action;
        const payload = envelope?.payload || {};
        if (!action) {
          send(res, 400, { success: false, error: { message: "action required" } });
          return;
        }
        const idempotency_key = envelope?.idempotency_key ?? null;
        queue.push({ request_id, action, payload, idempotency_key });
        const timeout = setTimeout(() => {
          if (pending.has(request_id)) {
            pending.delete(request_id);
            send(res, 504, {
              request_id,
              success: false,
              error: { code: "TIMEOUT", message: `Extension did not complete within ${COMMAND_TIMEOUT_MS / 1000}s` },
            });
          }
        }, COMMAND_TIMEOUT_MS);
        pending.set(request_id, {
          res,
          resolve: (result) => {
            clearTimeout(timeout);
            send(res, 200, result);
          },
        });
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
});
