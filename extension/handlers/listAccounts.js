/**
 * Bridge V1: listAccounts — wraps accounts.list(includeSubFolders).
 */

import { normalizeAccount } from "../shared/bridgeNormalize.js";
import { makeError, CODES } from "../shared/errors.js";

const browser = globalThis.browser ?? globalThis.messenger;

export async function handleListAccounts({ payload }) {
  const includeSubFolders = payload.includeSubFolders !== false;
  try {
    const raw = await browser.accounts.list(includeSubFolders);
    const list = Array.isArray(raw) ? raw : [];
    return {
      success: true,
      result: { accounts: list.map((a) => normalizeAccount(a)).filter(Boolean) },
    };
  } catch (e) {
    return {
      success: false,
      error: makeError(CODES.API_ERROR, e?.message ?? String(e)),
    };
  }
}
