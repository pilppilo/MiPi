---
"mipi": minor
---

COD-233: archive from the web, archive one cobot, cobots in `list_bots`, and binding the relay back to MiPi.

**Added**

- The web shows an **Archive bot** or **Archive cobot** button on an open purpose bot or cobot, never on MiPi. It asks first, naming the cobots that go with a bot, then sends `bot.archive`.
- A cobot can be archived on its own: `bot.archive` on a cobot, or `stop_bot` with `cobot`. Its bot keeps working. Restore brings it back alone. Archiving its bot later leaves it archived, and restoring the bot doesn't bring it back.
- `list_bots` lists each bot's live cobots indented under it, MiPi's included.
- `stop_bot` takes an optional `cobot` to archive only that cobot of the named bot. An unknown bot or cobot is refused, and so is a cobot name that two live cobots of the bot share. It never falls back to archiving the bot.
- Purpose bots on `default` get `list_cobots` and `archive_cobot` to manage their own cobots. `archive_cobot` needs an owner-only turn: a relay, bot or scheduled input, or untrusted tool content, refuses it. Elsewhere (MiPi, a cobot) both tools refuse with a clear message.

**Changed**

- `bind_door`'s description says that naming MiPi binds the door back to MiPi. An unknown door name is refused with the list of doors, for example `relay:pidu`.

**Pi Durable**

- No version change (1.6.1). No ledger changes.

**Migration**

- Nothing is stored differently: a cobot archived alone uses the same `archivedAt` and archive index as before.
- The `default` profile gains two tools, so each `default` conversation's tool list, and its cached prompt prefix, changes once at the first start of this build (the startup profile sync).
- Rolling back works. An older build refuses to archive a cobot alone, but it still restores one. Not one-way.
