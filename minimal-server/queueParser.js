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

/** Notion `formula` property: string / number / boolean / date variants — we only need display text for Task ID-style formulas. */
function readFormulaAsText(prop) {
  if (prop?.type !== "formula" || !prop.formula) return "";
  const f = prop.formula;
  if (f.type === "string") return String(f.string ?? "").trim();
  if (f.type === "number" && f.number != null) return String(f.number).trim();
  if (f.type === "boolean") return f.boolean ? "true" : "false";
  if (f.type === "date" && f.date?.start) return String(f.date.start).trim();
  return "";
}

function readRelationFirstId(prop) {
  if (prop?.type !== "relation" || !Array.isArray(prop.relation)) return "";
  const first = prop.relation[0];
  const id = first?.id;
  return id ? String(id).trim() : "";
}

function readEmailValue(prop) {
  if (prop?.type === "email" && prop.email) return String(prop.email).trim();
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

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHttpHref(url) {
  const u = String(url || "").trim();
  return /^https?:\/\//i.test(u) ? u : "";
}

/**
 * Notion stores hyperlinks in rich_text runs as text.link.url, not in plain_text.
 * concatPlainText() alone loses links; this preserves them as HTML for compose (html body).
 */
function richTextPropertyToHtml(prop) {
  if (prop?.type !== "rich_text" || !Array.isArray(prop.rich_text)) return "";
  let out = "";
  for (const rt of prop.rich_text) {
    const content = rt?.plain_text ?? "";
    const url = sanitizeHttpHref(rt?.text?.link?.url ?? rt?.href ?? "");
    let fragment = escapeHtml(content).replace(/\n/g, "<br>");
    if (url) {
      fragment = `<a href="${escapeHtml(url)}">${fragment}</a>`;
    }
    if (rt?.annotations?.code) {
      fragment = `<code>${fragment}</code>`;
    }
    if (rt?.annotations?.bold) {
      fragment = `<strong>${fragment}</strong>`;
    }
    if (rt?.annotations?.italic) {
      fragment = `<em>${fragment}</em>`;
    }
    if (rt?.annotations?.strikethrough) {
      fragment = `<s>${fragment}</s>`;
    }
    if (rt?.annotations?.underline) {
      fragment = `<u>${fragment}</u>`;
    }
    out += fragment;
  }
  return out;
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

  const actionText = readPropertySelect(props, ["Action", "action"]) || readPropertyText(props, ["Action", "action"]);
  const status = readPropertySelect(props, [
    "OutReach Status",
    "out_reach_status",
    "outReachStatus",
    "Status",
    "status",
  ]);
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
  const subjectCol = readPropertyText(props, [
    "Outreach Subject",
    "outreach_subject",
    "outreachSubject",
    "Subject",
    "subject",
  ]);
  const bodyProp = firstDefined(props, [
    "Outreach Body",
    "outreach_body",
    "outreachBody",
    "Body",
    "body",
  ]);
  const subject = firstNonEmpty(subjectCol, payload?.subject);

  let body = "";
  /** When set to "html", body was built from Notion rich_text (includes <a> for links). */
  let bodySourceFormat = undefined;
  if (bodyProp?.type === "rich_text") {
    body = richTextPropertyToHtml(bodyProp);
    bodySourceFormat = "html";
  } else {
    body = firstNonEmpty(readRichText(bodyProp), payload?.body);
  }
  const keyPersonPageId = readRelationFirstId(firstDefined(props, ["KeyPerson ID", "key_person_id", "keyPersonId"]));

  const taskIdProp = firstDefined(props, ["Task ID", "task_id", "taskId"]);
  let taskIdFromCol = "";
  if (taskIdProp?.type === "formula") taskIdFromCol = readFormulaAsText(taskIdProp);
  else if (taskIdProp) taskIdFromCol = readRichText(taskIdProp);
  const taskId = firstNonEmpty(taskIdFromCol, String(page?.id || ""));

  const dependsOnTaskId = readPropertyText(props, ["depends_on_task_id", "dependsOnTaskId"]);
  const externalEventId = readPropertyText(props, ["external_event_id", "External Event Id", "External Event ID"]);

  const counterpartyEmail = normalizeEmail(payload?.to_email || payload?.to || "");

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
    keyPersonPageId,
    fromEmail: actorEmail,
    subject,
    body,
    bodySourceFormat,
    replyToHeaderMessageId: payload?.headerMessageId || payload?.replyToHeaderMessageId || "",
    taskId,
    dependsOnTaskId,
    externalEventId,
  };
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

module.exports = {
  parseQueueRow,
  isWithinWindow,
  computeExternalEventId,
  readSelectName,
  readEmailValue,
  richTextPropertyToHtml,
};

