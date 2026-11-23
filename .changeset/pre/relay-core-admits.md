---
"mipi": minor
---

COD-180 (M7 slice 1, part of COD-155): the agent side of the PiDu relay. There is no HTTP route yet; slice 2 (COD-181) adds `POST /api/relay` and `GET /api/relay/:key`.

**Added**

- `src/lib/fence.ts`, copied from Pi Pocket (`defang`, `attribute`, `quoted`, `clip`). Relay text goes between `<relay from="pidu">` tags it can't close. This includes closing tags with spaces, invisible characters or line breaks before the `/`.
- `relayRequest(key)`: request id `relay:<key>`. A key must be 1 to 64 letters, digits, `-` or `_`. Any other key is rejected, never cleaned, so two keys can't become one.
- The Durable Object's `relayAdmit(key, text)` and `relayResult(key)`. A message goes to the `relay:pidu` conversation, which runs on the `pidu` profile. It is stamped `[PiDu · time]`, and `relayAdmit` waits up to 25 seconds for the answer.
- Results: `done` with the answer, `pending`, `unanswered` with a reason, `conflict` (the same key with another text, checked by SHA-256), `limited` with seconds to wait, `invalid`, `too-large` (over 16,384 UTF-8 bytes), `not-found`, or `unavailable`.
- A cap of 60 messages per sliding hour. A duplicate key or a conflict uses no slot.
- The `app.relay` document keeps the key receipts and the hour's admission times. Up to 2,000 receipts are kept, and a receipt whose input is still open is never dropped. If a key's receipt was dropped but its input is still stored, the key gets that input's result, never a conflict.

**Pi Durable**

- No version change (1.6.0). No ledger changes.

**Migration**

- None. `app.relay` is a new document.
