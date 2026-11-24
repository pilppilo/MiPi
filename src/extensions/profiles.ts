/**
 * Which tools each profile offers (the mechanism is `src/agent/profiles.ts`). Every tool is opt-in: a new tool reaches
 * a conversation only once it is named here, in the same PR as the change to `test/profiles.test.ts`. A name no
 * installed extension registers offers nothing.
 */
import type { ProfileTable } from "../agent/profiles.ts";

const EVERYDAY = ["schedule", "search_history", "remember", "forget", "web_fetch"] as const;

export const PROFILE_TABLE: ProfileTable = {
  default: {
    description: "Everyday tools: scheduling, history search, memory and web pages",
    tools: EVERYDAY,
  },
  empty: {
    description: "Plain chat, no tools",
    tools: [],
  },
  pidu: {
    // Relay input is authenticated owner input, so it starts with the default tools; separate so it can narrow.
    description: "The PiDu relay: the default tools for now",
    tools: EVERYDAY,
  },
};
