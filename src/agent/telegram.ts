/**
 * The Telegram door's state and work inside the agent: admitting updates, commands, turning settled inputs into
 * replies, and draining the outbox. The Worker only authenticates the webhook and parses the update
 * (`src/lib/telegram-update.ts`); the Durable Object wires this to its alarm.
 *
 * Every admitted update leaves a receipt keyed by its `update_id`, in one session document shared by every
 * conversation, so a replay is acknowledged and does nothing, also after `/new` or a restart. A text message is
 * submitted to its chat's bound conversation with request id `tg:<update_id>`, and its chat is recorded with the
 * submission: the reply goes back to that chat when the submission settles, whatever the chat is bound to by then.
 */
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  configure,
  type ConversationId,
  defineDoc,
  type EntryRecord,
  type Harness,
  type SubmissionId,
} from "./pi/durable.ts";
import { boundConversation, ConversationMeta, profileOf, setProfile } from "./conversations.ts";
import type { ModelList } from "./model-list.ts";
import { isProfileName, PROFILE_NAMES, PROFILES, type ProfileName } from "./profiles.ts";
import { stampInput } from "./stamp.ts";
import {
  enqueueReply,
  nextOutboxWake,
  type PickedSend,
  pickSend,
  recordSend,
  sendKey,
  settleStale,
  TelegramOutbox,
  type TelegramSend,
} from "./telegram-outbox.ts";
import { KeyedSerialQueue } from "../lib/serial.ts";
import { telegramRequest } from "../lib/requests.ts";
import type { TelegramInbound } from "../lib/telegram-update.ts";

const context = BACKGROUND_CONTEXT;

type Tx = Parameters<typeof configure>[0];

/** A receipt is kept at least this long after its update was admitted (Telegram retries for about a day). */
export const RECEIPT_WINDOW_MS = 48 * 60 * 60_000;
/** And at most this many, oldest dropped first; the pending ones are kept regardless. */
export const RECEIPTS_KEPT = 2_000;
/** Sends per drain, so one alarm can't run for long. */
export const SENDS_PER_DRAIN = 20;

export type TelegramChannelState = {
  /** Admitted `update_id`s, oldest first. */
  receipts: Array<{ updateId: number; at: number }>;
  /** Inputs submitted and not settled yet, with the chat their reply goes to. */
  inputs: Array<{
    updateId: number;
    chatId: number;
    conversationId: number;
    submissionId: number;
  }>;
  /** Commands admitted that still need an outside lookup (`/model <id>` reads the live model list). */
  commands: Array<{ updateId: number; chatId: number; conversationId: number; model: string }>;
};

export const TelegramChannel = defineDoc<TelegramChannelState>({
  kind: "app.telegram",
  version: 1,
  scope: "session",
  initial: () => ({ receipts: [], inputs: [], commands: [] }),
  checkpointWhen: (value) => value.inputs.length === 0 && value.commands.length === 0,
});

/** The chat key a Telegram chat's binding lives under (`conversations.ts`). */
export const telegramBinding = (chatId: number): string => `tg:${chatId}`;

export const HELP_TEXT =
  "Hi, I'm MiPi. Send me a message and I'll answer here.\n\n" +
  "/new starts a new conversation\n" +
  "/profile shows or sets the tool profile\n" +
  "/model shows or sets the model\n" +
  "/version shows the version";

export const NON_TEXT_HINT = "I can only read text messages for now.";

function hasReceipt(state: TelegramChannelState, updateId: number): boolean {
  return state.receipts.some((receipt) => receipt.updateId === updateId);
}

