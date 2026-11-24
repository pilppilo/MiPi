/** Shared test setup: the profile table against the built-in extensions' tools, as the Durable Object composes it. */
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import { composeMipi } from "../src/agent/composition.ts";
import { bindConnectors } from "../src/agent/connectors.ts";
import { CORE_EXTENSION_NAME } from "../src/agent/untrusted.ts";

export const PROFILES = composeMipi().profiles;

/**
 * An empty core extension carrying MiPi's connectors (the doors' and the reminders'), for a test that installs a tool
 * in a bare registry: the tool finds its agent's connectors through it, as in a composed agent.
 */
export function connectedCore(): Extension {
  const core = defineExtension({ name: CORE_EXTENSION_NAME });
  bindConnectors(core, composeMipi().connectors);
  return core;
}
