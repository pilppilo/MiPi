/**
 * Delivery (COD-209, COD-210): where a message for the owner goes, and how it gets there, with no door named in core.
 *
 * - **Destinations** are opaque to core. A door gives meaning to its `kind` (Telegram: `{ kind: "telegram", chatId }`;
 *   the web: `{ kind: "web", conversationId }`); core only stores and passes them on. The stored shape is the
 *   reminders' destination as 0.1.0-beta.1 wrote it, so existing data reads unchanged.
 * - **Adapters.** A door registers one per kind (`DeliveryAdapter`). It says whether its destinations can take a
 *   message nobody is waiting for (`canPush`: Telegram yes; the web no, its answers stay in the transcript), and
 *   enqueues messages in the door's own outbox.
 * - **Inside the commit.** `send` and `tellOwner` enqueue in the caller's transaction, never out of band, so a state
 *   change and its notice are stored together: a crash between them drops neither and repeats neither. A message id
 *   enqueued twice is enqueued once.
 * - **Delivered.** A door reports a confirmed proactive send back to core with `onDelivered` (`proactive.ts`).
 */
import type { Tx } from "./pi/durable.ts";

export type DeliveryDestination = {
  readonly kind: string;
  readonly [field: string]: string | number;
};

/** One message for a destination. */
export type DeliveryMessage = {
  /** Stable: enqueueing the same id twice is a no-op (`answer:<entry>:<key>`, `cap:<day>`, …). */
  readonly id: string;
  readonly text: string;
  /** A proactive answer's source (a reminder's id): once confirmed, it joins the recent sends. Never on notices. */
  readonly proactive?: { readonly sourceId: string };
  /** Highest hop of the turn that answered, for bot follow-ups. */
  readonly botHop?: number;
};

type AdapterBase = {
  readonly kind: string;
  /** The destination's part of a message id, unique within its kind (Telegram: the chat id). */
  key(destination: DeliveryDestination): string;
  /** How the destination reads to the owner, e.g. "this Telegram chat". */
  describe(destination: DeliveryDestination): string;
};

/** A door's delivery for one destination kind. */
export type DeliveryAdapter =
  | (AdapterBase & {
      readonly canPush: true;
      /** Enqueues `message` in the caller's transaction. */
      send(
        tx: Tx,
        destination: DeliveryDestination,
        message: DeliveryMessage,
        now: number,
      ): Promise<void>;
      /** Where the owner can be told something when nothing names a place (Telegram: the chat that wrote last). */
      ownerDestination?(tx: Tx): Promise<DeliveryDestination | undefined>;
    })
  | (AdapterBase & { readonly canPush: false });

/** The registered adapters of one agent. */
export class Delivery {
  readonly #adapters: ReadonlyMap<string, DeliveryAdapter>;
  readonly #transcript: ((conversationId: number) => DeliveryDestination) | undefined;

  /**
   * `transcript` is the destination of a conversation's own transcript, where a reply goes when no door names a place
   * (the web door's). A kind registered twice is a wiring mistake and throws.
   */
  constructor(
    adapters: readonly DeliveryAdapter[],
    transcript?: (conversationId: number) => DeliveryDestination,
  ) {
    const byKind = new Map<string, DeliveryAdapter>();
    for (const adapter of adapters) {
      if (byKind.has(adapter.kind)) {
        throw new Error(`Delivery kind "${adapter.kind}" is registered twice`);
      }
      byKind.set(adapter.kind, adapter);
    }
    this.#adapters = byKind;
    this.#transcript = transcript;
  }

  /** The registered kinds, in registration order. */
  kinds(): readonly string[] {
    return [...this.#adapters.keys()];
  }

  /** Whether `destination` takes a message nobody is waiting for. An unknown kind can't. */
  canPush(destination: DeliveryDestination): boolean {
    return this.#adapters.get(destination.kind)?.canPush === true;
  }

  /** The destination's part of a message id; its kind and key, for telling two destinations apart. */
  key(destination: DeliveryDestination): string {
    const adapter = this.#adapters.get(destination.kind);
    return adapter === undefined ? JSON.stringify(destination) : adapter.key(destination);
  }

  /** Kind and key together: equal exactly for the same destination. */
  identity(destination: DeliveryDestination): string {
    return `${destination.kind}:${this.key(destination)}`;
  }

  /** How the destination reads to the owner. */
  describe(destination: DeliveryDestination): string {
    return this.#adapters.get(destination.kind)?.describe(destination) ?? "this conversation";
  }

  /** The conversation's own transcript, where a reply goes when no door names a place. */
  transcriptOf(conversationId: number): DeliveryDestination {
    if (this.#transcript === undefined) {
      throw new Error("No door registered a transcript destination");
    }
    return this.#transcript(conversationId);
  }

  /**
   * Enqueues `message` for `destination` in the caller's transaction. Returns false, enqueueing nothing, when the
   * destination can't push (or its kind isn't registered): its answer is in the transcript already.
   */
  async send(
    tx: Tx,
    destination: DeliveryDestination,
    message: DeliveryMessage,
    now: number,
  ): Promise<boolean> {
    const adapter = this.#adapters.get(destination.kind);
    if (adapter === undefined || !adapter.canPush) return false;
    await adapter.send(tx, destination, message, now);
    return true;
  }

  /**
   * Tells the owner `notice`, in the caller's transaction: at `prefer` when it can push, otherwise where the first
   * adapter that knows one says the owner is. Returns whether anyone was told; with nobody to tell, nothing is enqueued.
   */
  async tellOwner(
    tx: Tx,
    notice: { readonly id: string; readonly text: string },
    now: number,
    prefer?: DeliveryDestination,
  ): Promise<boolean> {
    if (prefer !== undefined && this.canPush(prefer)) {
      return this.send(tx, prefer, notice, now);
    }
    for (const adapter of this.#adapters.values()) {
      if (!adapter.canPush || adapter.ownerDestination === undefined) continue;
      const destination = await adapter.ownerDestination(tx);
      if (destination !== undefined) return this.send(tx, destination, notice, now);
    }
    return false;
  }
}
