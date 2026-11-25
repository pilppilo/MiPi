/**
 * Answer settlement (COD-210): core's one loop that turns settled inputs into delivered messages. It watches every
 * input a door expects an answer for (the doors' pending sources) and every pending reminder, and when one settles runs
 * `reconcileAnswers()` (`proactive.ts`), which judges each answer once, over both kinds together, and enqueues its
 * messages through delivery in the same commit.
 *
 * It is a wake source, so the alarm runs it after a restart, and a commit that records a new pending input (a
 * reminder's occurrence, a door's message) makes it look again. Core code: it names no door.
 */
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import { type Harness, type SubmissionId, type Tx } from "./pi/durable.ts";
import type { Providers } from "./providers.ts";
import type { Connectors } from "./connectors.ts";
import { pendingSubmissions, PROACTIVE_DOC_KIND, reconcileAnswers } from "./proactive.ts";
import type { CommitChanges, SourceWake, WakeSource } from "./wake-sources.ts";
import { KeyedSerialQueue } from "../lib/serial.ts";
import { BotReplies, deliverBotReplies } from "./bot-messages.ts";

const context = BACKGROUND_CONTEXT;

export interface AnswerSettlementOptions {
  readonly harness: Harness;
  readonly connectors: Connectors;
  readonly providers?: Providers;
  /** Messages were enqueued: the doors may send them now rather than at the next alarm. */
  readonly onQueued?: () => void;
  /** The settlement's `wake()` changed. */
  readonly onWakeChange: () => void;
  readonly report: (message: string, error: unknown) => void;
  readonly now?: () => number;
}

export class AnswerSettlement implements WakeSource {
  readonly name = "answer settlement";
  readonly #options: AnswerSettlementOptions;
  readonly #now: () => number;
  readonly #queue = new KeyedSerialQueue<"reconcile">();
  readonly #watched = new Set<number>();
  #wake: SourceWake = { active: false };
  #replyDue: number | undefined;
  #closed = false;
  #refreshing = false;
  #refreshAgain = false;

  constructor(options: AnswerSettlementOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Active while any input waits for its answer, which keeps the heartbeat. */
  wake(): SourceWake {
    return this.#replyDue === undefined ? this.#wake : { ...this.#wake, at: this.#replyDue };
  }

  /** What the alarm runs: every settled input, delivered. */
  run(): Promise<void> {
    return this.reconcile();
  }

  /** A commit that changed the reminders' pending inputs or a door's may have added one to watch. */
  observes(publication: CommitChanges): boolean {
    return publication.changes.some(
      (change) =>
        change.type === "document" &&
        change.record !== undefined &&
        (change.record.kind === PROACTIVE_DOC_KIND ||
          this.#options.connectors.pendingDocKinds.has(change.record.kind)),
    );
  }

  /** Picks up what a previous instance left: watches every pending input, then delivers what settled meanwhile. */
  async start(): Promise<void> {
    if (this.#closed) return;
    const waiting = await this.#waiting();
    // Closed while it read (maintenance took the object): nothing more starts against a closing harness.
    if (this.#closed) return;
    for (const id of waiting) this.#watch(id);
    await this.reconcile();
  }

  /** Watches inputs recorded since the last look. A call while one runs makes it read once more. */
  refresh(): void {
    if (this.#closed) return;
    if (this.#refreshing) {
      this.#refreshAgain = true;
      return;
    }
    this.#refreshing = true;
    void (async () => {
      try {
        do {
          this.#refreshAgain = false;
          const waiting = await this.#waiting();
          if (this.#closed) return;
          for (const id of waiting) this.#watch(id);
        } while (this.#refreshAgain && !this.#closed);
      } catch (error) {
        if (!this.#closed) this.#options.report("Refreshing the answer settlement failed", error);
      } finally {
        this.#refreshing = false;
      }
    })();
  }

  /** Stops background work; what is pending stays stored for the next instance. */
  close(): void {
    this.#closed = true;
  }

  /** Turns every settled input into its messages, in the commit that clears it. */
  reconcile(): Promise<void> {
    return this.#queue.run("reconcile", async () => {
      if (this.#closed) return;
      const now = this.#now();
      const queued = await this.#commit((tx) =>
        reconcileAnswers(tx, now, this.#options.connectors, this.#options.providers),
      );
      if (this.#closed) return;
      if (queued) this.#options.onQueued?.();
      if (queued || this.#replyDue === undefined || this.#replyDue <= now) {
        const replies = (await this.#options.harness.snapshot(BotReplies, context))?.pending ?? [];
        if (this.#closed) return;
        if (replies.length === 0) {
          this.#setReplyDue(undefined);
          return;
        }
        // Keep an alarm armed if an admission throws before we can compute the next deadline.
        this.#setReplyDue(now + 60_000);
        const next = await deliverBotReplies(
          this.#options.harness,
          replies,
          this.#options.connectors.delivery,
          now,
        );
        this.#setReplyDue(next === Infinity ? undefined : next);
      }
    });
  }

  #setReplyDue(at: number | undefined): void {
    if (this.#closed || at === this.#replyDue) return;
    this.#replyDue = at;
    this.#options.onWakeChange();
  }

  /** Every pending input, read in a commit that also refreshes the wake from it. */
  async #waiting(): Promise<number[]> {
    let waiting: number[] = [];
    await this.#commit(
      async () => undefined,
      (pending) => (waiting = pending),
    );
    return waiting;
  }

  /** Waits for an input to settle, then delivers. Harmless to call twice. */
  #watch(submissionId: number): void {
    if (this.#watched.has(submissionId)) return;
    this.#watched.add(submissionId);
    void (async () => {
      try {
        const submission = await this.#options.harness.submission(
          submissionId as SubmissionId,
          context,
        );
        await submission?.wait(context);
        if (!this.#closed) await this.reconcile();
      } catch (error) {
        // A closing harness rejects the wait; the next instance watches again from the stored inputs.
        if (!this.#closed) this.#options.report("Watching an input for its answer failed", error);
      } finally {
        this.#watched.delete(submissionId);
      }
    })();
  }

  /**
   * A commit that also refreshes the wake from what is still pending, read once (`read` gets the same list). Closed
   * meanwhile, the wake is left alone, so a shutdown (an export, a restore) never arms the alarm again.
   */
  async #commit<T>(
    change: (tx: Tx) => T | Promise<T>,
    read?: (pending: number[]) => void,
  ): Promise<T> {
    let active = false;
    const result = await this.#options.harness.commit(async (tx) => {
      const value = await change(tx);
      const pending = await pendingSubmissions(tx, this.#options.connectors);
      read?.(pending);
      active = pending.length > 0;
      return value;
    }, context);
    if (this.#closed) return result;
    if (active !== this.#wake.active) {
      this.#wake = { active };
      this.#options.onWakeChange();
    }
    return result;
  }
}
