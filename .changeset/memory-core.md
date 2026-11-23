---
"mipi": minor
---

COD-182 (M8 slice 1, part of COD-154): memory. MiPi keeps short lessons across conversations and doors.

**Added**

- `remember(text)` and `forget(id)` tools, on the `default` and `pidu` profiles. `empty` still has no tools.
- The `app.memory` session document. It holds up to 20 lessons of at most 300 characters each.
  - Lesson ids are `m1`, `m2`, …, and they're never reused.
  - Each lesson records where it came from: web, Telegram, relay or a reminder, plus the conversation.
  - Whitespace becomes one line and invisible characters are removed.
  - Empty text, text that's too long, or a 21st lesson is refused with the reason. Nothing is trimmed.
  - An exact duplicate changes nothing.
- A `memory` system section lists the lessons by id, and the lesson text can't close the tag. It comes after the static preamble, so a new lesson changes only the end of the prompt. It's left out when there are no lessons, and wherever `remember` isn't offered.
- `remember` refuses in a run that called `web_fetch` (slice 2), so a fetched page can't write itself into memory. The check reads the run's stored entries, so it still holds after a restart. The owner's next turn works again. Relay runs aren't blocked.

**Changed**

- The `default` and `pidu` profiles gain `remember` and `forget`. Existing conversations get them on the next start, through the existing profile-tools sync.

**Pi Durable**

- No version change (1.6.0). No ledger changes.

**Migration**

- None. `app.memory` is a new document.
