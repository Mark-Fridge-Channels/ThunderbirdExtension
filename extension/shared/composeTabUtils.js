/**
 * Best-effort close of a compose tab (e.g. after failed or timed-out send).
 */

const browser = globalThis.browser ?? globalThis.messenger;

export async function closeComposeTabSafely(tabId) {
  if (tabId == null || !Number.isFinite(Number(tabId))) return;
  try {
    await browser.tabs.remove(Number(tabId));
  } catch (_) {
    // Tab may already be gone after successful send — ignore.
  }
}
