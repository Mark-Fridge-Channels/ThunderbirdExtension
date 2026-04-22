/**
 * Email Timeline — inline database on an Entity page.
 *
 * For each Entity page we keep a single inline database named "Email Timeline".
 * Each row/card captures one email interaction:
 *   - Title (title)         — headline (e.g. subject or "[Reply] subject")
 *   - Date (date, datetime) — the email's timestamp, no end date
 *   - From (rich_text)      — sender email
 *   - To (rich_text)        — recipient email(s)
 *   - Subject (rich_text)   — original subject line
 *   - Body (rich_text)      — plain-text email body (truncated)
 *
 * Flow per Entity page:
 *   1. `listBlockChildren` to look for an existing `child_database` block whose
 *      title is "Email Timeline". If found, the block id IS the database id.
 *   2. Otherwise create an inline database with the above schema.
 *   3. `createPageInDatabase` to add a new card.
 *
 * Note on views: Notion's public REST API does not expose view creation.
 * The user can manually switch the inline database to a Timeline view in
 * Notion (timelineBy = "Date"). All properties needed for that view are
 * created by this module.
 */

const {
  listBlockChildren,
  createDatabase,
  createPageInDatabase,
  queryDatabase,
} = require("./notion.js");

const EMAIL_TIMELINE_DB_NAME = "Email Timeline";

/** pageId -> databaseId cache for the lifetime of the process (avoids repeated child block scans). */
const pageToTimelineDbIdCache = new Map();

function normalizeId(id) {
  return String(id || "").replace(/-/g, "").toLowerCase();
}

function titleEquals(blockTitleNodes, target) {
  if (!Array.isArray(blockTitleNodes)) return false;
  const joined = blockTitleNodes
    .map((t) => (typeof t?.plain_text === "string" ? t.plain_text : ""))
    .join("")
    .trim()
    .toLowerCase();
  return joined === String(target).trim().toLowerCase();
}

/**
 * Scan children blocks of `entityPageId` for a child_database titled "Email Timeline".
 * Returns the database id (same as the block id) or null.
 */
async function findEmailTimelineDatabaseId(cfg, entityPageId) {
  const notionCfg = cfg?.notion ? { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion } : cfg;
  const cacheKey = normalizeId(entityPageId);
  if (cacheKey && pageToTimelineDbIdCache.has(cacheKey)) {
    return pageToTimelineDbIdCache.get(cacheKey);
  }
  let cursor = undefined;
  while (true) {
    const page = await listBlockChildren(notionCfg, entityPageId, cursor);
    const children = Array.isArray(page?.results) ? page.results : [];
    for (const block of children) {
      if (block?.type !== "child_database") continue;
      const rawTitle = block?.child_database?.title;
      // `child_database.title` is a plain string in the Notion REST API.
      const plain = typeof rawTitle === "string" ? rawTitle : "";
      if (plain.trim().toLowerCase() === EMAIL_TIMELINE_DB_NAME.toLowerCase()) {
        if (cacheKey) pageToTimelineDbIdCache.set(cacheKey, block.id);
        return block.id;
      }
      // Defensive: some SDKs report title as rich_text[]; support both shapes.
      if (Array.isArray(rawTitle) && titleEquals(rawTitle, EMAIL_TIMELINE_DB_NAME)) {
        if (cacheKey) pageToTimelineDbIdCache.set(cacheKey, block.id);
        return block.id;
      }
    }
    if (!page?.has_more || !page?.next_cursor) break;
    cursor = page.next_cursor;
  }
  return null;
}

/**
 * Create the inline "Email Timeline" database on the given Entity page.
 * Returns the new database id.
 */
async function createEmailTimelineDatabase(cfg, entityPageId) {
  const notionCfg = cfg?.notion ? { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion } : cfg;
  const body = {
    parent: { type: "page_id", page_id: String(entityPageId) },
    is_inline: true,
    title: [
      { type: "text", text: { content: EMAIL_TIMELINE_DB_NAME } },
    ],
    properties: {
      Title: { title: {} },
      Date: { date: {} },
      From: { rich_text: {} },
      To: { rich_text: {} },
      Subject: { rich_text: {} },
      Body: { rich_text: {} },
    },
  };
  const db = await createDatabase(notionCfg, body);
  const dbId = db?.id || "";
  const cacheKey = normalizeId(entityPageId);
  if (cacheKey && dbId) pageToTimelineDbIdCache.set(cacheKey, dbId);
  return dbId;
}

