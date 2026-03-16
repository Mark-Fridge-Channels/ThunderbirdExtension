/**
 * Simple logger; can be extended to write to storage for audit.
 */

const PREFIX = "[MailAutomation]";

export function log(...args) {
  console.log(PREFIX, ...args);
}

export function warn(...args) {
  console.warn(PREFIX, ...args);
}

export function error(...args) {
  console.error(PREFIX, ...args);
}

/** Audit: log send_email / add_contact etc. for later inspection. */
export async function auditLog(action, requestId, success, details = {}) {
  log("audit", action, requestId, success, details);
  try {
    const browser = globalThis.browser ?? globalThis.messenger;
    const key = "auditLog";
    const existing = await browser.storage.local.get(key);
    const list = existing[key] || [];
    list.push({
      action,
      request_id: requestId,
      success,
      ts: new Date().toISOString(),
      ...details,
    });
    if (list.length > 500) list.splice(0, list.length - 400);
    await browser.storage.local.set({ [key]: list });
  } catch (e) {
    warn("audit log write failed", e);
  }
}
