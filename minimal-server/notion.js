/**
 * Minimal Notion API client (no external deps).
 *
 * We only implement what's needed for Warmup Executor:
 * - POST /v1/databases/{database_id}/query
 * - PATCH /v1/pages/{page_id}
 * - POST /v1/pages
 *
 * Notion API docs: https://developers.notion.com/reference/intro
 */

const NOTION_API_BASE = "https://api.notion.com/v1";

function notionHeaders({ token, notionVersion }) {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": notionVersion,
    "Content-Type": "application/json",
  };
}

async function notionFetch(cfg, method, path, body) {
  const url = `${NOTION_API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: notionHeaders(cfg),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const code = data?.code != null ? String(data.code) : "";
    const msg = data?.message || data?.error || `Notion API error: HTTP ${res.status}`;
    const combined = code ? `[${code}] ${msg}` : msg;
    const err = new Error(combined);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

async function queryDatabase(cfg, databaseId, { pageSize = 20, sorts = [], filter = undefined, startCursor = undefined } = {}) {
  const body = {
    page_size: pageSize,
  };
  if (sorts?.length) body.sorts = sorts;
  if (filter) body.filter = filter;
  if (startCursor) body.start_cursor = startCursor;
  return await notionFetch(cfg, "POST", `/databases/${databaseId}/query`, body);
}

async function updatePage(cfg, pageId, properties) {
  return await notionFetch(cfg, "PATCH", `/pages/${pageId}`, { properties });
}

async function createPage(cfg, databaseId, properties) {
  return await notionFetch(cfg, "POST", "/pages", {
    parent: { database_id: databaseId },
    properties,
  });
}

module.exports = { queryDatabase, updatePage, createPage };

