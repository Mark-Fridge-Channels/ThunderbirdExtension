/**
 * Adapter: messageDisplay.open to open a message in tab or window.
 * messageDisplay.open(openProperties) returns Tab.
 */

const browser = globalThis.browser ?? globalThis.messenger;

export async function openMessageByMessageId(messageId, location = "tab") {
  const tab = await browser.messageDisplay.open({
    messageId,
    location: location === "window" ? "window" : "tab",
    active: true,
  });
  return tab;
}

export async function openMessageByHeaderMessageId(headerMessageId, location = "tab") {
  const tab = await browser.messageDisplay.open({
    headerMessageId,
    location: location === "window" ? "window" : "tab",
    active: true,
  });
  return tab;
}
