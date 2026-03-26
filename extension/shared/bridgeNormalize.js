/**
 * Normalized shapes for Bridge V1 responses (camelCase protocol).
 * Maps Thunderbird MailAccount / MailFolder / MessageHeader to stable JSON.
 */

export function normalizeFolder(f) {
  if (!f) return null;
  return {
    folderId: f.id,
    name: f.name ?? "",
    path: f.path ?? "",
    specialUse: Array.isArray(f.specialUse) ? [...f.specialUse] : [],
    isUnified: !!f.isUnified,
    isVirtual: !!f.isVirtual,
    subFolders: (f.subFolders || []).map((s) => normalizeFolder(s)),
  };
}

export function normalizeIdentity(identity, index) {
  if (!identity) return null;
  return {
    identityId: identity.id,
    email: identity.email ?? "",
    name: identity.name ?? "",
    label: identity.label ?? (index === 0 ? "default" : ""),
    composeHtml: !!identity.composeHtml,
    replyTo: identity.replyTo ?? null,
  };
}

export function normalizeAccount(acc) {
  if (!acc) return null;
  const identities = (acc.identities || []).map((idn, i) => normalizeIdentity(idn, i)).filter(Boolean);
  return {
    accountId: acc.id,
    name: acc.name ?? "",
    type: acc.type ?? "",
    identities,
    rootFolder: normalizeFolder(acc.rootFolder),
  };
}

export function normalizeFolderRef(folder) {
  if (!folder) return null;
  return {
    folderId: folder.id,
    name: folder.name ?? "",
    path: folder.path ?? "",
    specialUse: Array.isArray(folder.specialUse) ? [...folder.specialUse] : [],
  };
}

export function normalizeMessageHeader(m) {
  if (!m) return null;
  const date = m.date != null ? new Date(m.date) : null;
  return {
    messageId: m.id,
    headerMessageId: m.headerMessageId ?? null,
    author: m.author ?? "",
    subject: m.subject ?? "",
    date: date && !isNaN(date.valueOf()) ? date.toISOString() : null,
    read: !!m.read,
    flagged: !!m.flagged,
    junk: !!m.junk,
    folder: normalizeFolderRef(m.folder),
  };
}

export function normalizeSendResult(result) {
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  const first = messages[0] ?? null;
  const headerMessageId = result?.headerMessageId ?? first?.headerMessageId ?? null;
  const copies = messages.map((m) => {
    const d = m.date != null ? new Date(m.date) : null;
    return {
      messageId: m.id,
      headerMessageId: m.headerMessageId ?? null,
      subject: m.subject ?? "",
      date: d && !isNaN(d.valueOf()) ? d.toISOString() : null,
    };
  });
  return {
    mode: result?.mode ?? "sendNow",
    headerMessageId,
    copies,
  };
}
