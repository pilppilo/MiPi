---
"mipi": patch
---

COD-207: the agent's one alarm takes wake-ups from a list of wake sources that names no door.

**Changed**

- Internal only, no behaviour change. Each part that needs the alarm (today the Telegram door and the memory pass) registers once as a wake source (`src/agent/wake-sources.ts`): its wake, what the alarm runs, which commits make it look again, and how it closes.
- `alarm.ts` no longer imports the Telegram door. The alarm, the commit observer and shutdown loop over the sources instead of naming them, and the alarm runs them in registration order after Pi Durable, as before.
- Sources are registered when the harness opens and cleared when it closes, so a reopen after an export or restore registers each once. A second source with the same name throws.
- Lint: `alarm.ts` and `wake-sources.ts` may not import a door, tool or extension (an oxlint override beside the Pi seam rule).

**Pi Durable**

- No version change (1.6.0). No ledger changes.

**Migration**

- None. No stored data changes.