/** find + create if missing. */
async function ensureEmailTimelineDatabase(cfg, entityPageId) {
  const existing = await findEmailTimelineDatabaseId(cfg, entityPageId);
  if (existing) return existing;
  return await createEmailTimelineDatabase(cfg, entityPageId);
}

function clampText(s, max) {
  const str = String(s == null ? "" : s);
  if (str.length <= max) return str;
  return str.slice(0, Math.max(0, max - 1)) + "…";
}

function richTextProp(value) {
  const trimmed = clampText(value, 1900);
  if (!trimmed) return { rich_text: [] };
  return {
    rich_text: [{ type: "text", text: { content: trimmed } }],
  };
}

function titleProp(value) {
  const trimmed = clampText(value, 1900);
  return {
    title: [{ type: "text", text: { content: trimmed || "(no subject)" } }],
  };
}

/** Build Notion date property for a JS Date/ISO string, with time, no end. */
function dateTimeProp(date) {
  let iso = "";
  if (date instanceof Date) {
    iso = date.toISOString();
  } else if (typeof date === "string" && date.trim()) {
    const d = new Date(date);
    iso = Number.isFinite(d.valueOf()) ? d.toISOString() : new Date().toISOString();
  } else {
    iso = new Date().toISOString();
  }
  return { date: { start: iso, end: null } };
}

function readRichTextPlain(prop) {
  if (!prop || prop.type !== "rich_text" || !Array.isArray(prop.rich_text)) return "";
  return prop.rich_text.map((r) => (typeof r?.plain_text === "string" ? r.plain_text : "")).join("");
}

function toSecondsEpoch(v) {
  if (v instanceof Date) {
    const n = v.valueOf();
    return Number.isFinite(n) ? Math.floor(n / 1000) : null;
  }
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    const n = d.valueOf();
    return Number.isFinite(n) ? Math.floor(n / 1000) : null;
  }
  return null;
}

/** Up to this many pages scanned before giving up on the dedup lookup. */
const DEDUP_MAX_SCAN = 200;

/**
 * Look for an existing card in the Email Timeline database whose
 * (From, To, Subject, Date) all match the new card. Returns the page id
 * of the first match, or null. Match is exhaustive but best-effort: Notion
 * filters narrow by Subject+From, final comparison is done in memory so we
 * are not sensitive to Notion's date-filter day granularity.
 *
 * The comparison is case-insensitive for From/To (emails), but exact for
 * Subject (the stored, possibly truncated form). Date matches at
 * one-second precision.
 */
async function findExistingTimelineCardId(cfg, databaseId, card) {
  const notionCfg = cfg?.notion ? { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion } : cfg;
  const subjectWanted = clampText(String(card?.subject || ""), 1900);
  const fromWantedRaw = String(card?.from || "").trim();
  const fromWantedLower = fromWantedRaw.toLowerCase();
  const toWantedLower = clampText(String(card?.to || "").trim(), 1900).toLowerCase();
  const targetSec = toSecondsEpoch(card?.date instanceof Date ? card.date : card?.date || null);

  const filterAnd = [];
  filterAnd.push(
    subjectWanted
      ? { property: "Subject", rich_text: { equals: subjectWanted } }
      : { property: "Subject", rich_text: { is_empty: true } }
  );
  filterAnd.push(
    fromWantedRaw
      ? { property: "From", rich_text: { equals: fromWantedRaw } }
      : { property: "From", rich_text: { is_empty: true } }
  );
  const filter = { and: filterAnd };

  let cursor;
  let scanned = 0;
  while (scanned < DEDUP_MAX_SCAN) {
    let page;
    try {
      page = await queryDatabase(notionCfg, databaseId, {
        pageSize: 50,
        filter,
        sorts: [{ property: "Date", direction: "descending" }],
        startCursor: cursor,
      });
    } catch (e) {
      // Notion may reject filters when the schema is missing/renamed. Re-throw so
      // the caller can decide to proceed with a create (best-effort dedup only).
      throw e;
    }
    const results = Array.isArray(page?.results) ? page.results : [];
    for (const p of results) {
      scanned += 1;
      const props = p?.properties || {};
      // From filter is case-sensitive in Notion; verify in-memory case-insensitively
      // to catch legacy rows written with different casing.
      const storedFrom = readRichTextPlain(props.From).trim().toLowerCase();
      if (fromWantedLower && storedFrom && storedFrom !== fromWantedLower) continue;
      const storedTo = readRichTextPlain(props.To).trim().toLowerCase();
      if (storedTo !== toWantedLower) continue;
      const storedDateStart = props?.Date?.type === "date" ? props.Date.date?.start : null;
      const storedSec = toSecondsEpoch(storedDateStart);
      if (targetSec != null && storedSec !== targetSec) continue;
      if (targetSec == null && storedSec != null) continue;
      return p?.id || null;
    }
    if (!page?.has_more || !page?.next_cursor) break;
    cursor = page.next_cursor;
  }
  return null;
}

