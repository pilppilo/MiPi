---
"mipi": minor
---

COD-201: a settings menu with Archived (settings slice 2).

**Added**

- A Settings button in the web sidebar's header opens a wide panel with a list of sections. The first is Archived: archived bots with their cobots, then the chats from before bots, each with its purpose or first line and when it was archived.
- Each archived entry can be opened read-only or restored. There is no Delete yet: Pi Durable can't delete a conversation (ledger L13).
- Restoring a chat from before bots makes it a cobot under MiPi, named from its title, or its first message's first line when it has none. Its reminders run in it again, not in MiPi.

**Changed**

- An archived conversation opens read-only on the web. The composer and the pickers are off, the profile shows as stored (even the relay's old `pidu`), and a banner offers Restore. The agent refuses its messages and its profile or model changes, with wording for a bot, a cobot or a chat from before bots.
- Picking a conversation in the sidebar, making a bot or cobot, or going back in the browser closes Settings.
- A cobot archived with its bot comes back only with the bot. Restoring it alone is refused with "Restore <bot> first.", and the web shows the same hint by a disabled Restore.

**Fixed**

- A web tab that opens an archived conversation stays on it, read-only, through other changes (another tab making a cobot, say), until it is restored. Before, any such change moved it to MiPi. The mark lives on the socket, so it survives hibernation. A conversation archived while a tab is on it still moves the tab to MiPi.

**Pi Durable**

- No version change (1.6.1). Ledger: L13 added (watch): Pi Durable 1.6.1 can't delete a conversation, so Archived offers no Delete. Upstream: earendil-works/pi#11026, with an open PR (earendil-works/pi#12562).

**Migration**

- Nothing changes until the owner restores a chat from before bots. Then its conversation meta gains `kind: "cobot"`, `bot` (MiPi) and `name`, and it leaves `app.bots.archived`. It keeps its profile, except the relay's old `pidu`, which becomes `default`.
- Rolling back works: the fields are optional and the meta stays version 1, so a build with cobots (COD-200) shows the restored chat as a cobot under MiPi. Not one-way.
