---
"mipi": minor
---

COD-153 (M6, part 2 of 3): Telegram messages look right and get through.

**Added**

- Telegram replies are formatted. The model's markdown is rendered into Telegram's HTML: bold, italic, strikethrough, inline code, code blocks with their language, http(s) links, headings (shown bold) and quotes. Anything else is escaped text, as written.
  - Underscores inside words stay as they are (`MIPI_DAILY_RUN_CAP`).
  - Markers inside code stay as they are.
  - A marker without its partner stays literal.
  - Tags never cross.
- A reply is split before it is rendered, so no tag spans two messages. A code block cut by a split is closed and reopened, and the splitter keeps room for those fences.
- If Telegram can't read a chunk's HTML ("can't parse entities"), that chunk is sent once more as plain text (the markdown source). The switch is saved first, so a restart can't send the broken HTML again.
- If Telegram finds a chunk too long, only that chunk is split in two, in place. A chunk is split at most three times.
- A send with an unclear outcome is tried once more: a timeout, a lost answer, an answer without a message id, or a chunk left `sending` by a restart. The retry is counted before it runs. If the retry is unclear too, the chunk is `delivery-unknown` and the rest of that reply is skipped. Telegram can't look a message up in a chat, so a rare duplicate is the lesser harm than a lost reminder.
- On start, every conversation gets the tools its profile names where they differ. Conversations older than profiles kept the tools they were created with, so one could show `default` and still offer no `schedule`. The pass leaves models alone and writes nothing when everything already matches.

**Changed**

- The alarm code moved to `src/agent/alarm.ts`. The alarm is still the earliest of Pi Durable's next wake, the Telegram door's next need, and the heartbeat, and it is deleted when nothing needs it. Each of the alarm's consumers now runs in its own `try`, so a failing Telegram door can't stop Pi Durable from resuming, and the alarm is always rescheduled unless maintenance runs.
- Error descriptions from Telegram are matched without regard to case, and a 429's `retry_after` is capped at an hour.

**Pi Durable**

- No version change (1.6.0). No ledger changes.

**Migration**

- None. All new outbox fields are optional, so the document keeps its version.
- Chunks stored by an earlier build have no id, HTML or retry policy. They keep sending as plain text, and an unclear outcome stays final for them.
- An earlier build reading chunks made by this one sends their plain text and ignores the new fields.
