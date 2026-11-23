---
"mipi": minor
---

COD-184 (M8 slice 3, part of COD-154): the background memory pass. It replaces "save before compaction".

**Added**

- Once a conversation has been idle for 30 minutes, the alarm runs one pass on it. The pass reads what was said since the conversation's mark, plus the lessons already saved, and asks the conversation's own model for at most 3 new lessons. They're saved by `remember`'s rules, with source `background`. It's silent.
- The pass reads raw entries, newest first, up to 40,000 characters. Compaction never changes raw entries. Scheduled deliveries, tool calls and tool results are left out.
- A pass never calls the model in these cases:
  - The profile has no `remember`.
  - Memory is full.
  - There's no new message from a person.
  - Scheduled runs are paused (`MIPI_DAILY_RUN_CAP` 0).
  - Today's 20 passes are used.
- A busy conversation is put off 30 minutes.
- A range with a `web_fetch` call or result anywhere is passed over without a request, and its mark moves past it.
- A failed or unreadable reply keeps the mark and waits 5, then 30 minutes. After 2 retries the range is given up, so an outage can't use up the day.
- The pass's spend counts in the conversation's `pi.usage`.
- The new `app.memory-pass` document holds each conversation's mark and today's count.
- The pass's wake is never active, so the 60-second heartbeat doesn't run while it waits.

**Changed**

- Once a turn settles, the alarm now stays set for the next memory pass instead of being deleted.
- `titles.ts` exports `recordUsage` and `providerSession`, which the pass uses too.

**Pi Durable**

- No version change (1.6.0). No ledger changes. Pi Durable's `beforeCompact` hook can't write, so the pass works from idle conversations instead of before compaction, the way Codex writes its memories.

**Migration**

- None. `app.memory-pass` is a new document. A conversation's first pass reads its whole history, up to the 40,000-character budget.
