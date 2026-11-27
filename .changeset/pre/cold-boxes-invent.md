---
"mipi": patch
---

**Added** · Create named side chats under a bot from the web sidebar or Telegram. Cobots inherit their bot's purpose and tool profile. MiPi's cobots start on the default profile.

**Changed** · Telegram `/new [name]` opens a cobot, and `/help` lists the commands. The web sidebar nests cobots and subagents and shows their activity and unread entries on parent rows.

**Fixed** · Reconnected web clients receive unread entry heads for task-owned subagents.

**Pi Durable** · The contract test pins the conversation and task IDs in the subagent ownership record.

**Migration** · Cobots use the existing conversation fields and archive index. Web creation receipts add a cobot variant.
