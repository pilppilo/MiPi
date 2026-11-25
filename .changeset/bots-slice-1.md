---
"mipi": minor
---

COD-197: MiPi becomes the main bot (bots slice 1). Work in progress: the web bots list and Telegram's `/bot` follow in this PR.

**Added**

- MiPi, the main bot, on a new `main` profile (the everyday tools; the bot tools come in COD-199), made on the first start of this build.
- Bot fields on `app.conversation` (`kind`, `name`, `purpose`, `bot`, `createdBy`, `archivedAt`) and the session document `app.bots` (MiPi and the name index). Bot names are unique, ignoring case, and 1 to 40 characters. A purpose bot's purpose is its instructions.

- Protocol: `bot.create { name, purpose, profile }` makes a purpose bot (on a profile the pickers offer; a retry with the same request id makes it once), and `bot.rename` renames a bot, MiPi included. Conversation summaries carry `kind`, `name`, `purpose`, `bot`, `archivedAt` and `latestEntryId`, and a `conversation.head` event tells the list when a conversation gets a new entry, from the commit itself.
- The web app's "New bot" form (name, purpose, profile).

**Changed**

- Every door reaches MiPi: the web opens it instead of Pi Durable's root conversation, and Telegram and the PiDu relay talk to it. Relay messages stay fenced and stamped as PiDu's. Pointing the relay at a purpose bot of its own comes with COD-199.
- Only MiPi runs on `main`, and MiPi always does. `pidu` stays only for the relay's chats from before bots: no conversation newly takes it, and the relay starts on the configured profile like the other doors. The web and Telegram's `/profile` refuse these switches, and pickers list only `default` and `empty`.
- A fork is a chat of its own, never a copy of its bot.
- `conversation.create` is gone: "New conversation" became "New bot". Receipts stored by older builds still read.

**Migration**

- On the first start, every chat from before bots is archived (`archivedAt`), kept whole: transcripts, reminders, relay receipts and memory are untouched. History search and the memory pass still read them (archiving's effects come with COD-198).
- Each door's binding moves to its bot the first time the door reads it, and is marked `bots`: Pi Durable can't list the bindings to move them all at once. A binding chosen since stays where it is.
- An older build ignores the new fields, so rolling back works: its doors find their bindings on MiPi and PiDu, which work as ordinary chats.
