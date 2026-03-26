/**
 * Notion Queue row parsing & helpers for Warmup Executor.
 *
 * We intentionally keep parsing tolerant:
 * - same semantic field may exist under multiple property names (key aliases)
 * - rich_text/title is concatenated into plain text
 */

function firstDefined(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  }
  return undefined;
}

function concatPlainText(arr) {
  if (!Array.isArray(arr)) return "";
  return arr.map((x) => x?.plain_text ?? "").join("").trim();
}

function readSelectName(prop) {
  if (prop?.type === "select") return (prop?.select?.name ?? "").trim();
  if (prop?.type === "status") return (prop?.status?.name ?? "").trim();
  return "";
}

function readDateRange(prop) {
  if (prop?.type !== "date") return { start: null, end: null };
  const start = prop?.date?.start ? new Date(prop.date.start) : null;
  const end = prop?.date?.end ? new Date(prop.date.end) : null;
  return { start, end };
}

function readRichText(prop) {
  if (prop?.type === "rich_text") return concatPlainText(prop.rich_text);
  if (prop?.type === "title") return concatPlainText(prop.title);
  return "";
}

function readPropertyText(props, keys) {
  const prop = firstDefined(props, keys);
  return readRichText(prop);
}

function readPropertySelect(props, keys) {
  const prop = firstDefined(props, keys);
  return readSelectName(prop);
}

function readPropertyDateRange(props, keys) {
  const prop = firstDefined(props, keys);
  return readDateRange(prop);
}

function parsePayloadJson(raw) {
  if (typeof raw !== "string") return { ok: false, value: null, error: "payload_not_string" };
  const text = raw.trim();
  if (!text) return { ok: false, value: null, error: "payload_empty" };
  try {
    return { ok: true, value: JSON.parse(text), error: null };
  } catch (e) {
    return { ok: false, value: null, error: e?.message ?? "payload_invalid_json" };
  }
}

function normalizeEmail(text) {
  const s = String(text || "").trim().toLowerCase();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase() : s;
}

function isWithinWindow({ start, end }, now = new Date()) {
  if (!(start instanceof Date) || isNaN(start.valueOf())) return false;
  if (end instanceof Date && !isNaN(end.valueOf())) {
    // User requirement: strict bounds (now > start && now < end).
    return now > start && now < end;
  }
  return now > start;
}

function resolveExecutionWindow(props) {
  // Preferred: Execute Window(start/end). Fallback: Trigger Time.
  // - If Trigger Time is a range (has `end`), use start/end.
  // - If Trigger Time is a single point (no `end`), use start + 10 minutes.
  const executeWindow = readPropertyDateRange(props, ["Execute Window", "execute_window", "executeWindow"]);
  if (executeWindow.start instanceof Date && !isNaN(executeWindow.start.valueOf())) {
    // If Execute Window has no end, treat it like a trigger point.
    if (executeWindow.end instanceof Date && !isNaN(executeWindow.end.valueOf())) {
      return executeWindow;
    }
    return { start: executeWindow.start, end: new Date(executeWindow.start.valueOf() + 10 * 60 * 1000) };
  }
  const trigger = readPropertyDateRange(props, ["Trigger Time", "trigger_time", "triggerTime"]);
  if (trigger.start instanceof Date && !isNaN(trigger.start.valueOf())) {
    if (trigger.end instanceof Date && !isNaN(trigger.end.valueOf())) {
      return trigger;
    }
    return { start: trigger.start, end: new Date(trigger.start.valueOf() + 10 * 60 * 1000) };
  }
  return { start: null, end: null };
}

function normalizePlannedEventType(v) {
  const s = (v ?? "").toString().trim();
  if (!s) return "";
  // Keep exact values expected by the Queue select options.
  // Allowed (per clarified MVP/all-actions scope): Send, Open, Reply, Star, Add Contact
  return s;
}

function computeExternalEventId(taskId, plannedEventType) {
  return `exec-${taskId}-${plannedEventType}`.replace(/\s+/g, "_");
}

function parseQueueRow(page) {
  const props = page?.properties ?? {};

  const actionText = readPropertyText(props, ["Action", "action"]);
  const status = readPropertySelect(props, ["Status", "status"]);
  const replyStatus = readPropertySelect(props, ["Reply Status", "reply_status", "replyStatus"]);
  const platform = readPropertySelect(props, ["Platform", "platform"]);
  const inNOut = readPropertySelect(props, ["InNOut", "in_n_out", "inNOut"]);
  const executeWindow = resolveExecutionWindow(props);
  const completionTime = readPropertyDateRange(props, ["Completion Time", "completion_time", "completionTime"]).start;
  const fcAccount = normalizeEmail(readPropertyText(props, ["FCAccount", "fc_account", "actor_mailbox_id", "Account"]));
  const payloadText = readPropertyText(props, ["Payload", "payload"]);
  const payloadJson = parsePayloadJson(payloadText);
  const payload = payloadJson.ok ? payloadJson.value : null;

  const plannedEventType = normalizePlannedEventType(actionText);
  const actorEmail = fcAccount;
  const counterpartyEmail = payload?.to_email || payload?.to || "";
  const fromEmail = normalizeEmail(payload?.from_email || actorEmail || "");
  const subject = payload?.subject || "";
  const body = payload?.body || "";
  const replyToHeaderMessageId = payload?.headerMessageId || payload?.replyToHeaderMessageId || "";
  const taskId = readPropertyText(props, ["Task ID", "task_id", "taskId"]) || String(page?.id || "");
  const dependsOnTaskId = readPropertyText(props, ["depends_on_task_id", "dependsOnTaskId"]);
  const externalEventId = readPropertyText(props, ["external_event_id", "External Event Id", "External Event ID"]);

  return {
    pageId: page?.id,
    raw: page,
    platform,
    inNOut,
    actionText,
    plannedEventType,
    status,
    replyStatus,
    executeWindow,
    completionTime,
    fcAccount,
    payloadText,
    payload,
    payloadParseError: payloadJson.error,
    actorEmail,
    counterpartyEmail,
    fromEmail: fromEmail || counterpartyEmail,
    subject,
    body,
    replyToHeaderMessageId,
    taskId,
    dependsOnTaskId,
    externalEventId,
  };
}

module.exports = {
  parseQueueRow,
  isWithinWindow,
  computeExternalEventId,
};

