---
"mipi": minor
---

**Added**

- Vault in the web app for adding, editing, rotating and deleting bot secrets, reviewing grants and audit entries, and generating a lane key in the browser.
- Owner-only, same-origin Vault routes. Responses carry metadata and audit records, and are marked no-store.

**Changed**

- A locked vault supports metadata changes, grant revocation and deletion. Adding secrets and replacing values require the lane key.

**Fixed**

- The Vault space keeps the chat composer out of the secret management screen.

**Pi Durable**

- Uses the existing vault storage and adds no ledger entry.

**Migration**

- Set the existing `MIPI_VAULT_KEY` for each lane to unlock bot secret values. Existing vault rows and their audit history keep their IDs.
