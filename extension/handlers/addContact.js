/**
 * add_contact: create contact with vCard; check duplicate by email first.
 */

import { listAddressBooks, findContactByEmail, buildVCard, createContact } from "../adapters/contactsAdapter.js";
import { makeError, CODES } from "../shared/errors.js";

export async function handleAddContact({ payload }) {
  const parentId = payload.addressBookId ?? payload.parentId;
  const email = (payload.email ?? "").trim().toLowerCase();
  if (!email) {
    return {
      success: false,
      error: makeError(CODES.VALIDATION, "email required"),
    };
  }

  const existing = await findContactByEmail(parentId, email);
  if (existing) {
    return {
      success: true,
      result: {
        contactId: existing.id,
        parentId,
        duplicate: true,
        stableIdentifiers: { contactId: existing.id, email },
      },
    };
  }

  const vCard = buildVCard({
    email: payload.email,
    displayName: payload.displayName ?? payload.name,
    name: payload.displayName ?? payload.name,
    company: payload.company,
    phone: payload.phone,
    note: payload.note,
  });
  const contactId = await createContact(parentId, vCard);
  return {
    success: true,
    result: {
      contactId,
      parentId,
      duplicate: false,
      stableIdentifiers: { contactId, email },
    },
  };
}
