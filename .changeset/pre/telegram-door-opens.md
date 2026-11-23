---
"mipi": minor
---

COD-152 (M5): Telegram inbound.

**Added**

- `POST /api/telegram`, Telegram's webhook. It is routed before the owner's web authentication. Its own secret (`X-Telegram-Bot-Api-Secret-Token`, compared in constant time) authenticates it, and the route refuses everything while `TELEGRAM_WEBHOOK_SECRET` is unset or invalid. Bodies are capped at 128 KiB while they are read. The route answers 401 for bad auth, 405 for a wrong method, 413 for an oversized body, 503 when the agent can't store the update (Telegram retries), and 200 otherwise.
- Only text in a private chat from an allowlisted sender (`TELEGRAM_ALLOWED_USER_IDS`) reaches the agent. A photo or other non-text message gets a short hint. Groups, edits, callbacks and strangers are acknowledged and dropped.
- Each chat has its own conversation (binding `tg:<chat_id>`), and its messages are stamped like every other door's. The webhook answers 200 only after the agent durably stored the update. A receipt per `update_id` (kept 48 hours, at most 2,000) makes a replay do nothing, also after `/new` or a restart. Inputs use request id `tg:<update_id>`, and the submit runs in the same commit as the receipt.
- Commands: `/start`, `/new`, `/version`, `/profile [name]`, `/model [id]`, also suffixed with this bot's username (`TELEGRAM_BOT_USERNAME`); commands addressed to other bots are ignored. None of them calls the model. `/model <id>` is recorded first and checked against the live model list after the webhook has answered.
- A durable outbox for everything sent to Telegram. Each chat sends first in, first out, one message per second. Long replies are split into messages of at most 4,096 UTF-16 units, never inside a grapheme. A 429's `retry_after` is honoured and 5xx errors back off (5 attempts). A permanent refusal (revoked token, blocked bot) ends that reply without waking again. A send cut off mid-request is recorded as `delivery-unknown`, never sent twice. After a failed or unknown chunk, the rest of that reply is skipped and the chat moves on.
- Each reply goes to the chat its message came from, even after `/new` rebinds the chat. An input that ends without an answer gets a short notice instead of silence. After a restart, answers not yet turned into replies and replies not yet sent are picked up again.
- The deploy workflow passes the Telegram secrets and variables to the Worker and registers the webhook after a healthy deploy (`scripts/telegram-webhook.ts`: `allowed_updates: ["message"]`, one connection).

**Changed**

- The one alarm also covers the Telegram outbox's next send, and keeps the recovery heartbeat while a Telegram input or command is waiting.

**Pi Durable**

- No version change (1.6.0). No ledger changes. Newly relied on, and covered in `test/contract.test.ts`: `Conversation.submit(tx, …)` after document reads and before document writes, `tx.submission`, `tx.submissionByRequest`, `tx.entry`, and `Harness.submission(id).wait`. The seam also re-exports the `SubmissionId` and `SubmissionRecord` types.

**Migration**

- None. Telegram stays off until a lane has `TELEGRAM_BOT_TOKEN`. To turn it on, see the README's Telegram section. The new session documents (`app.telegram`, `app.telegram-outbox`) need no migration.
