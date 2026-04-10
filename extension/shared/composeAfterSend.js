/**
 * Track compose.onAfterSend by tabId so handlers can wait for the final send outcome.
 */
const browser = globalThis.browser ?? globalThis.messenger;

const pendingByTabId = new Map();
let listenerInstalled = false;

function cloneSendInfo(sendInfo) {
  if (!sendInfo || typeof sendInfo !== "object") return {};
  return {
    mode: sendInfo.mode,
    error: typeof sendInfo.error === "string" ? sendInfo.error : undefined,
    headerMessageId: sendInfo.headerMessageId,
    messages: Array.isArray(sendInfo.messages) ? sendInfo.messages : [],
  };
}

function ensureListener() {
  if (listenerInstalled) return;
  listenerInstalled = true;
  browser.compose.onAfterSend.addListener((tab, sendInfo) => {
    const tabId = Number(tab?.id);
    if (!Number.isInteger(tabId)) return;
    const pending = pendingByTabId.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingByTabId.delete(tabId);
    pending.resolve(cloneSendInfo(sendInfo));
  });
}

export function waitForAfterSend(tabId, timeoutMs = 90000) {
  ensureListener();
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId)) {
    return Promise.reject(new Error("invalid compose tab id"));
  }
  if (pendingByTabId.has(numericTabId)) {
    return Promise.reject(new Error("duplicate compose wait for tab id"));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingByTabId.delete(numericTabId);
      reject(new Error(`compose.onAfterSend timeout for tab ${numericTabId}`));
    }, timeoutMs);
    pendingByTabId.set(numericTabId, { resolve, reject, timeout });
  });
}

export function cancelAfterSendWait(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId)) return;
  const pending = pendingByTabId.get(numericTabId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingByTabId.delete(numericTabId);
}
