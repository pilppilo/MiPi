---
"mipi": patch
---

COD-210: the doors as their own tier, delivery, the answer policy, the run cap and reminders as a built-in.

**Changed**

- Internal, no behaviour change for the owner. Telegram and the relay moved to `src/doors/` (`telegram/`, `relay/`), with the web door's registration in `src/doors/web/` (its socket handler stays in `agent-do.ts`). The three Telegram helpers left `src/lib/`. Core imports no door: each door registers its request-id prefix, its delivery adapter and its inputs waiting for an answer (`src/agent/connectors.ts`), and the composition root wires the runtimes.
- Delivery (`src/agent/delivery.ts`): `send`, `tellOwner` and `onDelivered`, through the doors' adapters. Both enqueue in the caller's commit, so a state change and its notice are stored together. An adapter says whether its destination can take a message nobody is waiting for (Telegram yes, the web no); that replaces every `kind === "telegram"` branch. Message ids are built as before, so nothing already queued is sent twice.
- Core owns proactive runs: `app.proactive` (same kind and fields), `RecordRun`, `RoundBudget` and the answer policy. One settlement (`src/agent/answers.ts`) watches every door's pending inputs and every reminder and judges each answer once, as before; it moved out of the Telegram door. "Is this a reminder's own run" comes from origin, not from a `sched:` check.
- Origin: the fixed table of request-id prefixes left core. Each door and the reminders register their own prefix, and the reply destination comes from the door (Telegram: the chat recorded with the input). Request-id builders moved to their doors and to the reminders.
- The gates (`src/agent/gates.ts`): the run cap, the spend cap and the pause, read-only for doors and extensions. Telegram, the relay, the usage readout and the memory pass stop reading `app.spend` and `app.proactive` themselves.
- Reminders became a built-in in fact: `schedule`, `app.reminder`, `app.deliver-scheduled-instruction` and their tasks moved to `src/extensions/builtin/reminders/`, onto delivery, origin and the gates.
- The Bot API sender moved from the outbox to `src/doors/telegram/bot-api.ts`.
- Lint: core imports no door, extension or tool except in the composition root; a door imports no extension; and only `src/doors/telegram/` imports Telegram's documents.

**Pi Durable**

- No version change (1.6.0). Ledger: L7's wording names `expectProactive` and the reminders' folder; no entry added or closed.

**Migration**

- None. Document kinds, stored fields and task names are unchanged, so rolling back reads the same data. The 0.1.0-beta.1 fixture opens and runs, and its sleeping reminder now wakes and runs from the `reminders` extension (tested).
