---
"mipi": minor
---

COD-198: archive and restore a bot (settings slice 1, agent side).

**Added**

- Protocol: `bot.archive { conversationId }` and `bot.restore { conversationId }`. MiPi can't be archived or restored, and neither can a chat from before bots yet (COD-201).
- Archiving a bot archives its cobots in the same commit, then aborts what they were doing (`Conversation.abort()`: queued inputs withdrawn, the run stopped). From that commit on, an archived bot is out of the bots list, out of `search_history` and the memory pass, and takes no message (`prompt.submit` refuses with a clear reason). A web tab open on it moves to MiPi.
- A door bound to an archived bot (the web, a Telegram chat, the relay) reaches MiPi instead, and the key is remembered. Restoring binds it back, unless it was bound somewhere else meanwhile.
- An archived bot's schedules hold: a repeat skips its times (`skippedArchived`), and a one-time reminder parks itself and ends. Restoring sends each parked reminder once, marked late (`held:<reminderId>`), where it would have answered; a second restore sends nothing twice. While MiPi is paused (`MIPI_PAUSED`) they stay parked, and the next start without the pause sends them; one whose bot is archived again first waits for the next restore. The daily caps don't hold them back: the owner asked for the restore, and each still counts as a run. The admin heartbeat counts an archived bot's schedules as `archivedSchedules`, never active or overdue.
- A message arriving as its bot is archived goes to MiPi: the relay and Telegram look again in the commit that admits it.
- An archived bot keeps its name, so restoring it never collides. A new bot asking for it is told the name belongs to an archived bot.

**Changed**

- Archived conversations, chats from before bots included, are no longer the owner's for history search and the memory pass: core's visibility reads them from one session index (`app.bots.archived`), so the memory pass's wake still reads no conversation's documents.
- Reminders made in a chat from before bots run in MiPi now, so an archived conversation never runs one itself: an answer meant for that chat's transcript goes to MiPi's, and one for a Telegram chat still goes to the chat.
- `held` is a request-id prefix of the reminders (automated, like `sched`).

**Pi Durable**

- No version change (1.6.1). Ledger: L11 added (workaround): Pi Durable can't pause a task, so each reminder asks core where it runs when it comes due, and holds itself for an archived bot. L10's entry now also covers archive: a binding to an archived bot falls back to MiPi on its first read, since bindings can't be listed. `abortConversation` joins the seam, with a contract test.

**Migration**

- `app.bots` gains `archived`, `released` and `held` (optional, still version 1). On the first start of this build, the archive index is filled once from each conversation's `archivedAt`.
- Reminders keep their stored tasks: a chat-from-before-bots reminder is routed to MiPi when it comes due, not rewritten (a task's conversation can't change). Covered against the 0.1.0-beta.1 fixture.
- Rolling back works: an older build ignores the new fields and still hides archived bots by `archivedAt`. One-time reminders parked while a bot was archived wait in `app.bots.held` until this build restores the bot. Not one-way.
