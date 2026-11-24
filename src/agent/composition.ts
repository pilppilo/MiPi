/**
 * The composition root's agent (COD-208, COD-210): core plus the built-in extensions, the doors' registrations and the
 * profile table. Only this file and `agent-do.ts` in `src/agent/` may import from `src/extensions/` or `src/doors/`
 * (lint-enforced). Tests open the agent through here, and a test that needs fewer extensions passes its own list
 * (`extensions: []` opens bare core).
 */
import type { HarnessOptions } from "./pi/durable.ts";
import { type AgentComposition, composeAgent, type HarnessConfig } from "./harness.ts";
import { BUILT_IN_EXTENSIONS } from "../extensions/builtins.ts";
import { DOORS } from "../doors/index.ts";
import { PROFILE_TABLE } from "../extensions/profiles.ts";

export type AgentConfig = Omit<HarnessConfig, "extensions" | "profiles" | "doors"> &
  Partial<Pick<HarnessConfig, "extensions" | "profiles" | "doors">>;

/** The agent with MiPi's built-in extensions, unless `config.extensions` says otherwise. */
export function composeMipi(config: AgentConfig = {}): AgentComposition {
  return composeAgent({
    ...config,
    extensions: config.extensions ?? BUILT_IN_EXTENSIONS,
    doors: config.doors ?? DOORS,
    profiles: config.profiles ?? PROFILE_TABLE,
  });
}

/** Pi Durable's options for the composed agent. */
export function createHarnessOptions(config: AgentConfig = {}): HarnessOptions {
  return composeMipi(config).options;
}
