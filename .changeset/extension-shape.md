---
"mipi": patch
---

COD-209: the extension shape, the built-in list, memory and `web_fetch` as built-in extensions.

**Changed**

- Internal, no behaviour change for the owner. A MiPi extension is now a Pi Durable extension plus MiPi registrations (`src/agent/extensions.ts`): tier, replaceable, prompt slot, untrusted tools, wake sources. Core resolves them once (`composeAgent`), and the composition root adds the built-ins (`src/agent/composition.ts`).
- The one `chat` extension that held every tool is split. `chat` keeps only the preamble, and `memory`, `reminders`, `history-search` and `web-fetch` are built-ins, listed in `src/extensions/builtins.ts`. Memory (its tools, section and background pass) and `web_fetch` moved to `src/extensions/builtin/`. Reminders and history search keep their code in `src/tools/` until COD-210 and COD-211 move it.
- Every built-in is always installed. The default selection is core's own extensions first, then the built-ins by slot and name, so the prompt sections and tools come out exactly as before. A conversation can switch a built-in off (`AgentComposition.switchOff`), and its tools and section leave that conversation only. Profile changes, the startup profile sync and the memory pass all respect that.
- Pi's replacement rule: an extension that registers a built-in's tool name replaces that built-in whole, whatever the load order. The replaced one stays installed, so its stored tasks still resolve. Any other clash refuses to start, with the reason in the admin status. The admin status lists the extensions in use and any replacements.
- New core connectors: side model calls (`side-calls.ts`, used by titles and the memory pass), untrusted content (`untrusted.ts`: `web_fetch` is declared untrusted by its extension, checked against the tools it registers and bound per agent, and memory no longer names it), input origin (`origin.ts`: memory no longer parses request ids or lists the doors), and the delivery destination type (`delivery.ts`).
- The startup guard's task list is collected from the installed extensions instead of a hand-kept `APP_TASKS`.
- The profile table moved to `src/extensions/profiles.ts`; `src/agent/profiles.ts` is the mechanism and names no tool.
- Lint: core imports no extension or tool except in the composition root, and an extension imports no door. `scripts/check-boundaries.ts` (in `pnpm check`) fails on an import from one extension into another.

**Pi Durable**

- No version change (1.6.0). No ledger changes.

**Migration**

- None. Document kinds and task names are unchanged, and the 0.1.0-beta.1 fixture opens and runs as before.
