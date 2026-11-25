/**
 * The Telegram door's work inside the agent: admitting updates, commands, and draining the outbox. The Worker only
 * authenticates the webhook and parses the update (`update.ts`); the Durable Object wires this to its alarm. Turning a
 * settled input into its reply is core's (`src/agent/answers.ts`), which reads this door's pending inputs and sends
 * through its delivery adapter (`index.ts`).
 *
 * Every admitted update leaves a receipt keyed by its `update_id`, in one session document shared by every
 * conversation, so a replay is acknowledged and does nothing, also after `/new` or a restart. A text message is
 * submitted to its chat's bound conversation with request id `tg:<update_id>`, and its chat is recorded with the
 * submission: the reply goes back to that chat when the submission settles, whatever the chat is bound to by then.
 */
import { BACKGROUND_CONTEXT } from "../../agent/pi/context.ts";
import {
  configure,
  type Conversation,
  type ConversationId,
  ConversationIdle,
  type Harness,
  InboxDoc,
  LiveDoc,
  type SubmissionId,
  type Tx,
} from "../../agent/pi/durable.ts";
import {
  boundConversation,
  ConversationMeta,
  profileOf,
  profileRefusal,
  setProfile,
} from "../../agent/conversations.ts";
import type { Delivery } from "../../agent/delivery.ts";
import { isPaused, isPausedNow, PAUSED_REPLY, warnOwnerOverCap } from "../../agent/gates.ts";
import type { ModelList } from "../../agent/model-list.ts";
import {
  isProfileName,
  PICKABLE_PROFILES,
  type ProfileName,
  type Profiles,
} from "../../agent/profiles.ts";
import { onDelivered } from "../../agent/proactive.ts";
import { stampInput } from "../../agent/stamp.ts";
import type { CommitChanges } from "../../agent/wake-sources.ts";
import { KeyedSerialQueue } from "../../lib/serial.ts";
import { telegramDestination } from "./index.ts";
import {
  enqueueReply,
  nextOutboxWake,
  OUTBOX_DOC_KIND,
  type PickedSend,
  pickSend,
  recordSend,
  settleStale,
  TelegramOutbox,
} from "./outbox.ts";
import type { TelegramSend } from "./bot-api.ts";
import { telegramBatchRequest, telegramRequest } from "./requests.ts";
import { TELEGRAM_DOC_KIND, TelegramChannel, type TelegramChannelState } from "./state.ts";
import type { TelegramInbound } from "./update.ts";

const context = BACKGROUND_CONTEXT;

/** A receipt is kept at least this long after its update was admitted (Telegram retries for about a day). */
export const RECEIPT_WINDOW_MS = 48 * 60 * 60_000;
/** And at most this many, oldest dropped first; the pending ones are kept regardless. */
export const RECEIPTS_KEPT = 2_000;
/** Sends per drain, so one alarm can't run for long. */
export const SENDS_PER_DRAIN = 20;
/** An idle chat's messages wait this long after the first one, then go to the model together (COD-174). */
export const BATCH_WINDOW_MS = 2_000;
/** A window is sent early once it holds this many messages… */
export const BATCH_MAX_MESSAGES = 50;
/** …or this many UTF-16 code units of text, the unit the outbox counts in too. */
export const BATCH_MAX_UNITS = 32_000;

export { type StagedWindow, TelegramChannel, type TelegramChannelState } from "./state.ts";

/**
 * Whether a commit changed the door's documents: then another part of the agent (core's answer settlement, a reminder
 * or a notice) may have queued a message, and `refresh()` sends it.
 */
export function isTelegramChange(publication: CommitChanges): boolean {
  return publication.changes.some(
    (change) =>
      change.type === "document" &&
      (change.record?.kind === TELEGRAM_DOC_KIND || change.record?.kind === OUTBOX_DOC_KIND),
  );
}

/** The chat key a Telegram chat's binding lives under (`conversations.ts`). */
export const telegramBinding = (chatId: number): string => `tg:${chatId}`;

export const HELP_TEXT =
  "Hi, I'm MiPi. Send me a message and I'll answer here.\n\n" +
  "/new starts a new conversation\n" +
  "/profile shows or sets the tool profile\n" +
  "/model shows or sets the model\n" +
  "/usage shows today's spend and usage\n" +
  "/version shows the version";

