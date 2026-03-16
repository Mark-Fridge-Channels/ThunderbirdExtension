/**
 * switch_account_context: set execution context by account selector, return accountId, identityId, folders.
 */

import * as state from "../background/state.js";
import { resolveAccountBySelector, getAccountWithFolders } from "../adapters/accountsAdapter.js";

export async function handleSwitchAccount({ requestId, payload, context }) {
  const selector = payload.accountId ?? payload.email ?? payload.identityId;
  const { account, identity, accountId, identityId } = await resolveAccountBySelector(selector);
  if (!account) {
    return {
      success: false,
      error: { code: "NOT_FOUND", message: "Account or identity not found", details: { selector } },
    };
  }
  state.setContext(accountId, identityId);
  const accountInfo = await getAccountWithFolders(accountId);
  return {
    success: true,
    result: {
      accountId,
      identityId: identityId ?? null,
      accountName: account.name,
      identityEmail: identity?.email ?? null,
      folders: accountInfo?.folders ?? [],
      stableIdentifiers: { accountId, identityId },
    },
  };
}
