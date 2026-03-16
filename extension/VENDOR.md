# Third-party libraries

This extension does **not** use any third-party JavaScript libraries in the first phase.

- **vCard** for `add_contact`: built with minimal string concatenation (see `adapters/contactsAdapter.js`). For full vCard parsing/editing, the [vCard guide](https://webextension-api.thunderbird.net/en/mv3/guides/vcard.html) recommends using the ical.js library; if we add it later, the exact version and URL will be listed here.
