/** Shared test setup: the profile table against the built-in extensions' tools, as the Durable Object composes it. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  type ConversationId,
  defineExtension,
  type Extension,
  type Harness,
} from "@earendil-works/pi-durable";
import { Bots } from "../src/agent/conversations.ts";
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

/**
 * Gives the bots (MiPi, PiDu) a test agent's model. A test that opens its own harness over a Durable Object's storage
 * finds them made already, by the object's own start (`ensureBots`) with the lane's default model; the doors bind to
 * them, so a faux-model test must move them onto its model first.
 */
export async function botsOnModel(
  harness: Harness,
  model: { readonly provider: string; readonly modelId: string },
): Promise<void> {
  await harness.commit(async (tx) => {
    const bots = await tx.doc(Bots);
    for (const id of [bots.mainId, bots.piduId]) {
      if (id !== undefined) await configure(tx, id as ConversationId, { model });
    }
  }, BACKGROUND_CONTEXT);
}
