/**
 * The connectors a door or an extension reaches core through (COD-210): origin, delivery, and the inputs waiting for an
 * answer. Doors register them (`DoorRegistration`), extensions register origins (`MipiExtension.origins`), and
 * `composeAgent` builds one `Connectors` per agent from both.
 *
 * Tools and tasks reach the agent's connectors from their registry snapshot (`connectorsOf(api.registry)`), through a
 * binding on the agent's own core extension, the way untrusted tools are reached (`untrusted.ts`): nothing is shared
 * between compositions or left behind by an earlier one. Core code: it names no door and no extension.
 */
import type { Extension, RegistrySnapshot, Tx } from "./pi/durable.ts";
import { Delivery, type DeliveryAdapter, type DeliveryDestination } from "./delivery.ts";
import { type OriginRegistration, Origins } from "./origin.ts";
import { CORE_EXTENSION_NAME } from "./untrusted.ts";

/** One input a door admitted and answers: a "direct" expectation, delivered to `destination` when it settles. */
export type PendingInput = {
  readonly submissionId: number;
  readonly conversationId: number;
  readonly destination: DeliveryDestination;
};

/**
 * A door's inputs waiting for an answer. They stay in the door's own document (Telegram's `inputs`), so rolling back
 * reads them where they always were; core's one settlement loop reads them beside the reminders' (`proactive.ts`).
 */
export interface PendingSource {
  readonly name: string;
  /** Document kinds whose change may add a pending input: the settlement looks again after such a commit. */
  readonly docKinds: readonly string[];
  readPending(tx: Tx): Promise<readonly PendingInput[]>;
  /** Removes the settled inputs, in the commit that delivers their answers. */
  clearSettled(tx: Tx, submissionIds: ReadonlySet<number>): Promise<void>;
}

/** What one door registers with core. Its runtime (admitting, sending) stays with the composition root. */
export interface DoorRegistration {
  readonly name: string;
  readonly origins?: readonly OriginRegistration[];
  readonly delivery?: DeliveryAdapter;
  readonly pending?: PendingSource;
  /** A conversation's own transcript as a destination: where a reply goes when no door names a place. One door. */
  readonly transcript?: (conversationId: number) => DeliveryDestination;
}

/** The connectors of one agent. */
export interface Connectors {
  readonly origins: Origins;
  readonly delivery: Delivery;
  readonly pending: readonly PendingSource[];
  /** Every document kind a pending source watches. */
  readonly pendingDocKinds: ReadonlySet<string>;
}

/** Builds an agent's connectors from its doors and its extensions' origins. Duplicates throw. */
export function createConnectors(
  doors: readonly DoorRegistration[],
  extensionOrigins: readonly OriginRegistration[],
): Connectors {
  const names = new Set<string>();
  for (const { name } of doors) {
    if (names.has(name)) throw new Error(`Door "${name}" is registered twice`);
    names.add(name);
  }
  const transcripts = doors.flatMap(({ transcript }) =>
    transcript === undefined ? [] : [transcript],
  );
  if (transcripts.length > 1) throw new Error("More than one door registers a transcript");
  const pending = doors.flatMap((door) => (door.pending === undefined ? [] : [door.pending]));
  return {
    origins: new Origins([...doors.flatMap((door) => door.origins ?? []), ...extensionOrigins]),
    delivery: new Delivery(
      doors.flatMap((door) => (door.delivery === undefined ? [] : [door.delivery])),
      transcripts[0],
    ),
    pending,
    pendingDocKinds: new Set(pending.flatMap(({ docKinds }) => docKinds)),
  };
}

const bound = new WeakMap<Extension, Connectors>();

/** Records the composition's connectors on its core extension (`composeAgent`). */
export function bindConnectors(core: Extension, connectors: Connectors): void {
  bound.set(core, connectors);
}

/**
 * The connectors of the agent a registry belongs to (a tool's `api.registry`, a task's `runtime.registry`). Throws when
 * none were bound: a tool or task run outside a composed agent has nothing to deliver through.
 */
export function connectorsOf(registry: Pick<RegistrySnapshot, "extension">): Connectors {
  const core = registry.extension(CORE_EXTENSION_NAME);
  const connectors = core === undefined ? undefined : bound.get(core);
  if (connectors === undefined) throw new Error("This agent has no connectors bound");
  return connectors;
}
