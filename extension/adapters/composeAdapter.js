/**
 * Adapter: compose.beginNew, setComposeDetails, sendMessage.
 * Uses identityId in ComposeDetails; sendMessage returns { messages, mode, headerMessageId } (TB 102).
 */

const browser = globalThis.browser ?? globalThis.messenger;

export async function createAndSend(details, options = {}) {
  const tab = await browser.compose.beginNew(undefined, {
    identityId: details.identityId,
    to: details.to,
    cc: details.cc,
    bcc: details.bcc,
    subject: details.subject ?? "",
    body: details.body,
    plainTextBody: details.plainTextBody,
    isPlainText: details.isPlainText ?? false,
  });
  if (!tab?.id) throw new Error("Failed to open compose window");
  const tabId = tab.id;

  if (details.attachments?.length) {
    for (const att of details.attachments) {
      if (att?.file) await browser.compose.addAttachment(tabId, { file: att.file, name: att.name });
    }
  }

  if (options.dry_run) {
    return { dry_run: true, tabId, headerMessageId: null };
  }

  const sendResult = await browser.compose.sendMessage(tabId, { mode: "sendNow" });
  const messages = sendResult?.messages;
  const first = Array.isArray(messages) ? messages[0] : null;
  const headerMessageId = sendResult?.headerMessageId ?? first?.headerMessageId ?? null;
  return {
    headerMessageId,
    mode: sendResult?.mode ?? "sendNow",
    messages: messages ?? [],
  };
}

/**
 * Reply to a message: beginReply, set body if provided, sendMessage.
 */
export async function replyToMessage(messageId, details, options = {}) {
  const replyType = details.replyType ?? "replyToSender";
  const tab = await browser.compose.beginReply(messageId, replyType, {
    identityId: details.identityId,
    plainTextBody: details.plainTextBody ?? details.body,
    isPlainText: details.isPlainText ?? true,
  });
  if (!tab?.id) throw new Error("Failed to open reply compose window");
  const tabId = tab.id;
  if (details.plainTextBody ?? details.body) {
    await browser.compose.setComposeDetails(tabId, {
      plainTextBody: details.plainTextBody ?? details.body,
      isPlainText: details.isPlainText ?? true,
    });
  }
  if (options.dry_run) {
    return { dry_run: true, tabId };
  }
  const sendResult = await browser.compose.sendMessage(tabId, { mode: "sendNow" });
  const messages = sendResult?.messages ?? [];
  return {
    headerMessageId: sendResult?.headerMessageId ?? messages[0]?.headerMessageId,
    mode: sendResult?.mode ?? "sendNow",
    messages,
  };
}

export async function forwardMessage(messageId, details, options = {}) {
  const forwardType = details.forwardInline ? "forwardInline" : "forwardAsAttachment";
  const tab = await browser.compose.beginForward(messageId, forwardType, {
    identityId: details.identityId,
    to: details.to,
    cc: details.cc,
    bcc: details.bcc,
    subject: details.subject,
    body: details.body,
    plainTextBody: details.plainTextBody,
    isPlainText: details.isPlainText ?? false,
  });
  if (!tab?.id) throw new Error("Failed to open forward compose window");
  const tabId = tab.id;
  if (details.extraBody) {
    const current = await browser.compose.getComposeDetails(tabId);
    const newBody = (current?.body ?? "") + details.extraBody;
    await browser.compose.setComposeDetails(tabId, { body: newBody });
  }
  if (options.dry_run) {
    return { dry_run: true, tabId };
  }
  const sendResult = await browser.compose.sendMessage(tabId, { mode: "sendNow" });
  const messages = sendResult?.messages ?? [];
  return {
    headerMessageId: sendResult?.headerMessageId ?? messages[0]?.headerMessageId,
    mode: sendResult?.mode ?? "sendNow",
    messages,
  };
}
