---
"mipi": minor
---

COD-166: cache-stable prompts, at the agent level for every door.

**Changed**

- The system prompt is static: the per-minute "Current time" section is gone. It appended a new system entry every turn (the System lines in the transcript) and kept the prompt prefix from staying identical, which is what provider prompt caches key on.
- Every message is stamped with who sent it and when, in the owner's time zone (`MIPI_TIMEZONE`, default `America/Chicago`): `[Jerome · Sun, Nov 22, 2026, 12:40 CST]`. Scheduled deliveries carry their local time too (`Scheduled instruction due now (…): …`); the client still recognizes both the new and the old form.
- One cache policy for all conversations: `cacheRetention: "long"` in the harness's stream settings. It takes effect on models that support explicit retention (Anthropic-format: 1h; OpenAI-format: 24h) and is ignored elsewhere. `deepseek-v4.1-flash` on Go has no explicit cache controls: DeepSeek caches identical prefixes on its own, and OpenCode's session header keeps each conversation on the same backend, so the identical prefix is what matters.

**Added**

- Test: three turns hours apart, each request an exact prefix of the next, no new system messages between turns, and the cache policy on every request.
- The web header shows cached prompt tokens and the share of the prompt served from cache.

**Pi Durable**

- No change (1.6.0).

**Migration**

- None. Existing conversations keep their old clock entries; new turns stop adding them.
