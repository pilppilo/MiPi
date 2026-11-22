/**
 * Tool profiles. MiPi has no built-in tools: a conversation gets exactly the tools of its profile, stored per
 * conversation like the model and set by the channel that created it. A new tool is opt-in by adding it to a profile
 * here, in the same PR as the change to `test/profiles.test.ts`.
 *
 * Never add Pi Durable's coding tools (read, write, edit, bash), codemode or tool search.
 */
import type { ToolRegistration } from "./pi/durable.ts";
import { scheduleTool } from "../tools/schedule.ts";
import { searchHistoryTool } from "../tools/search.ts";

export const PROFILE_NAMES = ["default", "empty", "pidu"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

/** MiPi's tools by id. Only tools listed here can be in a profile. */
const TOOLS = {
  schedule: scheduleTool,
  search_history: searchHistoryTool,
} as const satisfies Record<string, ToolRegistration>;
export type ToolId = keyof typeof TOOLS;

export interface Profile {
  readonly name: ProfileName;
  /** One line for pickers. */
  readonly description: string;
  readonly tools: readonly ToolId[];
}

/** Plain data: a name, a description, and the tools by id. */
export const PROFILES: Readonly<Record<ProfileName, Profile>> = {
  default: {
    name: "default",
    description: "Everyday tools: scheduling and history search",
    tools: ["schedule", "search_history"],
  },
  empty: {
    name: "empty",
    description: "Plain chat, no tools",
    tools: [],
  },
  pidu: {
    name: "pidu",
    // Relay input is authenticated owner input, so it starts with the default tools; separate so it can narrow.
    description: "The PiDu relay: the default tools for now",
    tools: ["schedule", "search_history"],
  },
};

export const DEFAULT_PROFILE: ProfileName = "default";

export function isProfileName(value: unknown): value is ProfileName {
  return typeof value === "string" && (PROFILE_NAMES as readonly string[]).includes(value);
}

/** The profile a var names (`MIPI_PROFILE`), or the default when it is unset or unknown. */
export function profileOrDefault(value: string | undefined): ProfileName {
  return isProfileName(value) ? value : DEFAULT_PROFILE;
}

/** The tools a conversation on `profile` is offered: the only place profiles become tool registrations. */
export function toolsFor(profile: ProfileName): ToolRegistration[] {
  return PROFILES[profile].tools.map((id) => TOOLS[id]);
}

/** Every tool any profile uses, once each: what the harness's extension registers. */
export function profileTools(): ToolRegistration[] {
  return [...new Set(PROFILE_NAMES.flatMap((name) => toolsFor(name)))];
}
