---
"mipi": minor
---

COD-181 (M7 slice 2, closes COD-155): the PiDu relay's HTTP door.

**Added**

- `POST /api/relay` needs `Authorization: Bearer <RELAY_TOKEN>`, an `Idempotency-Key` header (1 to 64 letters, digits, `-` or `_`) and `{ "text": "…" }`. It waits up to 25 seconds for the answer:
  - `200 {id, status: "done", answer}` when the answer is ready.
  - `202 {id, status: "pending"}` when it isn't, with `Location: /api/relay/<key>`.
  - `200 {id, status: "unanswered", reason}` when the turn ends without an answer.
- `GET /api/relay/<key>` reads a key's result with the same token. A key that isn't valid gets 404 without the agent being asked.
- Errors:
  - `400`: a bad key, a body that isn't JSON, or empty text.
  - `401`: a wrong or missing token, or the relay is off.
  - `404`: an unknown key.
  - `405`: the wrong method.
  - `409`: the same key with another text.
  - `413`: a body or text over the limit.
  - `429`: over 60 an hour, with `Retry-After`.
  - `503`: maintenance or the agent can't be reached, with `Retry-After`.
- The new secret `RELAY_TOKEN` is set per lane (24+ characters). Without it the relay is off. `RELAY_TOKEN_PREVIOUS` is also accepted while the token is rotated. The deploy workflow passes both, and writes `off` for an unset one. Wrangler's `--secrets-file` keeps secrets that are left out, so this is how removing a token takes effect.
- README: a PiDu relay section with the GitHub and Cloudflare Access steps.

**Changed**

- The Telegram webhook's bounded body reader moved to `src/worker/body.ts`, which the relay uses too.

**Pi Durable**

- No version change (1.6.0). No ledger changes.

**Migration**

- None. To turn the relay on for a lane: add `RELAY_TOKEN` to its GitHub Environment, add the Access Bypass application for path `api/relay`, then deploy.