export const NON_TEXT_HINT = "I can only read text messages for now.";

export const BUSY_REPLY = "I'm still working on your last message; try again in a moment.";

/** A window's messages as one input: one stamp, at the first message's time, then the texts in order. */
export function batchContent(
  owner: string,
  timeZone: string | undefined,
  messages: readonly { readonly text: string; readonly at: number }[],
): string {
  return stampInput(owner, batchText(messages), timeZone, messages[0]!.at);
}

/** A window's texts joined as the model sees them; also what titles the conversation. */
const batchText = (messages: readonly { readonly text: string }[]): string =>
  messages.map(({ text }) => text).join("\n\n");

const batchUnits = (messages: readonly { readonly text: string }[]): number =>
  messages.reduce((total, { text }) => total + text.length, 0);

function hasReceipt(state: TelegramChannelState, updateId: number): boolean {
  return state.receipts.some((receipt) => receipt.updateId === updateId);
}

/** Records a receipt and drops the ones past the replay window, keeping every pending one. */
export function addReceipt(state: TelegramChannelState, updateId: number, now: number): void {
  state.receipts.push({ updateId, at: now });
  const pending = new Set([
    ...state.inputs.flatMap((input) => (input.updateId === undefined ? [] : [input.updateId])),
    ...state.commands.map((command) => command.updateId),
    ...(state.staged ?? []).flatMap((window) => window.messages.map(({ updateId }) => updateId)),
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

export interface TelegramChannelOptions {
  readonly harness: Harness;
  /** Who every Telegram message is from, for the stamp. */
  readonly owner: string;
  readonly timeZone: string | undefined;
  /** The profile a chat's first conversation starts on. */
  readonly profile: ProfileName;
  /** The profile table, against the installed extensions' tools. */
  readonly profiles: Profiles;
  readonly version: string;
  readonly modelList: ModelList;
  readonly send: TelegramSend;
  /** Core's delivery: the over-the-cap warning goes back to the chat that wrote through it. */
  readonly delivery: Delivery;
  /** Arms the recovery alarm; called before any commit that can start work. */
  readonly armAlarm: () => Promise<void>;
  /** The channel's `wake()` may have changed. */
  readonly onWakeChange: () => void;
  /** The usage readout as text, for `/usage` (M9). Unset: the command says it isn't available. */
  readonly usage?: () => Promise<string>;
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
  readonly #queue = new KeyedSerialQueue<"admit" | "commands" | "drain">();
  /** Sends whose request is running now: a `sending` chunk outside this set was cut off. */
  readonly #inFlight = new Set<string>();
  #wake: TelegramWake = { active: false };
  #closed = false;
  #refreshing = false;
  #refreshAgain = false;

  constructor(options: TelegramChannelOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** What the channel has waiting, as of its last commit. */
  wake(): TelegramWake {
    return this.#wake;
  }

  /** Picks up what a previous instance left: windows, commands and the outbox. */
  async start(): Promise<void> {
    await this.recover();
  }

  /**
   * Sends what another part of the agent queued (an answer core settled, a reminder's message, a notice): refreshes the
   * wake and drains what is due. Harmless to call often; a call while one runs makes it read once more.
   */
  refresh(): void {
    if (this.#closed) return;
    if (this.#refreshing) {
      // Read again once the running pass ends, so a message queued during it isn't missed.
      this.#refreshAgain = true;
      return;
    }
    this.#refreshing = true;
    void (async () => {
      try {
        do {
          this.#refreshAgain = false;
          await this.#commit(() => undefined);
        } while (this.#refreshAgain && !this.#closed);
        // A message queued elsewhere goes out now rather than at the next alarm. Not while one is in flight: that
        // send's own commit refreshes again when it ends.
        const { at } = this.#wake;
        if (at !== undefined && at <= this.#now() && this.#inFlight.size === 0) this.#kickDrain();
      } catch (error) {
        if (!this.#closed) this.#options.report("Refreshing the Telegram door failed", error);
      } finally {
        this.#refreshing = false;
      }
    })();
  }

  /** Stops background work; what is pending stays stored for the next instance. */
  close(): void {
    this.#closed = true;
  }

  /**
   * Everything that may be due: windows past their deadline, deferred commands, and the outbox. Each part fails on its
   * own.
   */
  async recover(): Promise<void> {
    for (const [name, work] of [
      ["flush", () => this.flushDue()],
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
    const conversationId = await this.#commit(async (tx) => {
      // The private chat that wrote last: where a notice goes when nothing else names a chat (M6).
      (await tx.doc(TelegramChannel)).lastChat = update.chatId;
      return boundConversation(
        tx,
        telegramBinding(update.chatId),
        this.#options.profile,
        this.#options.profiles,
      );
    });
    switch (update.kind) {
      case "text":
        // Paused (`MIPI_PAUSED`, M9): refused before any window opens, so nothing waits to run later.
        if (await isPausedNow(this.#options.harness)) {
          await this.#reply(update.updateId, update.chatId, () => PAUSED_REPLY);
          return;
        }
        // The owner's first new message over the spend cap each day gets one line saying so; it still goes through.
        if (
          (await this.#admitText(update, conversationId)) &&
          (await this.#commit((tx) =>
            warnOwnerOverCap(
              tx,
              this.#options.delivery,
              telegramDestination(update.chatId),
              this.#now(),
            ),
          ))
        ) {
          this.#kickDrain();
        }
        return;
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

  /**
   * A text message. With a window open for its chat it joins the window (or, once the window is full, goes out with
   * it at once); a window already past its deadline is sent first, in a commit of its own, since a commit can admit
   * only one submission. Without a window, a busy conversation gets the message as a follow-up straight away, and an
   * idle one opens a window: Pi Durable decides which, so busy means what the inbox means by it.
   */
  async #admitText(
    update: Extract<TelegramInbound, { kind: "text" }>,
    conversationId: ConversationId,
  ): Promise<boolean> {
    await this.#flushDueNow(update.chatId);
    const window = await this.#commit(async (tx) => {
      const open = (await tx.doc(TelegramChannel)).staged?.find(
        ({ chatId }) => chatId === update.chatId,
      );
      return open === undefined
        ? undefined
        : {
            conversationId: open.conversationId as ConversationId,
            firstUpdateId: open.firstUpdateId,
          };
    });
    const target = await this.#conversation(window?.conversationId ?? conversationId);
    const requestId = telegramRequest(update.updateId);
    const message = { updateId: update.updateId, text: update.text, at: this.#now() };
    // As for the web door: arm before admitting work. An early alarm is harmless; a missing one strands the turn.
    await this.#options.armAlarm();
    // Whether this update is new: a replay Telegram sends again is stored already and accepts nothing.
    let accepted = false;
    const submitted = await this.#commit(
      async (tx): Promise<{ id: SubmissionId; text: string } | undefined> => {
        const state = await tx.doc(TelegramChannel);
        if (hasReceipt(state, update.updateId)) return undefined;
        accepted = true;
        const open = state.staged?.find(
          (staged) =>
            staged.chatId === update.chatId && staged.firstUpdateId === window?.firstUpdateId,
        );
        if (open !== undefined) {
          const messages = [...open.messages.map((staged) => ({ ...staged })), message];
          if (messages.length < BATCH_MAX_MESSAGES && batchUnits(messages) < BATCH_MAX_UNITS) {
            open.messages.push(message);
            addReceipt(state, update.updateId, this.#now());
            return undefined;
          }
          // Full: the window goes out now, with this message, in this commit.
          const id = await this.#submitBatch(tx, target, open.firstUpdateId, messages);
          this.#unstage(state, open.chatId, open.firstUpdateId);
          addReceipt(state, update.updateId, this.#now());
          if (id === undefined) return undefined;
          state.inputs.push({
            updateId: open.firstUpdateId,
            chatId: open.chatId,
            conversationId: target.id,
            submissionId: id,
          });
          return { id, text: batchText(messages) };
        }
        // Pi Durable's `admit(tx, …)` must come before any table write in this commit: read, admit, then write.
        const existing = await tx.submissionByRequest(target.id, requestId);
        if (existing !== undefined) {
          // Admitted before, and its receipt is gone: it was answered then, so nothing to send again.
          accepted = false;
          addReceipt(state, update.updateId, this.#now());
          return undefined;
        }
        let id: SubmissionId;
        try {
          id = await target.admit(tx, {
            type: "input",
            content: stampInput(
              this.#options.owner,
              update.text,
              this.#options.timeZone,
              message.at,
            ),
            requestId,
            // Busy: queue behind the running turn, which `followUpMode: "all"` answers together with the rest.
            whenBusy: "followUp",
            // Idle: rejected before anything is written, so the message can wait for the window instead.
            whenIdle: "reject",
          });
        } catch (error) {
          if (!(error instanceof ConversationIdle)) throw error;
          // Assigned, not pushed: a value assigned to a draft is copied, so a push onto it would be lost.
          state.staged = [
            ...(state.staged ?? []),
            {
              chatId: update.chatId,
              conversationId: target.id,
              firstUpdateId: update.updateId,
              deadline: message.at + BATCH_WINDOW_MS,
              messages: [message],
            },
          ];
          addReceipt(state, update.updateId, this.#now());
          return undefined;
        }
        addReceipt(state, update.updateId, this.#now());
        state.inputs.push({
          updateId: update.updateId,
          chatId: update.chatId,
          conversationId: target.id,
          submissionId: id,
        });
        return { id, text: update.text };
      },
    );
    if (submitted !== undefined) await this.#submitted(target.id, submitted);
    return accepted;
  }

  async #conversation(id: ConversationId): Promise<Conversation> {
    const conversation = await this.#options.harness.conversation(id, context);
    if (conversation === undefined) throw new Error(`Conversation ${id} is missing`);
    return conversation;
  }

  /**
   * Admits a window's messages as one input, or finds the one admitted before under the same request id: the only
   * table write of its commit, so call it before any other. Undefined when it was admitted before.
   */
  async #submitBatch(
    tx: Tx,
    conversation: Conversation,
    firstUpdateId: number,
    messages: readonly { readonly text: string; readonly at: number }[],
  ): Promise<SubmissionId | undefined> {
    const requestId = telegramBatchRequest(firstUpdateId);
    if ((await tx.submissionByRequest(conversation.id, requestId)) !== undefined) return undefined;
    return conversation.admit(tx, {
      type: "input",
      content: batchContent(this.#options.owner, this.#options.timeZone, messages),
      requestId,
      // Web or scheduled work may have started during the wait: then the batch is its follow-up.
      whenBusy: "followUp",
    });
  }

  #unstage(state: TelegramChannelState, chatId: number, firstUpdateId: number): void {
    state.staged = (state.staged ?? []).filter(
      (window) => !(window.chatId === chatId && window.firstUpdateId === firstUpdateId),
    );
  }

  async #submitted(
    conversationId: ConversationId,
    submitted: { readonly id: SubmissionId; readonly text: string },
  ): Promise<void> {
    // Core's settlement sees the input in this door's document after the commit and watches it (`answers.ts`).
    try {
      await this.#options.onSubmitted?.(conversationId, submitted.text);
    } catch (error) {
      this.#options.report("Telegram follow-up after a submit failed", error, { conversationId });
    }
  }

  /** Sends every window past its deadline, in the admission queue so it can't race an update of the same chat. */
  flushDue(): Promise<void> {
    return this.#queue.run("admit", () => this.#flushDueNow());
  }

  /** Each due window (of `chatId`, when given) in a commit of its own: read, submit, then remove it. */
  async #flushDueNow(chatId?: number): Promise<void> {
    const due = await this.#commit(async (tx) =>
      ((await tx.doc(TelegramChannel)).staged ?? [])
        .filter(
          (window) =>
            window.deadline <= this.#now() && (chatId === undefined || window.chatId === chatId),
        )
        .map(({ chatId: chat, conversationId, firstUpdateId }) => ({
          chatId: chat,
          conversationId: conversationId as ConversationId,
          firstUpdateId,
        })),
    );
    for (const window of due) {
      if (this.#closed) return;
      const conversation = await this.#conversation(window.conversationId);
      await this.#options.armAlarm();
      let refused = false;
      const submitted = await this.#commit(async (tx) => {
        const state = await tx.doc(TelegramChannel);
        const open = state.staged?.find(
          (staged) =>
            staged.chatId === window.chatId && staged.firstUpdateId === window.firstUpdateId,
        );
        if (open === undefined) return undefined;
        // Staged before a pause began (a deploy with `MIPI_PAUSED=1` in between): refused, not run (M9).
        if (await this.#refuseWhilePaused(tx, state, open)) {
          refused = true;
          return undefined;
        }
        const messages = open.messages.map((staged) => ({ ...staged }));
        const id = await this.#submitBatch(tx, conversation, open.firstUpdateId, messages);
        this.#unstage(state, window.chatId, window.firstUpdateId);
        if (id === undefined) return undefined;
        state.inputs.push({
          updateId: window.firstUpdateId,
          chatId: window.chatId,
          conversationId: conversation.id,
          submissionId: id,
        });
        return { id, text: batchText(messages) };
      });
      if (refused) this.#kickDrain();
      if (submitted !== undefined) await this.#submitted(conversation.id, submitted);
    }
  }

  /**
   * While paused (`MIPI_PAUSED`, M9), a window waiting to go out is dropped with the pause's reply, and nothing is
   * submitted. Returns whether it was refused.
   */
  async #refuseWhilePaused(
    tx: Tx,
    state: TelegramChannelState,
    window: NonNullable<TelegramChannelState["staged"]>[number],
  ): Promise<boolean> {
    if (!(await isPaused(tx))) return false;
    this.#unstage(state, window.chatId, window.firstUpdateId);
    enqueueReply(
      await tx.doc(TelegramOutbox),
      { id: `paused:${window.firstUpdateId}`, chatId: window.chatId, text: PAUSED_REPLY },
      this.#now(),
    );
    return true;
  }

  /**
   * Whether `conversationId` has work staged or running, for commands that change it: a window of this door, a
   * Telegram input waiting for its answer, a run (Pi Durable's `pi.live`), or inputs queued from any door.
   */
  async #busy(tx: Tx, conversationId: ConversationId): Promise<boolean> {
    const state = await tx.doc(TelegramChannel);
    if ((state.staged ?? []).some((window) => window.conversationId === conversationId))
      return true;
    if (state.inputs.some((input) => input.conversationId === conversationId)) return true;
    if ((await tx.doc(LiveDoc, conversationId)).run !== undefined) return true;
    return (await tx.doc(InboxDoc, conversationId)).items.length > 0;
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
      case "usage": {
        // Read before the commit: a provider's usage is an outside lookup, short and cached.
        let text: string;
        try {
          text = (await this.#options.usage?.()) ?? "Usage isn't available here.";
        } catch (error) {
          this.#options.report("Reading the usage failed", error);
          text = "I couldn't read the usage just now; try again in a moment.";
        }
        await this.#reply(updateId, chatId, () => text);
        return;
      }
      case "new": {
        // Messages waiting in the chat's window belong to the old conversation: they go there first, in the same
        // commit, before the chat is rebound (the admit before any table write, the new conversation's included).
        const window = await this.#commit(async (tx) => {
          const open = (await tx.doc(TelegramChannel)).staged?.find(
            (staged) => staged.chatId === chatId,
          );
          return open === undefined
            ? undefined
            : {
                conversationId: open.conversationId as ConversationId,
                firstUpdateId: open.firstUpdateId,
              };
        });
        const previous =
          window === undefined ? undefined : await this.#conversation(window.conversationId);
        if (window !== undefined) await this.#options.armAlarm();
        let submitted: { id: SubmissionId; text: string } | undefined;
        await this.#reply(updateId, chatId, async (tx) => {
          const state = await tx.doc(TelegramChannel);
          const open = state.staged?.find(
            (staged) => staged.chatId === chatId && staged.firstUpdateId === window?.firstUpdateId,
          );
          // Paused: the waiting messages are refused, not sent to the old conversation.
          const refused = open !== undefined && (await this.#refuseWhilePaused(tx, state, open));
          if (!refused && open !== undefined && previous !== undefined) {
            const messages = open.messages.map((staged) => ({ ...staged }));
            const id = await this.#submitBatch(tx, previous, open.firstUpdateId, messages);
            this.#unstage(state, open.chatId, open.firstUpdateId);
            if (id !== undefined) {
              state.inputs.push({
                updateId: open.firstUpdateId,
                chatId,
                conversationId: previous.id,
                submissionId: id,
              });
              submitted = { id, text: batchText(messages) };
            }
          }
          await boundConversation(
            tx,
            telegramBinding(chatId),
            this.#options.profile,
            this.#options.profiles,
            { rebind: true },
          );
          return "Started a new conversation.";
        });
        if (submitted !== undefined && previous !== undefined) {
          await this.#submitted(previous.id, submitted);
        }
        return;
      }
      case "profile":
        await this.#reply(updateId, chatId, async (tx) => {
          if (argument.length === 0) {
            const current = profileOf(await tx.doc(ConversationMeta, conversationId));
            return `Profile: ${current} (${this.#options.profiles.description(current)}).\nPick one with /profile <name>: ${PICKABLE_PROFILES.join(", ")}.`;
          }
          const name = argument.toLowerCase();
          if (!isProfileName(name)) {
            return `${argument} is not a profile. Pick one of: ${PICKABLE_PROFILES.join(", ")}.`;
          }
          const refused = profileRefusal(
            (await tx.doc(ConversationMeta, conversationId)).kind,
            name,
          );
          if (refused !== undefined) return refused;
          if (await this.#busy(tx, conversationId)) return BUSY_REPLY;
          await setProfile(tx, conversationId, name, this.#options.profiles);
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
        // Busy now: answered at once, nothing recorded.
        const recorded = await this.#commit(async (tx) => {
          const state = await tx.doc(TelegramChannel);
          if (hasReceipt(state, updateId)) return "duplicate" as const;
          if (await this.#busy(tx, conversationId)) {
            addReceipt(state, updateId, this.#now());
            enqueueReply(
              await tx.doc(TelegramOutbox),
              { id: `cmd:${updateId}`, chatId, text: BUSY_REPLY },
              this.#now(),
            );
            return "busy" as const;
          }
          state.commands.push({ updateId, chatId, conversationId, model: argument });
          addReceipt(state, updateId, this.#now());
          return "recorded" as const;
        });
        if (recorded === "busy") this.#kickDrain();
        if (recorded === "recorded") void this.runCommands().catch(() => undefined);
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
          // The conversation the command came from, even if `/new` rebound the chat since.
          if (await this.#busy(tx, command.conversationId as ConversationId)) {
            text = BUSY_REPLY;
          } else if (model !== undefined) {
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
      await this.#commit(async (tx) =>
        settleStale(await tx.doc(TelegramOutbox), this.#inFlight, this.#now()),
      );
    });
  }

  async #send(send: PickedSend): Promise<void> {
    const { key } = send;
    this.#inFlight.add(key);
    try {
      let result;
      try {
        result = await this.#options.send(send.chatId, {
          text: send.text,
          ...(send.html === undefined ? {} : { html: send.html }),
        });
      } catch (error) {
        result = {
          kind: "unknown" as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (result.kind !== "sent") {
        this.#options.report("A Telegram send did not go through", new Error(result.reason), {
          reply: send.replyId,
          chunk: key,
          outcome: result.kind,
        });
      }
      await this.#commit(async (tx) => {
        recordSend(await tx.doc(TelegramOutbox), send, result, this.#now());
        if (result.kind === "sent") await recordDelivered(tx, send.replyId, this.#now());
      });
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
      const staged = state.staged ?? [];
      const times = [
        nextOutboxWake(outbox, this.#now()),
        ...staged.map(({ deadline }) => deadline),
      ].filter((value): value is number => value !== undefined);
      const at = times.length === 0 ? undefined : Math.min(...times);
      // Inputs waiting for their answer keep core's settlement active, not this door (`answers.ts`).
      wake = {
        active: state.commands.length > 0 || staged.length > 0,
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

/**
 * After a send confirmed: a proactive reply's first confirmed chunk is reported to core (`onDelivered`) once, whatever
 * later splits do to its chunks.
 */
export async function recordDelivered(tx: Tx, replyId: string, now: number): Promise<void> {
  const outbox = await tx.doc(TelegramOutbox);
  const reply = outbox.replies.find(({ id }) => id === replyId);
  if (reply?.proactive === undefined || reply.proactiveRecorded === true) return;
  const first = reply.chunks.find(({ status }) => status === "sent");
  if (first === undefined) return;
  reply.proactiveRecorded = true;
  await onDelivered(
    tx,
    { sourceId: reply.proactive.reminderId, address: reply.chatId, text: first.text },
    now,
  );
}
