/**
 * Settings of this agent that its tasks read, stored in its own session rather than in module state, so every agent
 * (and every test harness) has its own. The Durable Object writes them from its bindings when it opens.
 */
import { defineDoc } from "./pi/durable.ts";

export const AgentSettings = defineDoc<{ timeZone?: string }>({
  kind: "app.settings",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: () => true,
});
