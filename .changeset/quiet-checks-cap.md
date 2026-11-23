---
"mipi": minor
---

COD-153 (M6, part 3): proactive runs. A scheduled check can stay quiet, knows what it sent lately, and has a daily cap.

**Added**

- `NO_SEND`: a reminder's run that finds nothing worth saying answers `NO_SEND`, and Telegram sends nothing. It counts only as the whole visible answer (after any `<think>` block). A failed tool still sends a notice, and a run that also answered a message is never quiet: the message gets a fallback instead of `NO_SEND`.
- Provenance (`app.proactive`): an `onYield` hook task records which inputs each answer covers, and Telegram inputs and reminders are reconciled together, one judgement per answer.
- Recent sends: the last 10 confirmed reminder messages, shown to the next reminder in its notes so it doesn't repeat itself. They live in the session, so they survive `/new`.
- Daily cap on model rounds for scheduled runs: `MIPI_DAILY_RUN_CAP` (new var, default `50`, `0` pauses them; an invalid value is reported and the default used), per Chicago day. Interactive chat never counts. At the cap a run stops with one notice a day; a one-time Telegram reminder is still sent as plain text without the model; a one-time web reminder waits until just after Chicago midnight; a repeat skips that time.
- A run is stopped after 8 tool rounds, with a notice naming the reminder.
- Web: a reminder's `NO_SEND` answer shows as a muted "Nothing to report".

**Changed**

- Reminder messages carry a "[Notes for this run]" block for the model (the `NO_SEND` rule and recent sends); the web shows only the instruction.
- Reminders of every destination are tracked in `app.proactive` instead of the Telegram door's inputs.
- The Telegram door remembers the last chat that wrote (`lastChat`), for cap notices from web reminders.

**Pi Durable**

- No version change (1.6.0). The seam adds `GenerationTask`, `hook` and `hookTask`; the contract test pins that an `onYield` task sees the committed answer and that `afterTools` `{ terminate: true }` settles the input `done`.
- New ledger entry L7 (workaround): the cap counts model rounds at admission and after each tool round, because `beforeRequest` can't write.

**Migration**

- None. Older builds ignore `app.proactive`; rolling back loses only the delivery of reminders that are running at that moment.
