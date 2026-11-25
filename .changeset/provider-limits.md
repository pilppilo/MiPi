---
"mipi": patch
---

**Added**

- OpenCode Go plan-limit notices on web, Telegram, and relay. Background work waits for the latest active hold deadline. The web keeps the original error in the conversation, and owner messages are still tried.

**Changed**

- Recurring reminders wait through a short cooldown after transient provider failures. Memory keeps its existing transient retry delay.

**Fixed**

- Recurring legacy schedules keep their cadence through a hold. Repeating reminders still report plan failures when a recorded limit has expired or is unavailable. The web refreshes usage when a new failure arrives in a live update.

**Pi Durable**

- Ledger L9 records provider limits from the awaited `afterResponse` observer before a failed input settles.

**Migration**

- The provider-limit document is additive. Existing conversations inherit the core extension through the default selection.
