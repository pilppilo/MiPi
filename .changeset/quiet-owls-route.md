---
"mipi": minor
---

COD-150 (M3): one agent for its owner, with tool profiles, titles and a model picker.

**Added**

- Tool profiles (`src/agent/profiles.ts`): `default` (schedule, search_history), `empty` (no tools) and `pidu` (the default tools for now), as plain data. `toolsFor(profile)` is the only place a profile becomes tools. Each conversation stores its profile; new ones start on `MIPI_PROFILE` (new var, default `default`), and the relay will start on `pidu`. `test/profiles.test.ts` checks the exact tools each profile is offered and that no codemode or tool-search section appears.
- Channel bindings (`app.channel-binding`): a channel key maps to the conversation it talks to and sets its starting profile. The web is bound to the main conversation; Telegram and the relay bind theirs in M5 and M7.
- Conversation titles: a conversation is named from its first message at once; a long one is renamed by its own model (3 to 6 words, adapted from Pi Pocket `titles.ts` @ `2f060f2`, MIT). The cost counts in the conversation's usage.
- Web: a model picker (only models in both OpenCode Go's live list and pi-ai's catalog; other ids are refused) and a profile picker, both per conversation. Conversations are listed by title.

**Changed**

- Every session request goes to the owner's Durable Object (`MIPI_OWNER`); any other session id is 404 and never creates an object. The spike probe uses the owner's object too.
- The speaker in message stamps is `MIPI_OWNER`, not a name the browser sends. The web no longer asks for a display name.
- Web input uses request ids `web:<client key>` and is checked with `submissionByRequest` before admitting, so a retry admits nothing.
- Web: the "pi-durable / Session" header is now "MiPi"; system entries are hidden behind a "Show system entries" toggle.
- The alarm function is `scheduleNextAlarm()`, the one place the alarm is set.

**Pi Durable**

- No version change (1.6.0). The seam adds `ProviderDoc` and `UsageDoc` (used by titles). No ledger changes. New MiPi documents (`app.conversation`, `app.channel-binding`) need no definition to be stored, so older builds open the data unchanged; not one-way.

**Migration**

- None. The main conversation gets its profile recorded (`default`) on the first web visit; its tools don't change.
