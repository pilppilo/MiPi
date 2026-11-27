---
"mipi": patch
---

COD-248: the web app hides the message stamp, and shows it only with the system entries.

**Changed**

- Your messages in the web app read as you wrote them. The `[jerome · Fri, Nov 27, 2026, 16:32 CST]` line the agent puts on every message (so the model knows who spoke and when) is no longer shown as part of the message, nor on queued messages, nor on messages from Telegram, the relay or other bots. Turn on **Show system entries** in a bot's details to see it again, as a quiet line on each message.
- The stamp's format lives in the wire contract (`formatStamp`, `parseStamp` in `src/protocol.ts`). Core's `stampInput` builds stamps with it, so the agent and the web app read one format. What the model sees is unchanged, byte for byte, so the prompt cache is unaffected. A message that only looks like it starts with a stamp is shown as written.

**Pi Durable**

- No version change and no new ledger entry. `formatStamp` carries the existing L3 marker (the time travels with each message).

**Migration**

- None. Stored messages are unchanged; only how the web app shows them.
