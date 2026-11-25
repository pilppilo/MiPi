/**
 * The `memory` built-in (M8): `remember` and `forget`, the memory prompt section, and the background memory pass. It
 * uses core's connectors only: untrusted content (a run that fetched a page can't write memory), input origin (where a
 * lesson came from), side model calls (the pass) and a wake source (the pass's alarm).
 *
 * Switched off for a conversation, its tools and section leave that conversation and the pass skips it. Replaced by an
 * extension that registers `remember` or `forget`, all of it goes, the pass too, so nothing keeps writing `app.memory`
 * behind the replacement.
 */
import { defineExtension } from "../../../agent/pi/durable.ts";
import type { MipiExtension } from "../../../agent/extensions.ts";
import { memorySection } from "./memory.ts";
import { isMemoryPassChange, MemoryPassRuntime } from "./memory-pass.ts";
import { forgetTool, rememberTool } from "./tools.ts";

export const memoryExtension: MipiExtension = {
  name: "memory",
  tier: "builtin",
  replaceable: true,
  slot: "memory",
  pi: defineExtension({
    name: "memory",
    tools: [rememberTool, forgetTool],
    // After the static preamble: a lesson changes only the end of the system prompt. Shown where `remember` is offered.
    sections: [memorySection],
  }),
  wakeSources: (context) => {
    const pass = new MemoryPassRuntime({
      harness: context.harness,
      origins: context.origins,
      models: context.models,
      untrustedTools: context.untrustedTools,
      onWakeChange: context.onWakeChange,
      report: context.report,
    });
    return [
      {
        name: "memory pass",
        wake: () => pass.wake(),
        // Idle conversations' memory passes that are due (M8).
        run: () => pass.run(),
        observes: isMemoryPassChange,
        refresh: () => pass.refresh(),
        close: () => pass.close(),
        // The first look, before the alarm is first set: its wake is in the first write, and nothing of it is in flight
        // once opening is over.
        prepare: () => pass.start(),
      },
    ];
  },
};
