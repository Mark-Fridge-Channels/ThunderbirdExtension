"use strict";

/**
 * Experiment: nsIMsgFolder.getNewMessages on each account Inbox (aligned with client shortcuts).
 */

(function (exports) {
  const fetchFolderMessages = (folder) =>
    new Promise((resolve, reject) => {
      const listener = {
        QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
        OnStartRunningUrl() {},
        OnStopRunningUrl(url, exitCode) {
          resolve({ exitCode });
        },
      };
      try {
        const domWindow = Services.wm.getMostRecentWindow("mail:3pane");
        const msgWindow =
          domWindow && domWindow.msgWindow != null ? domWindow.msgWindow : null;
        folder.getNewMessages(msgWindow, listener);
      } catch (e) {
        reject(e);
      }
    });

  function inboxFolderForAccount(account) {
    if (!account?.incomingServer?.rootFolder) {
      return null;
    }
    const root = account.incomingServer.rootFolder;
    return root.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox);
  }

  function displayedFolderFrom3Pane(domWindow) {
    if (!domWindow) {
      return null;
    }
    if (domWindow.gFolderDisplay?.displayedFolder) {
      return domWindow.gFolderDisplay.displayedFolder;
    }
    if (typeof domWindow.GetSelectedMsgFolders === "function") {
      const sel = domWindow.GetSelectedMsgFolders();
      if (sel && sel.length) {
        return sel[0];
      }
    }
    return null;
  }

  var receiver = class extends ExtensionCommon.ExtensionAPI {
    getAPI(_context) {
      return {
        receiver: {
          async fetchCurrentAccount() {
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs"
            );
            const domWindow = Services.wm.getMostRecentWindow("mail:3pane");
            const folder = displayedFolderFrom3Pane(domWindow);
            if (!folder?.server) {
              throw new Error("No folder selected in mail 3-pane");
            }
            const account = MailServices.accounts.findAccountForServer(folder.server);
            if (!account) {
              throw new Error("No account for selected folder");
            }
            const inbox = inboxFolderForAccount(account);
            if (!inbox) {
              throw new Error(`No Inbox for account: ${account.key}`);
            }
            return { accountId: account.key, ...(await fetchFolderMessages(inbox)) };
          },

          async fetchAccount(accountId) {
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs"
            );
            const account = MailServices.accounts.getAccount(accountId);
            if (!account) {
              throw new Error(`Unknown account: ${accountId}`);
            }
            const inbox = inboxFolderForAccount(account);
            if (!inbox) {
              throw new Error(`No Inbox for account: ${accountId}`);
            }
            return fetchFolderMessages(inbox);
          },

          async fetchAllAccounts() {
            const { MailServices } = ChromeUtils.importESModule(
              "resource:///modules/MailServices.sys.mjs"
            );
            const results = [];
            for (const account of MailServices.accounts.accounts) {
              if (!account?.incomingServer) {
                continue;
              }
              const inbox = inboxFolderForAccount(account);
              if (inbox) {
                results.push({
                  accountId: account.key,
                  ...(await fetchFolderMessages(inbox)),
                });
              }
            }
            return { accounts: results };
          },
        },
      };
    }

    onShutdown(isAppShutdown) {
      if (isAppShutdown) {
        return;
      }
      Services.obs.notifyObservers(null, "startupcache-invalidate");
    }
  };

  exports.receiver = receiver;
})(this);
