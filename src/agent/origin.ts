/**
 * Input origin (COD-209, COD-210): where an input came from, read from its request id. Pi Durable stores the request id
 * with every input, so origin needs no document of its own and holds for inputs stored before it existed.
 *
 * Core owns the scheme, `<prefix>:<rest>`, but names no prefix: each door, and the reminders, registers its own
 * (`OriginRegistration`) with what it means and, where the id alone can't say, where a reply to it goes. An extension
 * reads origin through the agent's connectors (`connectors.ts`) and never parses an id itself.
 */
import { type ConversationId, LiveDoc, type SubmissionId, type Tx } from "./pi/durable.ts";
import type { DeliveryDestination } from "./delivery.ts";

/** Where one input came from. `automated` inputs were not sent by a person at that moment (a reminder's occurrence). */
export type InputOrigin = {
  /** The door or part that admitted it, as stored in what it leads to (a lesson's `from.source`). */
  readonly source: string;
  readonly automated: boolean;
};

/** An input whose id has no registered prefix, or none. */
export const UNKNOWN_ORIGIN: InputOrigin = { source: "unknown", automated: false };

/** One request-id prefix, registered by the door or extension that builds ids with it. */
export interface OriginRegistration {
  /** Letters only: the part of the id before the first colon. */
  readonly prefix: string;
  readonly source: string;
  readonly automated: boolean;
  /**
   * Where a reply to this input goes, when that isn't in the id (Telegram's chat is in the door's state). Undefined:
   * nothing to say for this input.
   */
  readonly replyTo?: (
    tx: Tx,
    input: { readonly submissionId: number; readonly requestId: string },
  ) => Promise<DeliveryDestination | undefined>;
}

/** One input of the running turn, with its origin. */
export type RunInput = {
  readonly submissionId: number;
  readonly requestId?: string;
  readonly origin: InputOrigin;
};

const PREFIX = /^[a-z]+$/;

/** The registered prefixes of one agent. */
export class Origins {
  readonly #registrations: ReadonlyMap<string, OriginRegistration>;
  readonly #origins: ReadonlyMap<string, InputOrigin>;

  /** A prefix registered twice, or one that isn't letters only, is a wiring mistake and throws. */
  constructor(registrations: readonly OriginRegistration[]) {
    const byPrefix = new Map<string, OriginRegistration>();
    for (const registration of registrations) {
      if (!PREFIX.test(registration.prefix)) {
        throw new Error(`Request-id prefix "${registration.prefix}" must be lowercase letters`);
      }
      if (byPrefix.has(registration.prefix)) {
        throw new Error(`Request-id prefix "${registration.prefix}" is registered twice`);
      }
      byPrefix.set(registration.prefix, registration);
    }
    this.#registrations = byPrefix;
    this.#origins = new Map(
      [...byPrefix].map(([prefix, { source, automated }]) => [prefix, { source, automated }]),
    );
  }

  /** The registered prefixes, in registration order. */
  prefixes(): readonly string[] {
    return [...this.#registrations.keys()];
  }

  #registration(requestId: string | undefined): OriginRegistration | undefined {
    if (requestId === undefined) return undefined;
    const colon = requestId.indexOf(":");
    return colon <= 0 ? undefined : this.#registrations.get(requestId.slice(0, colon));
  }

  /** The origin of one input, from its request id. Bound, so it can be passed on alone. */
  readonly originOf = (requestId: string | undefined): InputOrigin => {
    if (requestId === undefined) return UNKNOWN_ORIGIN;
    const colon = requestId.indexOf(":");
    if (colon <= 0) return UNKNOWN_ORIGIN;
    return this.#origins.get(requestId.slice(0, colon)) ?? UNKNOWN_ORIGIN;
  };

  /** The inputs the running turn answers (Pi Durable's `pi.live`), in order. Queued ones don't count yet. */
  async runInputs(tx: Tx, conversationId: ConversationId): Promise<readonly RunInput[]> {
    const placed = (await tx.doc(LiveDoc, conversationId)).run?.inputs ?? [];
    const inputs: RunInput[] = [];
    for (const id of placed) {
      const requestId = (await tx.submission(id as SubmissionId))?.requestId;
      inputs.push({
        submissionId: id,
        ...(requestId === undefined ? {} : { requestId }),
        origin: this.originOf(requestId),
      });
    }
    return inputs;
  }

  /**
   * The origin of the running turn. A turn can answer several inputs together; one a person sent names the turn before
   * an automated one does, since a reminder answered beside a person's message is not who asked.
   */
  async runOrigin(tx: Tx, conversationId: ConversationId): Promise<InputOrigin> {
    const origins = (await this.runInputs(tx, conversationId)).map(({ origin }) => origin);
    return (
      origins.find((origin) => !origin.automated && origin !== UNKNOWN_ORIGIN) ??
      origins[0] ??
      UNKNOWN_ORIGIN
    );
  }

  /** Whether the running turn answers only automated inputs (a reminder's own run). False with none. */
  async runAutomatedOnly(tx: Tx, conversationId: ConversationId): Promise<boolean> {
    const inputs = await this.runInputs(tx, conversationId);
    return inputs.length > 0 && inputs.every(({ origin }) => origin.automated);
  }

  /**
   * Where a reply to the running turn goes, from the first of its inputs whose registration names a place. Undefined
   * when none does (the web, the relay): the caller falls back to the conversation itself.
   */
  async replyTo(tx: Tx, conversationId: ConversationId): Promise<DeliveryDestination | undefined> {
    for (const input of await this.runInputs(tx, conversationId)) {
      const replyTo = this.#registration(input.requestId)?.replyTo;
      if (replyTo === undefined || input.requestId === undefined) continue;
      const destination = await replyTo(tx, {
        submissionId: input.submissionId,
        requestId: input.requestId,
      });
      if (destination !== undefined) return destination;
    }
    return undefined;
  }
}
