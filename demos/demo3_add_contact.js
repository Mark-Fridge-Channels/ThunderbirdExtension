/**
 * Demo 3: Add a contact to an address book. Uses first writable address book if not specified.
 * Prereq: Get addressBookId from switch_account_context or addressBooks.list (not in this demo).
 *
 * node demos/demo3_add_contact.js
 */

const BASE = "http://127.0.0.1:3939";

async function run() {
  const requestId = `demo3-${Date.now()}`;
  const addressBookId = process.env.ADDRESS_BOOK_ID || "you-must-set-ADDRESS_BOOK_ID";
  const payload = {
    request_id: requestId,
    action: "add_contact",
    payload: {
      addressBookId,
      email: process.env.CONTACT_EMAIL || "newcontact@example.com",
      displayName: process.env.CONTACT_NAME || "Demo Contact",
      company: process.env.CONTACT_COMPANY || "Demo Co",
      note: "Added by demo3_add_contact.js",
    },
  };
  const res = await fetch(`${BASE}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  console.log("add_contact:", JSON.stringify(data, null, 2));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
