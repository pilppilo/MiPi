---
"mipi": minor
---

COD-233: archive from the web, archive one cobot, cobots in `list_bots`, and binding the relay back to MiPi.

**Added**

- The web shows an **Archive bot** or **Archive cobot** button on an open purpose bot or cobot, never on MiPi. It asks first, saying how many cobots go with a bot, then sends `bot.archive`. The tab then moves to MiPi, as the agent does: its link too, so a reload doesn't reopen the archived one.
- A cobot can be archived on its own: `bot.archive` on a cobot, or `stop_bot` with `cobot`. Its bot keeps working. Restore brings it back alone. Archiving its bot later leaves it archived, and restoring the bot doesn't bring it back.
- `list_bots` lists each bot's live cobots indented under it, MiPi's included.
- `stop_bot` takes an optional `cobot` to archive only that cobot of the named bot. An unknown bot or cobot is refused, and so is a cobot name that two live cobots of the bot share. It never falls back to archiving the bot.
- Purpose bots on `default` get `list_cobots` and `archive_cobot` to manage their own cobots. A profile can now name `botTools`, offered only to a purpose bot on it, so its cobots and plain chats on `default` don't get them, and bare core still offers no tool. `archive_cobot` needs an owner-only turn: a relay, bot or scheduled input, or untrusted tool content, refuses it.

**Changed**

- `bind_door`'s description says that naming MiPi binds the door back to MiPi. An unknown door name is refused with the list of doors, for example `relay:pidu`.

**Fixed**

- A web tab on a bot or cobot archived under it (by its Archive button, another tab, or `stop_bot`) moves to MiPi with the agent. Before, it stayed on the archived conversation while the agent watched MiPi for it, so a Restore there showed nothing new until the owner went away and back.

**Pi Durable**

- No version change (1.6.1). No ledger changes.

**Migration**

- Nothing is stored differently: a cobot archived alone uses the same `archivedAt` and archive index as before.
- Purpose bots on `default` gain two tools at the first start of this build (the startup profile sync), so their cached prompt prefix changes once. Every other conversation keeps its tools.
- Rolling back works. An older build refuses to archive a cobot alone, but it still restores one. Not one-way.
