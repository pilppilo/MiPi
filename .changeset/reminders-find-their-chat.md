---
"mipi": minor
---

COD-153 (M6, part 1 of 3): reminders that reach the chat they came from.

**Added**

- Reminders. `schedule` now makes one durable task per reminder. The task sleeps until each time, delivers that time to the conversation the reminder was made in, and for a repeat sleeps again, so the model no longer schedules each next time itself.
- A new `when` argument takes times as people say them, in the owner's time zone: `in 2m`, `tomorrow 9am`, `every weekday 8:00`, `every 30m between 9:00 and 17:00 on weekdays`. The parser is Pi Pocket's `when.ts` (`src/lib/when.ts`). Clock times stay on the wall clock across daylight saving. In Chicago, a time skipped in spring (02:30) moves forward by the gap, and a time that happens twice in autumn (01:30) runs once, at the earlier instant. `delaySeconds` and `at` still work for one-time reminders.
- Where the answer goes is stored with the reminder. A reminder made from Telegram answers in that private chat, also with no browser open and after `/new` rebinds the chat. A reminder made on the web stays in its conversation.
- Each delivery has its own request id (`sched:<reminder>:<n>`), so a retried delivery is admitted once.
- Limits:
  - Repeats are at least 10 minutes apart.
  - At most 25 schedules wait at once, counting schedules from earlier builds.
  - A repeat skips a time while its previous delivery is still queued or running, and counts the skip.
  - A repeat skips a time that comes more than 15 minutes late, and moves to its next time.
  - A one-time reminder always goes out, however late.
  - A reminder's own turn can't make another reminder (a repeat already schedules itself). A turn that also answers a message can.

**Changed**

- The `schedule` tool's `recurrence` argument is gone: repeats use `when`. A schedule made by an earlier build keeps running as before, including its `sourceScheduleId` successor.
- The Telegram door's state document moved to `src/agent/telegram-state.ts`. Its pending inputs may now have no `update_id` (a reminder's delivery). The door picks up inputs other parts of the agent record, through a commit observer.

**Pi Durable**

- No version change (1.6.0). No ledger changes. New task kind `app.reminder` (version 1). The legacy `app.deliver-scheduled-instruction` stays registered.

**Migration**

- None needed: stored schedules keep running.
- After a rollback to an earlier build, reminders made by this build don't run: that build doesn't know the `app.reminder` task. Pi Durable marks such a task blocked (`missing_task`) and reports it, without crashing, and the rest of the agent keeps working. The reminders run again once you roll forward.