/** Records a receipt and drops the ones past the replay window, keeping every pending one. */
export function addReceipt(state: TelegramChannelState, updateId: number, now: number): void {
  state.receipts.push({ updateId, at: now });
  const pending = new Set([
    ...state.inputs.map((input) => input.updateId),
    ...state.commands.map((command) => command.updateId),
  ]);
  let excess = state.receipts.length - RECEIPTS_KEPT;
  state.receipts = state.receipts.filter((receipt) => {
    if (pending.has(receipt.updateId)) return true;
    const expired = now - receipt.at > RECEIPT_WINDOW_MS;
    if (expired || excess > 0) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

/** The visible text of an answer: its text parts, without thinking. */
export function answerText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.find((candidate) => candidate.role === "assistant");
  if (message === undefined || message.role !== "assistant") return "";
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

export interface TelegramChannelOptions {
  readonly harness: Harness;
  /** Who every Telegram message is from, for the stamp. */
  readonly owner: string;
  readonly timeZone: string | undefined;
  /** The profile a chat's first conversation starts on. */
  readonly profile: ProfileName;
  readonly version: string;
  readonly modelList: ModelList;
  readonly send: TelegramSend;
  /** Arms the recovery alarm; called before any commit that can start work. */
  readonly armAlarm: () => Promise<void>;
  /** The channel's `wake()` may have changed. */
  readonly onWakeChange: () => void;
  /** A text message was submitted: the door-independent follow-ups (titles, snapshots). */
  readonly onSubmitted?: (conversationId: ConversationId, text: string) => Promise<void>;
  readonly report: (message: string, error: unknown, details?: Record<string, unknown>) => void;
  readonly now?: () => number;
}

/** What the channel needs from the alarm: a time to send at, and whether work can run (the heartbeat). */
export type TelegramWake = { readonly at?: number; readonly active: boolean };

export class TelegramChannelRuntime {
  readonly #options: TelegramChannelOptions;
  readonly #now: () => number;
  readonly #queue = new KeyedSerialQueue<"admit" | "reconcile" | "commands" | "drain">();
  /** Sends whose request is running now: a `sending` chunk outside this set was cut off. */
  readonly #inFlight = new Set<string>();
  readonly #watched = new Set<number>();
  #wake: TelegramWake = { active: false };
  #closed = false;

  constructor(options: TelegramChannelOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** What the channel has waiting, as of its last commit. */
  wake(): TelegramWake {
    return this.#wake;
  }

  /** Picks up what a previous instance left: watches pending inputs, then runs commands and the outbox. */
  async start(): Promise<void> {
    // Plain values only leave a commit: its documents are drafts that end with it.
    const submissions = await this.#commit(async (tx) =>
      (await tx.doc(TelegramChannel)).inputs.map(({ submissionId }) => submissionId),
    );
    for (const submissionId of submissions) this.#watch(submissionId as SubmissionId);
    await this.recover();
  }

  /** Stops background work; what is pending stays stored for the next instance. */
  close(): void {
    this.#closed = true;
  }

  /** Everything that may be due: settled inputs, deferred commands, and the outbox. Each part fails on its own. */
  async recover(): Promise<void> {
    for (const [name, work] of [
      ["reconcile", () => this.reconcile()],
      ["commands", () => this.runCommands()],
      ["drain", () => this.drain()],
    ] as const) {
      try {
        await work();
      } catch (error) {
        this.#options.report(`Telegram ${name} failed`, error);
      }
    }
  }

  /**
   * Admits one update durably and returns once it is stored: the input submitted, or the command's effect and reply
   * committed (or, for a lookup, the command recorded). A replay is stored already and admits nothing.
   */
  admit(update: TelegramInbound): Promise<void> {
    return this.#queue.run("admit", () => this.#admit(update));
  }

  async #admit(update: TelegramInbound): Promise<void> {
    const conversationId = await this.#commit((tx) =>
      boundConversation(tx, telegramBinding(update.chatId), this.#options.profile),
    );
    switch (update.kind) {
      case "text":
        return this.#admitText(update, conversationId);
      case "command":
        return this.#admitCommand(update, conversationId);
      case "non-text":
        await this.#reply(update.updateId, update.chatId, () => NON_TEXT_HINT);
        return;
      default: {
        const _: never = update;
        throw new Error("Unknown Telegram update");
      }
    }
  }

  async #admitText(
    update: Extract<TelegramInbound, { kind: "text" }>,
    conversationId: ConversationId,
  ): Promise<void> {
    const conversation = await this.#options.harness.conversation(conversationId, context);
    if (conversation === undefined) throw new Error(`Conversation ${conversationId} is missing`);
    const requestId = telegramRequest(update.updateId);
    const content = stampInput(this.#options.owner, update.text, this.#options.timeZone);
    // As for the web door: arm before admitting work. An early alarm is harmless; a missing one strands the turn.
    await this.#options.armAlarm();
    const submissionId = await this.#commit(async (tx) => {
      const state = await tx.doc(TelegramChannel);
      if (hasReceipt(state, update.updateId)) return undefined;
      // Pi Durable's `submit(tx, …)` must come before any table write in this commit: read, submit, then write.
      const existing = await tx.submissionByRequest(conversationId, requestId);
      const id =
        existing?.id ??
        (await conversation.submit(tx, {
          type: "input",
          content,
          requestId,
          // Queue behind a running turn instead of rejecting, as the web door does.
          whenBusy: "followUp",
        }));
      addReceipt(state, update.updateId, this.#now());
      // An input admitted before, whose receipt is gone, was answered then: nothing to send again.
      if (existing !== undefined) return undefined;
      state.inputs.push({
        updateId: update.updateId,
        chatId: update.chatId,
        conversationId,
        submissionId: id,
      });
      return id;
    });
    if (submissionId === undefined) return;
    this.#watch(submissionId);
    try {
      await this.#options.onSubmitted?.(conversationId, update.text);
    } catch (error) {
      this.#options.report("Telegram follow-up after a submit failed", error, { conversationId });
    }
  }

  async #admitCommand(
    update: Extract<TelegramInbound, { kind: "command" }>,
    conversationId: ConversationId,
  ): Promise<void> {
    const { argument, chatId, updateId } = update;
    switch (update.command) {
      case "start":
        await this.#reply(updateId, chatId, () => HELP_TEXT);
        return;
      case "version":
        await this.#reply(updateId, chatId, () => `MiPi ${this.#options.version}`);
        return;
      case "new":
        await this.#reply(updateId, chatId, async (tx) => {
          await boundConversation(tx, telegramBinding(chatId), this.#options.profile, {
            rebind: true,
          });
          return "Started a new conversation.";
        });
        return;
      case "profile":
        await this.#reply(updateId, chatId, async (tx) => {
          if (argument.length === 0) {
            const current = profileOf(await tx.doc(ConversationMeta, conversationId));
            return `Profile: ${current} (${PROFILES[current].description}).\nPick one with /profile <name>: ${PROFILE_NAMES.join(", ")}.`;
          }
          const name = argument.toLowerCase();
          if (!isProfileName(name)) {
            return `${argument} is not a profile. Pick one of: ${PROFILE_NAMES.join(", ")}.`;
          }
          await setProfile(tx, conversationId, name);
          return `Profile set to ${name}.`;
        });
        return;
      case "model": {
        if (argument.length === 0) {
          const conversation = await this.#options.harness.conversation(conversationId, context);
          const model = (await conversation?.agent(context))?.model?.modelId ?? "unknown";
          await this.#reply(
            updateId,
            chatId,
            () => `Model: ${model}.\nChange it with /model <id>.`,
          );
          return;
        }
        // The live model list is an outside lookup: record the command now, answer it after the webhook returns.
        const recorded = await this.#commit(async (tx) => {
          const state = await tx.doc(TelegramChannel);
          if (hasReceipt(state, updateId)) return false;
          state.commands.push({ updateId, chatId, conversationId, model: argument });
          addReceipt(state, updateId, this.#now());
          return true;
        });
        if (recorded) void this.runCommands().catch(() => undefined);
        return;
      }
      default: {
        const _: never = update.command;
        throw new Error("Unknown Telegram command");
      }
    }
  }

  /**
   * One command's effect and reply in one commit, with its receipt: a replay finds the receipt and does nothing, and a
   * crash before the commit leaves nothing done, so Telegram's retry runs it again.
   */
  async #reply(
    updateId: number,
    chatId: number,
    effect: (tx: Tx) => string | Promise<string>,
  ): Promise<void> {
    const queued = await this.#commit(async (tx) => {
      const state = await tx.doc(TelegramChannel);
      if (hasReceipt(state, updateId)) return false;
      const text = await effect(tx);
      addReceipt(state, updateId, this.#now());
      enqueueReply(
        await tx.doc(TelegramOutbox),
        { id: `cmd:${updateId}`, chatId, text },
        this.#now(),
      );
      return true;
    });
    if (queued) this.#kickDrain();
  }

  /** Answers deferred commands in admission order. Each is removed in the commit that answers it. */
  runCommands(): Promise<void> {
    return this.#queue.run("commands", async () => {
      const commands = await this.#commit(async (tx) =>
        (await tx.doc(TelegramChannel)).commands.map((command) => ({ ...command })),
      );
      for (const command of commands) {
        if (this.#closed) return;
        let model: { provider: string; modelId: string } | undefined;
        let refusal: string | undefined;
        try {
          model = await this.#options.modelList.require(command.model);
        } catch (error) {
          refusal = error instanceof Error ? error.message : String(error);
        }
        await this.#commit(async (tx) => {
          const state = await tx.doc(TelegramChannel);
          const index = state.commands.findIndex(({ updateId }) => updateId === command.updateId);
          if (index === -1) return;
          state.commands.splice(index, 1);
          let text: string;
          if (model !== undefined) {
            await configure(tx, command.conversationId as ConversationId, { model });
            text = `Model set to ${model.modelId}.`;
          } else {
            text = refusal ?? `${command.model} is not available.`;
          }
          enqueueReply(
            await tx.doc(TelegramOutbox),
            { id: `cmd:${command.updateId}`, chatId: command.chatId, text },
            this.#now(),
          );
        });
        this.#kickDrain();
      }
    });
  }

  /** Waits for an input to settle, then turns it into a reply. Harmless to call twice. */
  #watch(submissionId: SubmissionId): void {
    if (this.#watched.has(submissionId)) return;
    this.#watched.add(submissionId);
    void (async () => {
      try {
        const submission = await this.#options.harness.submission(submissionId, context);
        await submission?.wait(context);
        if (!this.#closed) await this.reconcile();
      } catch (error) {
        // A closing harness rejects the wait; the next instance watches again from the stored inputs.
        if (!this.#closed) this.#options.report("Watching a Telegram input failed", error);
      } finally {
        this.#watched.delete(submissionId);
      }
    })();
  }

  /**
   * Turns every settled input into its reply, in the commit that removes it from the pending inputs: an answer goes
   * to the chat the input came from; an input that ended without an answer gets a short notice instead. Inputs that
   * one run answered together get the answer once per chat.
   */
  reconcile(): Promise<void> {
    return this.#queue.run("reconcile", async () => {
      const queued = await this.#commit(async (tx) => {
        const state = await tx.doc(TelegramChannel);
        if (state.inputs.length === 0) return false;
        const outbox = await tx.doc(TelegramOutbox);
        const now = this.#now();
        const kept: TelegramChannelState["inputs"] = [];
        let changed = false;
        for (const input of state.inputs) {
          const stored = await tx.submission(input.submissionId as SubmissionId);
          const record = stored?.type === "input" ? stored : undefined;
          if (record?.status === "queued" || record?.status === "placed") {
            kept.push(input);
            continue;
          }
          changed = true;
          if (record?.status === "done") {
            enqueueReply(
              outbox,
              {
                id: `answer:${record.answer}:${input.chatId}`,
                chatId: input.chatId,
                text: answerText(await tx.entry(record.answer)),
              },
              now,
            );
          } else {
            const reason = record === undefined ? "its record is gone" : record.reason;
            enqueueReply(
              outbox,
              {
                id: `unanswered:${input.submissionId}`,
                chatId: input.chatId,
                text: `I couldn't answer that message (${reason}). Send it again to retry.`,
              },
              now,
            );
          }
        }
        if (changed) state.inputs = kept;
        return changed;
      });
      if (queued) this.#kickDrain();
    });
  }

  #kickDrain(): void {
    if (this.#closed) return;
    void this.drain().catch((error) => this.#options.report("Telegram drain failed", error));
  }

  /** Sends what may go out now, at most `SENDS_PER_DRAIN` chunks; the alarm brings the rest. */
  drain(): Promise<void> {
    return this.#queue.run("drain", async () => {
      for (let sent = 0; sent < SENDS_PER_DRAIN && !this.#closed; sent++) {
        const send = await this.#commit(async (tx) =>
          pickSend(await tx.doc(TelegramOutbox), this.#now(), this.#inFlight),
        );
        if (send === undefined) break;
        await this.#send(send);
      }
      // Records any chunk a lost instance left `sending`, and refreshes the wake.
      await this.#commit(async (tx) => settleStale(await tx.doc(TelegramOutbox), this.#inFlight));
    });
  }

  async #send(send: PickedSend): Promise<void> {
    const key = sendKey(send);
    this.#inFlight.add(key);
    try {
      let result;
      try {
        result = await this.#options.send(send.chatId, send.text);
      } catch (error) {
        result = {
          kind: "unknown" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.kind !== "sent") {
        this.#options.report("A Telegram send did not go through", new Error(result.reason), {
          reply: send.replyId,
          chunk: send.index,
          outcome: result.kind,
        });
      }
      await this.#commit(async (tx) =>
        recordSend(await tx.doc(TelegramOutbox), send, result, this.#now()),
      );
    } finally {
      this.#inFlight.delete(key);
    }
  }

  /** A commit that also refreshes the channel's wake from the documents it leaves. */
  async #commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T> {
    let wake: TelegramWake | undefined;
    const result = await this.#options.harness.commit(async (tx) => {
      const value = await change(tx);
      const state = await tx.doc(TelegramChannel);
      const outbox = await tx.doc(TelegramOutbox);
      const at = nextOutboxWake(outbox, this.#now());
      wake = {
        active: state.inputs.length > 0 || state.commands.length > 0,
        ...(at === undefined ? {} : { at }),
      };
      return value;
    }, context);
    if (wake !== undefined && (wake.at !== this.#wake.at || wake.active !== this.#wake.active)) {
      this.#wake = wake;
      this.#options.onWakeChange();
    }
    return result;
  }
}
