---
"mipi": minor
---

COD-174: a burst of messages gets one reply, from every door.

**Changed**

- `followUpMode: "all"`: every input queued behind a running turn joins the next turn together, whichever door it came from (web, Telegram, relay, scheduled). Before, each queued input took a turn of its own. An idle web or relay message still starts its turn at once.
- Telegram: a message to an idle conversation opens a 2-second window, and the messages of that window go to the model as one input with one stamp. Later messages join the window without moving its deadline. A window is sent early at 50 messages or 32,000 characters. A message that arrives after its window's deadline is admitted after that window is sent. When the conversation is already busy, a message goes straight to the queue as before.
- A web or scheduled turn that starts during the wait makes the Telegram batch its follow-up.
- `/new` sends a waiting window to the old conversation before it starts the new one.
- `/model <id>` and `/profile <name>` answer "I'm still working on your last message; try again in a moment." while a message waits or a turn runs. `/model` checks again when the change is applied. `/model` and `/profile` without an argument still answer.
- Messages that fail together get one notice instead of one each.

**Pi Durable**

- No version change (1.6.0). No ledger changes. The seam re-exports `ConversationIdle`, `LiveDoc` and `InboxDoc`. The contract test checks that `whenIdle: "reject"` refuses an idle conversation before writing anything, and that the same commit can still write documents.

**Migration**

- None. The window lives in a new optional field (`staged`) of the `app.telegram` document, so the document keeps its version. A rollback to the previous build ignores the field; messages waiting in a window at that moment would not be sent.
