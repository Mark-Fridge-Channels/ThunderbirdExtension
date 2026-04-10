/**
 * Persisted dedupe keys for inbound rows (FCAccount|headerMessageId or FCAccount|messageId).
 * Shared by executor inbound polling and TB Active Receiver webhook so the same mail is not inserted twice.
 */

const fs = require("fs");
const path = require("path");

const MAX_KEYS = 50000;

function getDedupeFilePath(cfg) {
  const rel = String(cfg?.executor?.inboundDedupePath || "inbound-dedupe-keys.json").trim() || "inbound-dedupe-keys.json";
  return path.isAbsolute(rel) ? rel : path.join(__dirname, rel);
}

function loadKeySet(cfg) {
  const filePath = getDedupeFilePath(cfg);
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const j = JSON.parse(raw);
    const keys = Array.isArray(j.keys) ? j.keys : [];
    return { filePath, keys: new Set(keys.map((k) => String(k))) };
  } catch (_) {
    return { filePath: getDedupeFilePath(cfg), keys: new Set() };
  }
}

function saveKeySet(filePath, set) {
  let keys = Array.from(set);
  if (keys.length > MAX_KEYS) {
    keys = keys.slice(keys.length - MAX_KEYS);
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), keys }, null, 2), "utf8");
}

/** Add keys from disk into an existing Set (mutates). */
function mergeDedupeKeysInto(cfg, targetSet) {
  const { keys } = loadKeySet(cfg);
  for (const k of keys) {
    targetSet.add(k);
  }
}

/** Returns true if key was already present (still call add after successful create to sync). */
function hasDedupeKey(cfg, key) {
  if (!key) return false;
  const { keys } = loadKeySet(cfg);
  return keys.has(String(key));
}

function addDedupeKey(cfg, key) {
  if (!key) return;
  const { filePath, keys } = loadKeySet(cfg);
  keys.add(String(key));
  saveKeySet(filePath, keys);
}

module.exports = {
  mergeDedupeKeysInto,
  hasDedupeKey,
  addDedupeKey,
};
