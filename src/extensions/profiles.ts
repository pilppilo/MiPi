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
    // The relay's chats from before bots (now archived) read this profile; the relay reaches MiPi since COD-197. Not
    // offered by the pickers.
    description: "The PiDu relay before bots: the default tools",
    tools: EVERYDAY,
  },
  main: {
    // MiPi, the main bot (COD-197). The bot tools (create_bot, message_bot, list_bots, stop_bot) join in COD-199.
    description: "MiPi, the main bot: the everyday tools",
    tools: EVERYDAY,
  },
};
