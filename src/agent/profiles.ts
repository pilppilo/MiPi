/**
 * Tool profiles. MiPi has no built-in tools: a conversation gets exactly the tools of its profile, stored per
 * conversation like the model and set by the channel that created it. Every tool is opt-in.
 *
 * This is the mechanism; the table of which tool each profile offers lives beside the built-in extensions
 * (`src/extensions/profiles.ts`), so core names no tool. A profile only offers tools an installed extension registers,
 * and a conversation only sees those of the extensions it has selected: Pi Durable drops the rest of the stored names.
 *
 * Never add Pi Durable's coding tools (read, write, edit, bash), codemode or tool search.
 */
import type { ToolRegistration } from "./pi/durable.ts";

export const PROFILE_NAMES = ["default", "empty", "pidu", "main"] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export interface ProfileEntry {
  /** One line for pickers. */
  readonly description: string;
  /** Tool names, in the order they are offered. */
  readonly tools: readonly string[];
}

/** Every profile's description and tool names: plain data, supplied by the composition root. */
export type ProfileTable = Readonly<Record<ProfileName, ProfileEntry>>;

export const DEFAULT_PROFILE: ProfileName = "default";

/** The main bot's profile (COD-197): MiPi alone runs on it, so no other conversation may be switched to it. */
export const MAIN_PROFILE: ProfileName = "main";

/** The relay's profile before bots: its chats from then still read it, but no conversation newly takes it. */
export const RELAY_PROFILE: ProfileName = "pidu";

/**
 * The profiles a picker offers (web, Telegram's `/profile`): not `main` (MiPi's alone), nor `pidu`, which stays only so
 * the relay's chats from before bots, now archived, still read their profile (COD-197).
 */
export const PICKABLE_PROFILES: readonly ProfileName[] = PROFILE_NAMES.filter(
  (name) => name !== MAIN_PROFILE && name !== RELAY_PROFILE,
);

export function isProfileName(value: unknown): value is ProfileName {
  return typeof value === "string" && (PROFILE_NAMES as readonly string[]).includes(value);
}

/** The profile a var names (`MIPI_PROFILE`), or the default when it is unset or unknown. */
export function profileOrDefault(value: string | undefined): ProfileName {
  return isProfileName(value) ? value : DEFAULT_PROFILE;
}

/** The profile table against the tools the installed extensions register. */
export class Profiles {
  readonly #table: ProfileTable;
  readonly #tools: ReadonlyMap<string, ToolRegistration>;

  constructor(table: ProfileTable, tools: ReadonlyMap<string, ToolRegistration>) {
    this.#table = table;
    this.#tools = tools;
  }

  description(profile: ProfileName): string {
    return this.#table[profile].description;
  }

  /** The tools a conversation on `profile` is offered: the only place profiles become tool registrations. */
  toolsFor(profile: ProfileName): ToolRegistration[] {
    return this.#table[profile].tools.flatMap((name) => {
      const tool = this.#tools.get(name);
      return tool === undefined ? [] : [tool];
    });
  }

  /** Every profile's tool names, in one string: a different one means some conversation may need new tools. */
  digest(): string {
    return JSON.stringify(
      PROFILE_NAMES.map((name) => [name, this.toolsFor(name).map((tool) => tool.name)]),
    );
  }
}