/**
 * Create a card (page) in the Email Timeline database for an entity.
 *
 * Idempotent: if a card with the same (From, To, Subject, Date) already
 * exists on this Entity page's Email Timeline, no new row is created and
 * the existing row's id is returned with `skipped: true, reason:
 * "already_exists"`. This makes manual rescans (e.g. "Scan Sent Mail
 * (entire folder)") safe to re-run without generating duplicate cards.
 *
 * @param {object} cfg minimal-server config (must expose .notion)
 * @param {string} entityPageId Notion page id of the Entity
 * @param {object} card
 * @param {string} card.title      Display title (e.g. subject, or "[Reply] subject")
 * @param {Date|string} card.date  Email timestamp (datetime)
 * @param {string} card.from       Sender email
 * @param {string} card.to         Recipient email(s) joined by comma
 * @param {string} card.subject    Subject line
 * @param {string} card.body       Plain-text body (will be truncated)
 * @returns {Promise<{databaseId: string, pageId: string, skipped?: boolean, reason?: string}>}
 */
async function createEmailTimelineCard(cfg, entityPageId, card) {
  const notionCfg = cfg?.notion ? { token: cfg.notion.token, notionVersion: cfg.notion.notionVersion } : cfg;
  const entityId = String(entityPageId || "").trim();
  if (!entityId) throw new Error("createEmailTimelineCard: entityPageId required");

  // If the inline database already exists, look for a matching row before
  // creating. A brand-new database cannot contain a duplicate, so in that
  // case we fall through straight to create.
  const existingDbId = await findEmailTimelineDatabaseId(notionCfg, entityId);
  if (existingDbId) {
    try {
      const dupPageId = await findExistingTimelineCardId(notionCfg, existingDbId, card);
      if (dupPageId) {
        return {
          databaseId: existingDbId,
          pageId: dupPageId,
          skipped: true,
          reason: "already_exists",
        };
      }
    } catch (e) {
      // Best-effort dedup only; do not block inserts when the lookup fails.
      console.error("[emailTimeline] dedup query failed, proceeding to create", {
        entityPageId: entityId,
        databaseId: existingDbId,
        error: e?.message ?? String(e),
      });
    }
  }

  const databaseId = existingDbId || (await createEmailTimelineDatabase(notionCfg, entityId));
  if (!databaseId) throw new Error("ensureEmailTimelineDatabase: no database id returned");
  const bodyText = clampText(card?.body || "", 1900);
  const properties = {
    Title: titleProp(card?.title || card?.subject || ""),
    Date: dateTimeProp(card?.date),
    From: richTextProp(card?.from || ""),
    To: richTextProp(card?.to || ""),
    Subject: richTextProp(card?.subject || ""),
    Body: richTextProp(bodyText),
  };
  const created = await createPageInDatabase(notionCfg, databaseId, properties);
  return { databaseId, pageId: created?.id || "" };
}

/** Exposed for tests/tools that want to purge cache between runs. */
function clearEmailTimelineCache() {
  pageToTimelineDbIdCache.clear();
}

module.exports = {
  EMAIL_TIMELINE_DB_NAME,
  findEmailTimelineDatabaseId,
  findExistingTimelineCardId,
  createEmailTimelineDatabase,
  ensureEmailTimelineDatabase,
  createEmailTimelineCard,
  clearEmailTimelineCache,
};
