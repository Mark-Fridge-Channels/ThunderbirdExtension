/**
 * Execution context state: current accountId / identityId.
 * Not persisted; in-memory only. Used by handlers that need "actor account".
 */

let currentAccountId = null;
let currentIdentityId = null;

export function getContext() {
  return { accountId: currentAccountId, identityId: currentIdentityId };
}

export function setContext(accountId, identityId) {
  currentAccountId = accountId;
  currentIdentityId = identityId;
}

export function clearContext() {
  currentAccountId = null;
  currentIdentityId = null;
}
