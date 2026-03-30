/**
 * Experiment façade: native Get New Messages.
 */

const browser = globalThis.browser ?? globalThis.messenger;

function assertReceiver() {
  if (!browser.receiver?.fetchAllAccounts) {
    throw new Error("receiver experiment not loaded");
  }
}

export async function fetchAllAccounts() {
  assertReceiver();
  return browser.receiver.fetchAllAccounts();
}

export async function fetchAccount(accountId) {
  assertReceiver();
  return browser.receiver.fetchAccount(accountId);
}

export async function fetchCurrentAccount() {
  assertReceiver();
  return browser.receiver.fetchCurrentAccount();
}
