---
"mipi": patch
---

COD-193 (M9 slice 1): a daily spend cap, a pause switch, and a usage readout.

**Added**

- **Spend today.** `src/agent/spend.ts` measures what MiPi spent from every conversation's `pi.usage`, subagents' and tools' included, at pi-ai's list prices. Titles and the memory pass already record theirs there. A measure adds what grew since the last one to today's count (Pi Pocket `spend.ts` pattern). The count never drops, and it starts afresh at Chicago midnight. The agent measures once when it first opens with this build, so spend from before that counts for no day.
- **`MIPI_DAILY_SPEND_CAP`** (dollars; `1` on both lanes; `off` means no cap). At the cap, work nobody asked for at that moment waits until Chicago midnight:
  - reminders: a one-time Telegram one goes out as plain text, "(sent without MiPi: daily spend cap reached)"; a web one waits; a repeat skips its occurrence
  - a reminder run already going, stopped after the tool round that crossed it
  - the memory pass, measured before each conversation's pass
  - model-written titles

  One notice a day says so. Your own messages still go through; on Telegram, the first new one over the cap each day gets one line saying so (a message Telegram sends again doesn't).

- **`MIPI_PAUSED`** (`0` on both lanes). `1` holds every model call:
  - the web refuses new messages with "MiPi is paused, so it can't answer right now."
  - Telegram answers the same before any burst window opens, and refuses a window staged before the pause, when it comes due or on `/new`; commands still answer
  - the relay answers 503 `{ "error": "Paused" }` with `Retry-After: 3600`; a key admitted before still gets its answer
  - reminders are held as at the cap, without a notice
  - the memory pass sets no wake

  A value that is neither on nor off is reported and pauses.

- **Usage readout**, the same on every door: Telegram `/usage`, a line in the web header, and `usage` in the admin status. The web line is read again only while the agent is awake anyway (the session opening, your message, work running, the tab coming back into view), at most every 30 seconds, so it never wakes a hibernated agent. Details show on hover. It shows today's estimate, the spend cap, the run cap's rounds, and each provider's own figures where MiPi can read them. `src/agent/usage-sources.ts` holds one reader per provider. OpenCode Go is the first: its rolling, weekly and monthly windows from `GET https://opencode.ai/zen/go/v1/usage` (the shape OpenCode's own client reads). Reads are cached in memory for five minutes, failures too, and callers at the same moment share one read. The admin status measures nothing and asks no provider: it shows the spend as last measured and what is cached, so a GET writes nothing.
- Optional settings: `OPENCODE_USAGE_KEY`, a key with usage permission when the model key has none, and `OPENCODE_ORG_ID`, the workspace id if Go asks for one. The deploy workflow passes them, and `MIPI_DAILY_SPEND_CAP` and `MIPI_PAUSED` from a lane's Environment variables, over `wrangler.jsonc`'s values. An unset `OPENCODE_USAGE_KEY` is written as `off`, as the relay tokens are, so removing it takes effect.
- `docs/deployment.md`: a "Spend cap, pause and usage" section, with how to pause a lane.

**Changed**

- Older scheduled deliveries (`app.deliver-scheduled-instruction`) follow the same rule. Paused or at the cap, the occurrence isn't delivered, and a successor carries the schedule to its next time (a repeat) or past Chicago midnight (a one-time one). At the cap, the day's notice goes to the chat that wrote last. An occurrence already submitted before a restart is never held.
- `chicagoDay`, `afterNextChicagoMidnight` and `CAP_ZONE` moved to `src/lib/cap-day.ts`; `proactive.ts` re-exports them.
- `RoundBudget` can stop a run for `spend-cap` or `paused`, besides `daily-cap` and `run-limit`.

**Pi Durable**

- No version change (1.6.0). Ledger: L7 now covers the spend cap and the pause, checked at the same two places as the run cap. It is renamed "Daily caps are checked at admission and after each tool round".

**Migration**

- New session document `app.spend`. An older build ignores it, so this isn't one-way. After a rollback:
  - a run stopped for `spend-cap` or `paused` would be reported as a run-limit stop
  - a reminder's `skippedPaused` count is dropped the next time it runs
- Fixture capture now seeds `app.spend`. The release that carries this captures its fixture DB with `pnpm fixture:capture`.
