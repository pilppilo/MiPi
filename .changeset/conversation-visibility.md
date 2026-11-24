---
"mipi": patch
---

COD-211: conversation visibility, and history search as a built-in in fact.

**Changed**

- Internal, no behaviour change for the owner. Core decides which conversations are the owner's (`src/agent/visibility.ts`: `listVisible`, `visiblePage`): today, every ownerless one. History search and the memory pass use it at all three scan sites instead of scanning and filtering themselves. The memory pass plans its wake in the records-only mode, which reads no conversation's documents, so the archive (COD-198) can't make every plan read every conversation.
- `search_history` and its subagent's `search_conversations` moved to `src/extensions/builtin/history-search/`. `src/tools/` is gone: all four built-ins live in `src/extensions/builtin/`, and the boundary check covers them.
- The memory pass still recognises reminders' deliveries by their text: Pi Durable has no way from an entry to the input that placed it (ledger L8).

**Pi Durable**

- No version change (1.6.0). Ledger: L8 added (watch): Pi Durable links a submission to its entry one way only, with no request id on the entry and no submission scan.

**Migration**

- None. No stored data changed.
