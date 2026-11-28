/**
 * The web session's core (COD-245): the chat connection, protocol framing, the outbox and its replay, transcript
 * paging, the usage line's throttle and the diagnostics live tail. Plain TypeScript with no DOM and no React: the host
 * gives it a `Transport` and a `Platform`, and a view subscribes to its state (`usePiSession.ts` for React). It
 * compiles under `tsconfig.session.json` and is tested in Vitest with fakes.
 */
import {
  applyImmutable,
  BACKGROUND_CONTEXT,
  ConversationTranscript,
  DEFAULT_DIAG_TAIL,
  MAX_ENTRY_PAGE,
  MAX_PROMPT_CHARACTERS,
  mainConversationId,
  parseServerEventEnvelope,
  type ApprovalDecision,
  type ApprovalSummary,
  type ClientCommand,
  type ConversationSummary,
  type ConversationView,
  type Cursor,
  type EntryRecord,
  type Options,
  type Page,
  type UsageReadout,
} from "../../protocol.ts";
import { CommandOutbox, type RetriableCommand } from "./command-outbox.ts";
import {
  type DiagAction,
  type DiagState,
  diagReducer,
  initialDiagState,
  lastDiagId,
} from "./diag-buffer.ts";
import type { Platform, TimerHandle } from "./platform.ts";
import {
  conversationAfterSnapshot,
  initialSessionState,
  sessionReducer,
  type SessionAction,
  type SessionState,
  type TranscriptGap,
} from "./session-state.ts";
import type { ConnectTransport, Transport, TransportEvent } from "./transport.ts";

export type DecisionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const NO_APPROVALS: readonly ApprovalSummary[] = [];
const APPROVAL_CONNECTION_CLOSED = "The connection closed before the agent answered.";
const APPROVALS_UNAVAILABLE = "This agent does not support approvals.";

type EntryPage = Page<EntryRecord, Cursor>;

/** A `conversation.entries` command waiting for its result. */
type PendingPage = {
  readonly resolve: (page: EntryPage) => void;
  readonly reject: (error: Error) => void;
};

const terminalProtocolClose = (code: number): boolean => code === 1002 || code === 1009;

const CONNECTION_FAILED = "The session connection failed.";

/**
 * The header's usage line is read again at most this often, and only when the agent is awake anyway: the session
 * opening, the owner's own message, work running (`session.activity`), or the app coming back into view. Never on a
 * timer of its own, which would wake a hibernated agent every minute for every open tab.
 */
export const USAGE_REFRESH_MS = 30_000;

/** Everything a view draws of the session. A new object on every change, the same one otherwise. */
export interface SessionClientState {
  readonly session: SessionState;
  /** The models and profiles the pickers offer; undefined until the agent sent them. */
  readonly options: Options | undefined;
  /** Today's spend and usage (M9); undefined until the agent sent it. */
  readonly usage: UsageReadout | undefined;
  /** The diagnostic events and health Settings → Diagnostics shows (COD-236), apart from the transcript's state. */
  readonly diag: DiagState;
  readonly approvals: readonly ApprovalSummary[];
}

export interface SessionClientOptions {
  readonly sessionId: string;
  /** The conversation to open first (the page's `?conversation=`); MiPi otherwise. */
  readonly initialConversationId?: number;
  readonly connect: ConnectTransport;
  readonly platform: Platform;
}

/** One connection's own state: what a reconnect of the same transport keeps, and a new `start()` resets. */
interface Connection {
  readonly transport: Transport;
  /** The agent refused the protocol: no reconnect, and the outbox is dropped. */
  terminal: boolean;
  /** This socket's session opened (its first snapshot arrived) since it last connected. */
  conversationOpened: boolean;
  failureMessage: string;
  usageReadAt: number;
  usageLater: TimerHandle | undefined;
  stopVisibility: () => void;
  disposed: boolean;
}

