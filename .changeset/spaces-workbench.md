---
"mipi": minor
---

COD-249: spaces in the web app, with Workbench as the first space after Chat.

**Added**

- Spaces, as in D · Spaces. The drawer lists them above the bots, a wide screen's sidebar lists them, and on a phone they are tabs under the message box. Each space shows only when the agent advertises the capabilities it needs (COD-246): an agent without them shows Chat alone, with no Spaces list and no tabs. Picking a space closes the drawer, and the page's link remembers it (`?space=workbench`). Opening another bot keeps the space you're in, and Back and Forward bring back the space as well as the bot.
- **Workbench**, the deep view of the open bot:
  - **Running now:** its tasks by plain name ("Answering", "Summarising the chat so far"), with the open conversation's steps as they run ("Past chats" done, "Web pages" running). Work for a side chat or a helper says which, on running and waiting cards alike.
  - **Waiting:** its sleeping or waiting tasks, with when they wake ("Reminder · Wakes Sat 9:00 AM").
  - **Other bots:** each one's state (Working, Waiting, Asleep) and new messages. Tapping one opens its Workbench. Looking at a bot's Workbench doesn't mark its messages read; only Chat does, and coming back to Chat lands on the latest message.
- Workbench needs the `activity` capability. Stopping and steering a run come with COD-250, and the approvals waiting on you with COD-238.

**Pi Durable**

- No version change and no ledger change.

**Migration**

- None. Client-only.
