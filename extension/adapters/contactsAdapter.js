/**
 * Adapter: addressBooks.list, contacts.query, contacts.create (vCard).
 * addressBooks.list() returns array of AddressBookNode; contacts.query returns array of ContactNode.
 */

const browser = globalThis.browser ?? globalThis.messenger;

export async function listAddressBooks() {
  const list = await browser.addressBooks.list();
  return Array.isArray(list) ? list : [];
}

export async function findContactByEmail(parentId, email) {
  const contacts = await browser.addressBooks.contacts.list(parentId);
  if (!Array.isArray(contacts)) return null;
  const normalized = (email || "").toLowerCase().trim();
  return contacts.find((c) => {
    const v = c?.vCard ?? "";
    const match = v.match(/EMAIL[^:]*:(.+)/i);
    const em = (match?.[1] ?? "").toLowerCase().trim();
    return em === normalized;
  }) ?? null;
}

/**
 * Build minimal vCard 3.0 for create. No 3rd party lib; minimal fields only.
 */
export function buildVCard(fields) {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  if (fields.email) lines.push(`EMAIL:${fields.email}`);
  if (fields.displayName || fields.name) lines.push(`FN:${fields.displayName || fields.name || fields.email || ""}`);
  if (fields.displayName || fields.name) lines.push(`N:${(fields.displayName || fields.name || "").replace(/;/g, " ")};;;;`);
  if (fields.company) lines.push(`ORG:${fields.company}`);
  if (fields.phone) lines.push(`TEL:${fields.phone}`);
  if (fields.note) lines.push(`NOTE:${fields.note}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

export async function createContact(parentId, vCard) {
  const id = await browser.addressBooks.contacts.create(parentId, vCard);
  return id;
}