export class SessionClient {
  readonly #sessionId: string;
  readonly #connect: ConnectTransport;
  readonly #platform: Platform;
  readonly #listeners = new Set<() => void>();
  #state: SessionClientState = {
    session: initialSessionState,
    options: undefined,
    usage: undefined,
    diag: initialDiagState,
    approvals: NO_APPROVALS,
  };
  #connection: Connection | undefined;
  readonly #outbox = new CommandOutbox();
  #selectedConversation: number | undefined;
  // The summaries as last received, so the selection follows the agent off a conversation archived under it.
  #conversations: readonly ConversationSummary[] = [];
  // The capabilities of the agent this socket reaches, as its last snapshot said: none until one arrives.
  #capabilities: ReadonlySet<string> = initialSessionState.capabilities;
  // A conversation's view as last received, to apply operations to, and the transcript the client holds, which keeps
  // entries that left the view's window and pages in older ones.
  readonly #views = new Map<number, ConversationView>();
  readonly #transcripts = new Map<number, ConversationTranscript>();
  readonly #pages = new Map<string, PendingPage>();
  readonly #decisions = new Map<string, (result: DecisionResult) => void>();
  // Whether Diagnostics wants the tail (asked again after a reconnect), and the newest event id held.
  #diagWanted = false;
  #diagLastId: number | undefined;
  // Whether the agent answered this socket's subscription: live events count only after that answer (`diag-buffer.ts`
  // drops them before it), so the newest id held never runs ahead of the events held.
  #diagLive = false;

  constructor(options: SessionClientOptions) {
    this.#sessionId = options.sessionId;
    this.#connect = options.connect;
    this.#platform = options.platform;
    this.#selectedConversation = options.initialConversationId;
  }

  // State for a view: `useSyncExternalStore(client.subscribe, client.getState)`.

  readonly getState = (): SessionClientState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  #update(next: SessionClientState): void {
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #dispatch(action: SessionAction): void {
    const session = sessionReducer(this.#state.session, action);
    if (session !== this.#state.session) this.#update({ ...this.#state, session });
  }

  #dispatchDiag(action: DiagAction): void {
    const diag = diagReducer(this.#state.diag, action);
    if (diag !== this.#state.diag) this.#update({ ...this.#state, diag });
  }

  // The connection.

  /** Connects; the transport reconnects by itself until `stop()` or a terminal protocol error. */
  start(): void {
    if (this.#connection !== undefined && !this.#connection.disposed) return;
    const platform = this.#platform;
    let connection: Connection | undefined;
    const transport = this.#connect({
      channel: "chat",
      room: this.#sessionId,
      shouldReconnect: ({ code }) => connection?.terminal !== true && !terminalProtocolClose(code),
      onEvent: (event) => {
        if (connection !== undefined) this.#onEvent(connection, event);
      },
    });
    connection = {
      transport,
      terminal: false,
      conversationOpened: false,
      failureMessage: CONNECTION_FAILED,
      usageReadAt: 0,
      usageLater: undefined,
      stopVisibility: platform.visibility.subscribe((visibility) => {
        if (visibility === "visible" && connection !== undefined) this.#requestUsage(connection);
      }),
      disposed: false,
    };
    this.#connection = connection;
  }

  /** Disconnects for good: commands still waiting fail. `start()` connects again. */
  stop(): void {
    const connection = this.#connection;
    if (connection === undefined || connection.disposed) return;
    connection.disposed = true;
    if (connection.usageLater !== undefined) this.#platform.clearTimeout(connection.usageLater);
    connection.stopVisibility();
    this.#outbox.clear();
    this.#closePages();
    this.#capabilities = initialSessionState.capabilities;
    this.#resetApprovals(APPROVAL_CONNECTION_CLOSED);
    this.#diagLive = false;
    this.#dispatchDiag({ type: "stopped" });
    connection.transport.close(1000, "Session view closed");
    if (this.#connection === connection) this.#connection = undefined;
  }

  /** The open transport, or `undefined` while connecting, failed or stopped. */
  #open(): Transport | undefined {
    const connection = this.#connection;
    const transport = connection?.disposed ? undefined : connection?.transport;
    return transport !== undefined && transport.isOpen() ? transport : undefined;
  }

  #sendOn(transport: Transport, command: ClientCommand): void {
    transport.send(JSON.stringify(command));
  }

  #onEvent(connection: Connection, event: TransportEvent): void {
    // A stopped transport can report its close after another connection has started.
    if (connection.disposed) return;
    switch (event.type) {
      case "open":
        connection.conversationOpened = false;
        this.#dispatch({ type: "connection", status: "connected" });
        this.#dispatch({ type: "clear-error" });
        return;
      case "binary":
        connection.terminal = true;
        connection.failureMessage = "Server sent a binary protocol frame.";
        connection.transport.close(1002, "Binary protocol frame");
        return;
      case "message":
        this.#onMessage(connection, event.data);
        return;
      case "error":
        if (!connection.terminal) this.#dispatch({ type: "connection", status: "connecting" });
        return;
      case "close":
        this.#onClose(connection, event.code, event.reason);
        return;
      default: {
        const _: never = event;
        return;
      }
    }
  }

  #closePages(): void {
    for (const pending of this.#pages.values()) {
      pending.reject(new Error("The session connection closed"));
    }
    this.#pages.clear();
  }

  #onClose(connection: Connection, code: number, reason: string): void {
    this.#closePages();
    // The new socket subscribes again (`#resubscribeDiag`); until then nothing streams.
    this.#diagLive = false;
    // The next agent may be another build (a rollback): nothing optional is sent until its snapshot says so.
    this.#capabilities = initialSessionState.capabilities;
    this.#resetApprovals(APPROVAL_CONNECTION_CLOSED);
    this.#dispatchDiag({ type: "stopped" });
    if (terminalProtocolClose(code)) {
      connection.terminal = true;
      if (connection.failureMessage === CONNECTION_FAILED && reason.length > 0) {
        connection.failureMessage = reason;
      }
    }
    if (connection.terminal) {
      if (this.#connection === connection) this.#connection = undefined;
      connection.disposed = true;
      if (connection.usageLater !== undefined) this.#platform.clearTimeout(connection.usageLater);
      connection.stopVisibility();
      this.#outbox.clear();
      this.#dispatch({ type: "connection", status: "failed" });
      this.#dispatch({ type: "error", message: connection.failureMessage });
    } else {
      this.#dispatch({ type: "connection", status: "connecting" });
    }
  }

  #resetApprovals(message: string): void {
    for (const complete of this.#decisions.values()) complete({ ok: false, message });
    this.#decisions.clear();
    if (this.#state.approvals !== NO_APPROVALS) {
      this.#update({ ...this.#state, approvals: NO_APPROVALS });
    }
  }

  /** Reads the usage now, or once `USAGE_REFRESH_MS` has passed since the last read (`force`: now regardless). */
  #requestUsage(connection: Connection, force = false): void {
    const transport = connection.transport;
    if (connection.disposed || !transport.isOpen() || !this.#capabilities.has("usage")) return;
    const wait = connection.usageReadAt + USAGE_REFRESH_MS - Date.now();
    if (!force && wait > 0) {
      // One trailing read, so the line catches up with the work that just ran.
      connection.usageLater ??= this.#platform.setTimeout(() => {
        connection.usageLater = undefined;
        this.#requestUsage(connection);
      }, wait);
      return;
    }
    connection.usageReadAt = Date.now();
    this.#sendOn(transport, { type: "usage.read", requestId: this.#platform.randomId() });
  }

  /** The tail again on a new socket: from the newest event held, so nothing comes twice. */
  #resubscribeDiag(transport: Transport): void {
    if (!this.#diagWanted || !this.#capabilities.has("diagnostics")) return;
    const after = this.#diagLastId;
    this.#sendOn(transport, {
      type: "diag.subscribe",
      requestId: this.#platform.randomId(),
      ...(after === undefined ? { limit: DEFAULT_DIAG_TAIL } : { after }),
    });
  }

  #onMessage(connection: Connection, data: string): void {
    const transport = connection.transport;
    let parsed;
    try {
      parsed = parseServerEventEnvelope(data);
    } catch (error) {
      this.#platform.logError?.("Invalid session protocol frame", error);
      connection.terminal = true;
      connection.failureMessage = "Server sent an invalid protocol frame.";
      transport.close(1002, "Invalid protocol frame");
      return;
    }
    // A newer agent's frame (COD-246): ignored, so version skew never closes the socket.
    if (parsed.type === "unknown") return;

    if (parsed.type === "conversation.view") {
      this.#showView(parsed.conversationId, parsed.view);
      return;
    }
    // Diagnostics never reach the session reducer: a live frame leaves the conversation state alone.
    if (parsed.type === "diag.event") {
      if (!this.#diagWanted || !this.#diagLive) return;
      this.#diagLastId = Math.max(this.#diagLastId ?? 0, parsed.event.id);
      this.#dispatchDiag({ type: "event", event: parsed.event });
      return;
    }
    if (parsed.type === "command.result" && parsed.command === "diag.subscribe") {
      if (!parsed.ok) {
        this.#dispatchDiag({ type: "failed", message: parsed.error.message });
        return;
      }
      // Unsubscribed while it was on its way: the agent stops on the unsubscribe that follows it.
      if (!this.#diagWanted || parsed.diag === undefined) return;
      this.#diagLive = true;
      const newest = lastDiagId(parsed.diag.events);
      if (newest !== undefined) this.#diagLastId = Math.max(this.#diagLastId ?? 0, newest);
      this.#dispatchDiag({
        type: "snapshot",
        events: parsed.diag.events,
        health: parsed.diag.health,
      });
      return;
    }
    if (parsed.type === "command.result" && parsed.command === "diag.unsubscribe") return;
    if (parsed.type === "approvals.list") {
      if (this.#capabilities.has("approvals")) {
        this.#update({ ...this.#state, approvals: parsed.approvals });
      }
      return;
    }
    if (parsed.type === "command.result" && parsed.command === "approval.decide") {
      const complete = this.#decisions.get(parsed.requestId);
      this.#decisions.delete(parsed.requestId);
      complete?.(parsed.ok ? { ok: true } : { ok: false, message: parsed.error.message });
      return;
    }
    if (parsed.type === "conversation.ops") {
      const view = this.#views.get(parsed.conversationId);
      if (view !== undefined) {
        const next = applyImmutable(view, parsed.ops);
        const failure = next.docs["pi.live"]?.runFailure;
        if (
          failure !== undefined &&
          JSON.stringify(failure) !== JSON.stringify(view.docs["pi.live"]?.runFailure)
        ) {
          this.#requestUsage(connection, true);
        }
        this.#showView(parsed.conversationId, next);
      }
      return;
    }
    // Work ran, or the owner's message was admitted: the agent is awake, so the usage line can catch up.
    if (
      parsed.type === "session.activity" ||
      (parsed.type === "command.result" && parsed.command === "prompt.submit" && parsed.ok)
    ) {
      this.#requestUsage(connection);
    }
    if (parsed.type === "command.result" && parsed.command === "usage.read") {
      // A readout that couldn't be read leaves the last one; the line is a glance, not a control.
      if (parsed.ok) this.#update({ ...this.#state, usage: parsed.usage });
      return;
    }
    if (parsed.type === "command.result" && parsed.command === "options.list") {
      if (parsed.ok) this.#update({ ...this.#state, options: parsed.options });
      else this.#dispatch({ type: "error", message: parsed.error.message });
      return;
    }
    if (parsed.type === "command.result" && parsed.command === "conversation.entries") {
      const pending = this.#pages.get(parsed.requestId);
      this.#pages.delete(parsed.requestId);
      if (parsed.ok) pending?.resolve({ items: parsed.page?.items ?? [], next: parsed.page?.next });
      else pending?.reject(new Error(parsed.error.message));
      return;
    }

    if (
      parsed.type === "error" &&
      (parsed.error.code === "invalid_message" ||
        parsed.error.code === "invalid_command" ||
        parsed.error.code === "frame_too_large")
    ) {
      connection.terminal = true;
      connection.failureMessage = parsed.error.message;
    }
    if (parsed.type === "session.snapshot") {
      // Archived under this tab: the agent moved its watch to MiPi, so the selection (and a reconnect) goes there too.
      if (connection.conversationOpened) {
        this.#selectedConversation = conversationAfterSnapshot(
          this.#conversations,
          parsed.session.conversations,
          this.#selectedConversation,
        );
      }
      this.#conversations = parsed.session.conversations;
      this.#capabilities = new Set(parsed.session.capabilities ?? []);
      if (!this.#capabilities.has("approvals")) this.#resetApprovals(APPROVALS_UNAVAILABLE);
    }
    this.#dispatch({ type: "event", event: parsed });
    if (parsed.type === "session.snapshot" && !connection.conversationOpened) {
      connection.conversationOpened = true;
      this.#sendOn(transport, { type: "options.list", requestId: this.#platform.randomId() });
      this.#requestUsage(connection, true);
      const desired = this.#selectedConversation;
      const selectedStillExists = parsed.session.conversations.some(({ id }) => id === desired);
      const main = mainConversationId(parsed.session.conversations);
      const conversationId = selectedStillExists ? desired : main;
      if (conversationId !== undefined) {
        this.#selectedConversation = conversationId;
        // The door opened MiPi already: any other choice is opened again.
        if (conversationId !== main) {
          this.#dispatch({ type: "select", conversationId });
          this.#sendOn(transport, {
            type: "conversation.open",
            requestId: this.#platform.randomId(),
            conversationId,
          });
        }
      }
      // Restore the previous watch first. Replayed create/fork commands then leave the server
      // watching the newest acknowledged conversation rather than the pre-disconnect one.
      this.#outbox.replay((command) => this.#sendOn(transport, command));
      this.#resubscribeDiag(transport);
    }
    if (parsed.type === "command.result") {
      const acknowledged = this.#outbox.acknowledge(parsed);
      if (
        acknowledged !== undefined &&
        parsed.ok &&
        parsed.conversationId !== undefined &&
        (acknowledged.type === "bot.create" ||
          acknowledged.type === "cobot.create" ||
          acknowledged.type === "conversation.fork")
      ) {
        this.#selectedConversation = parsed.conversationId;
      }
    }
  }

  // Transcripts.

  #requestPage(
    conversationId: number,
    query: { minEntryId?: number; maxEntryId?: number; order?: "ascending" | "descending" },
    limit: number,
  ): Promise<EntryPage> {
    const transport = this.#open();
    if (transport === undefined) return Promise.reject(new Error("The session is not connected"));
    const requestId = this.#platform.randomId();
    return new Promise((resolve, reject) => {
      this.#pages.set(requestId, { resolve, reject });
      this.#sendOn(transport, {
        type: "conversation.entries",
        requestId,
        conversationId,
        ...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
        ...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
        order: query.order ?? "descending",
        limit: Math.min(limit, MAX_ENTRY_PAGE),
      });
    });
  }

  #transcriptFor(conversationId: number): ConversationTranscript {
    let transcript = this.#transcripts.get(conversationId);
    if (transcript === undefined) {
      transcript = new ConversationTranscript((query, limit) =>
        this.#requestPage(conversationId, query, limit),
      );
      this.#transcripts.set(conversationId, transcript);
    }
    return transcript;
  }

  #showView(conversationId: number, view: ConversationView): void {
    this.#views.set(conversationId, view);
    this.#dispatch({
      type: "view",
      conversationId,
      view: this.#transcriptFor(conversationId).merge(view),
    });
  }

  // Commands: arrow fields, so a view can pass them on as stable callbacks.

  #send(command: ClientCommand): boolean {
    const transport = this.#open();
    if (transport === undefined) {
      this.#dispatch({ type: "error", message: "The session is not connected" });
      return false;
    }
    this.#dispatch({ type: "clear-error" });
    this.#sendOn(transport, command);
    return true;
  }

  #sendRetriable(command: RetriableCommand, complete?: (accepted: boolean) => void): boolean {
    this.#outbox.enqueue(command, complete);
    if (this.#send(command)) return true;
    this.#outbox.cancel(command.requestId);
    return false;
  }

  readonly openConversation = (conversationId: number): void => {
    this.#selectedConversation = conversationId;
    this.#dispatch({ type: "select", conversationId });
    this.#send({ type: "conversation.open", requestId: this.#platform.randomId(), conversationId });
  };

  readonly configureConversation = (
    conversationId: number,
    change: { readonly model?: string; readonly profile?: string },
  ): void => {
    this.#send({
      type: "conversation.configure",
      requestId: this.#platform.randomId(),
      conversationId,
      ...change,
    });
  };

  readonly createBot = (bot: {
    readonly name: string;
    readonly purpose: string;
    readonly profile: string;
  }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (
        !this.#sendRetriable(
          { type: "bot.create", requestId: this.#platform.randomId(), ...bot },
          resolve,
        )
      ) {
        resolve(false);
      }
    });

  readonly createCobot = (bot: number, name: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (
        !this.#sendRetriable(
          { type: "cobot.create", requestId: this.#platform.randomId(), bot, name },
          resolve,
        )
      ) {
        resolve(false);
      }
    });

  readonly renameBot = (conversationId: number, name: string): void => {
    this.#send({ type: "bot.rename", requestId: this.#platform.randomId(), conversationId, name });
  };

  readonly archiveBot = (conversationId: number): void => {
    // Archiving is idempotent on the agent (an archived one archives nothing), so a plain send is enough.
    this.#send({ type: "bot.archive", requestId: this.#platform.randomId(), conversationId });
  };

  readonly restoreBot = (conversationId: number): void => {
    // Restoring is idempotent on the agent (a live one restores nothing), so a plain send is enough.
    this.#send({ type: "bot.restore", requestId: this.#platform.randomId(), conversationId });
  };

  readonly forkConversation = (conversationId: number, entryId: number): void => {
    this.#sendRetriable({
      type: "conversation.fork",
      requestId: this.#platform.randomId(),
      conversationId,
      entryId,
    });
  };

  readonly setTyping = (conversationId: number, typing: boolean): void => {
    const transport = this.#open();
    if (transport === undefined) return;
    this.#sendOn(transport, { type: "presence.typing", conversationId, typing });
  };

  readonly submitPrompt = (conversationId: number, content: string): Promise<boolean> => {
    if (content.trim().length === 0) {
      this.#dispatch({ type: "error", message: "A prompt must contain text" });
      return Promise.resolve(false);
    }
    if (content.length > MAX_PROMPT_CHARACTERS) {
      this.#dispatch({
        type: "error",
        message: `A prompt cannot exceed ${MAX_PROMPT_CHARACTERS.toLocaleString()} characters`,
      });
      return Promise.resolve(false);
    }
    if (this.#outbox.has("prompt.submit")) {
      throw new Error("A prompt submission is already pending");
    }
    const command = {
      type: "prompt.submit",
      requestId: this.#platform.randomId(),
      conversationId,
      content,
    } satisfies Extract<ClientCommand, { readonly type: "prompt.submit" }>;
    return new Promise((resolve) => {
      this.#sendRetriable(command, resolve);
    });
  };

  readonly decideApproval = (
    approvalId: string,
    decision: ApprovalDecision,
    note?: string,
  ): Promise<DecisionResult> => {
    const transport = this.#open();
    if (transport === undefined) {
      return Promise.resolve({ ok: false, message: "The session is not connected." });
    }
    if (!this.#capabilities.has("approvals")) {
      return Promise.resolve({ ok: false, message: APPROVALS_UNAVAILABLE });
    }
    const requestId = this.#platform.randomId();
    const trimmedNote = note?.trim();
    return new Promise((resolve) => {
      this.#decisions.set(requestId, resolve);
      try {
        this.#sendOn(transport, {
          type: "approval.decide",
          requestId,
          approvalId,
          decision,
          ...(trimmedNote ? { note: trimmedNote } : {}),
        });
      } catch {
        this.#decisions.delete(requestId);
        resolve({ ok: false, message: APPROVAL_CONNECTION_CLOSED });
      }
    });
  };

  /**
   * Starts the live tail (`diag.subscribe`), or catches up while it runs: `after` asks only for what came since. It is
   * asked for again after a reconnect, from the newest event held, until `unsubscribeDiag`.
   */
  readonly subscribeDiag = (
    query: { readonly limit?: number; readonly after?: number } = {},
  ): void => {
    this.#diagWanted = true;
    const transport = this.#open();
    // Not connected, or no snapshot has said the agent has diagnostics yet: the session's snapshot subscribes, if
    // the agent has them (`#resubscribeDiag`).
    if (transport === undefined || !this.#capabilities.has("diagnostics")) return;
    this.#sendOn(transport, {
      type: "diag.subscribe",
      requestId: this.#platform.randomId(),
      ...(query.after === undefined ? {} : { after: query.after }),
      // A catch-up (`after`) takes everything since, up to the agent's own cap, unless a limit is given.
      ...(query.after === undefined
        ? { limit: query.limit ?? DEFAULT_DIAG_TAIL }
        : query.limit === undefined
          ? {}
          : { limit: query.limit }),
    });
  };

  /** Stops the live tail. */
  readonly unsubscribeDiag = (): void => {
    this.#diagWanted = false;
    this.#diagLive = false;
    this.#dispatchDiag({ type: "stopped" });
    const transport = this.#open();
    // An agent without diagnostics was never subscribed, and may not know the command.
    if (transport === undefined || !this.#capabilities.has("diagnostics")) return;
    this.#sendOn(transport, { type: "diag.unsubscribe", requestId: this.#platform.randomId() });
  };

  /** Loads the page of the transcript before the oldest entry loaded. */
  readonly loadEarlier = (conversationId: number): void => {
    const transcript = this.#transcripts.get(conversationId);
    if (transcript === undefined) return;
    transcript.loadEarlier(BACKGROUND_CONTEXT).then(
      (view) => this.#dispatch({ type: "view", conversationId, view }),
      (error: Error) => this.#dispatch({ type: "error", message: error.message }),
    );
  };

  /** Loads the next page of entries missing in `gap`. */
  readonly fillGap = (conversationId: number, gap: TranscriptGap): void => {
    const transcript = this.#transcripts.get(conversationId);
    if (transcript === undefined) return;
    transcript.fillGap(gap, BACKGROUND_CONTEXT).then(
      (view) => this.#dispatch({ type: "view", conversationId, view }),
      (error: Error) => this.#dispatch({ type: "error", message: error.message }),
    );
  };
}
