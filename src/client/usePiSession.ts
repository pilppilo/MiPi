import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import PartySocket from "partysocket";
import {
  applyImmutable,
  BACKGROUND_CONTEXT,
  ConversationTranscript,
  DEFAULT_DIAG_TAIL,
  MAX_ENTRY_PAGE,
  MAX_PROMPT_CHARACTERS,
  mainConversationId,
  parseServerEventEnvelope,
  type ClientCommand,
  type ConnectionStatus,
  type ConversationSummary,
  type ConversationView,
  type Cursor,
  type EntryRecord,
  type Options,
  type Page,
  type TaskGraph,
  type UsageReadout,
} from "../protocol.ts";
import { type DiagState, diagReducer, initialDiagState, lastDiagId } from "./diag-buffer.ts";
import { CommandOutbox, type RetriableCommand } from "./command-outbox.ts";
import {
  conversationAfterSnapshot,
  initialSessionState,
  sessionReducer,
  type ConversationSnapshot,
  type TranscriptGap,
} from "./session-state.ts";

type EntryPage = Page<EntryRecord, Cursor>;

/** A `conversation.entries` command waiting for its result. */
type PendingPage = {
  readonly resolve: (page: EntryPage) => void;
  readonly reject: (error: Error) => void;
};

const terminalProtocolClose = (code: number): boolean => code === 1002 || code === 1009;

/**
 * The header's usage line is read again at most this often, and only when the agent is awake anyway: the session
 * opening, the owner's own message, work running (`session.activity`), or the tab coming back into view. Never on a
 * timer of its own, which would wake a hibernated agent every minute for every open tab.
 */
const USAGE_REFRESH_MS = 30_000;

export interface PiSession {
  readonly status: ConnectionStatus;
  /**
   * What the agent advertised beyond chat (COD-246, `CORE_CAPABILITIES` and extensions'). A panel whose capability is
   * absent isn't shown, and its requests aren't sent: an older agent, or one with the feature off, never sees them.
   */
  readonly capabilities: ReadonlySet<string>;
  readonly conversations: readonly ConversationSummary[];
  readonly activeConversationId: number | undefined;
  readonly activeConversation: ConversationSnapshot | undefined;
  readonly activity: TaskGraph | undefined;
  readonly error: string | undefined;
  /** The models and profiles the pickers offer; undefined until the server sent them. */
  readonly options: Options | undefined;
  /** Today's spend and usage (M9); undefined until the server sent it. Refreshed when the agent is awake anyway. */
  readonly usage: UsageReadout | undefined;
  /** The diagnostic events and health Settings → Diagnostics shows (COD-236), kept apart from the transcript's state. */
  readonly diag: DiagState;
  /**
   * Starts the live tail (`diag.subscribe`), or catches up while it runs: `after` asks only for what came since. It is
   * asked for again after a reconnect, from the newest event held, until `unsubscribeDiag`.
   */
  subscribeDiag(query?: { readonly limit?: number; readonly after?: number }): void;
  /** Stops the live tail. */
  unsubscribeDiag(): void;
  /** Switches a conversation's model or tool profile from its next request. */
  configureConversation(
    conversationId: number,
    change: { readonly model?: string; readonly profile?: string },
  ): void;
  openConversation(conversationId: number): void;
  /** Makes a purpose bot and opens it. Resolves with whether the agent accepted it (a name may be taken). */
  createBot(bot: {
    readonly name: string;
    readonly purpose: string;
    readonly profile: string;
  }): Promise<boolean>;
  createCobot(bot: number, name: string): Promise<boolean>;
  renameBot(conversationId: number, name: string): void;
  /** Archives a purpose bot with its cobots, or one cobot alone (COD-233). Never MiPi. */
  archiveBot(conversationId: number): void;
  /** Restores an archived bot (with its cobots), a cobot under a live bot, or a chat from before bots (COD-201). */
  restoreBot(conversationId: number): void;
  forkConversation(conversationId: number, entryId: number): void;
  setTyping(conversationId: number, typing: boolean): void;
  submitPrompt(conversationId: number, content: string): Promise<boolean>;
  /** Loads the page of the transcript before the oldest entry loaded. */
  loadEarlier(conversationId: number): void;
  /** Loads the next page of entries missing in `gap`. */
  fillGap(conversationId: number, gap: TranscriptGap): void;
}

export function usePiSession(sessionId: string, initialConversationId?: number): PiSession {
  const [state, dispatch] = useReducer(sessionReducer, initialSessionState);
  const [options, setOptions] = useState<Options>();
  const [usage, setUsage] = useState<UsageReadout>();
  const [diag, dispatchDiag] = useReducer(diagReducer, initialDiagState);
  // Whether Diagnostics wants the tail (asked again after a reconnect), and the newest event id this tab holds.
  const diagWantedRef = useRef(false);
  const diagLastIdRef = useRef<number | undefined>(undefined);
  // Whether the agent answered this socket's subscription: live events count only after that answer (`diag-buffer.ts`
  // drops them before it), so the newest id held never runs ahead of the events held.
  const diagLiveRef = useRef(false);
  // The capabilities of the agent this socket reaches, as its last snapshot said: none until one arrives.
  const capabilitiesRef = useRef<ReadonlySet<string>>(initialSessionState.capabilities);
  const socketRef = useRef<PartySocket | null>(null);
  const outboxRef = useRef<CommandOutbox | null>(null);
  outboxRef.current ??= new CommandOutbox();
  const outbox = outboxRef.current;
  const selectedConversationRef = useRef<number | undefined>(initialConversationId);
  // The summaries as last received, so the selection follows the agent off a conversation archived under it.
  const conversationsRef = useRef<readonly ConversationSummary[]>([]);
  // A conversation's view as last received, to apply operations to, and the transcript the client holds, which keeps
  // entries that left the view's window and pages in older ones.
  const viewsRef = useRef(new Map<number, ConversationView>());
  const transcriptsRef = useRef(new Map<number, ConversationTranscript>());
  const pagesRef = useRef(new Map<string, PendingPage>());

  const requestPage = useCallback(
    (
      conversationId: number,
      query: { minEntryId?: number; maxEntryId?: number; order?: "ascending" | "descending" },
      limit: number,
    ): Promise<EntryPage> => {
      const socket = socketRef.current;
      if (socket === null || socket.readyState !== socket.OPEN) {
        return Promise.reject(new Error("The session is not connected"));
      }
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        pagesRef.current.set(requestId, { resolve, reject });
        socket.send(
          JSON.stringify({
            type: "conversation.entries",
            requestId,
            conversationId,
            ...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId }),
            ...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId }),
            order: query.order ?? "descending",
            limit: Math.min(limit, MAX_ENTRY_PAGE),
          } satisfies ClientCommand),
        );
      });
    },
    [],
  );

  const transcriptFor = useCallback(
    (conversationId: number): ConversationTranscript => {
      let transcript = transcriptsRef.current.get(conversationId);
      if (transcript === undefined) {
        transcript = new ConversationTranscript((query, limit) =>
          requestPage(conversationId, query, limit),
        );
        transcriptsRef.current.set(conversationId, transcript);
      }
      return transcript;
    },
    [requestPage],
  );

  const showView = useCallback(
    (conversationId: number, view: ConversationView) => {
      viewsRef.current.set(conversationId, view);
      dispatch({ type: "view", conversationId, view: transcriptFor(conversationId).merge(view) });
    },
    [transcriptFor],
  );

  useEffect(() => {
    let disposed = false;
    let terminal = false;
    let conversationOpened = false;
    let failureMessage = "The session connection failed.";
    const socket = new PartySocket({
      host: window.location.host,
      party: "sessions",
      prefix: "api",
      room: sessionId,
      maxEnqueuedMessages: 16,
      shouldReconnectOnClose: (event) => !terminal && !terminalProtocolClose(event.code),
    });
    socketRef.current = socket;
    let usageReadAt = 0;
    let usageLater: number | undefined;
    /** Reads the usage now, or once `USAGE_REFRESH_MS` has passed since the last read (`force`: now regardless). */
    const requestUsage = (force = false) => {
      if (socket.readyState !== socket.OPEN || !capabilitiesRef.current.has("usage")) return;
      const wait = usageReadAt + USAGE_REFRESH_MS - Date.now();
      if (!force && wait > 0) {
        // One trailing read, so the line catches up with the work that just ran.
        usageLater ??= window.setTimeout(() => {
          usageLater = undefined;
          requestUsage();
        }, wait);
        return;
      }
      usageReadAt = Date.now();
      socket.send(
        JSON.stringify({
          type: "usage.read",
          requestId: crypto.randomUUID(),
        } satisfies ClientCommand),
      );
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") requestUsage();
    };
    document.addEventListener("visibilitychange", onVisible);

    /** The tail again on a new socket: from the newest event held, so nothing comes twice. */
    const resubscribeDiag = () => {
      if (!diagWantedRef.current || !capabilitiesRef.current.has("diagnostics")) return;
      const after = diagLastIdRef.current;
      socket.send(
        JSON.stringify({
          type: "diag.subscribe",
          requestId: crypto.randomUUID(),
          ...(after === undefined ? { limit: DEFAULT_DIAG_TAIL } : { after }),
        } satisfies ClientCommand),
      );
    };

    socket.addEventListener("open", () => {
      conversationOpened = false;
      dispatch({ type: "connection", status: "connected" });
      dispatch({ type: "clear-error" });
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        terminal = true;
        failureMessage = "Server sent a binary protocol frame.";
        socket.close(1002, "Binary protocol frame");
        return;
      }

      let parsed;
      try {
        parsed = parseServerEventEnvelope(event.data);
      } catch (error) {
        console.error("Invalid session protocol frame", error);
        terminal = true;
        failureMessage = "Server sent an invalid protocol frame.";
        socket.close(1002, "Invalid protocol frame");
        return;
      }
      // A newer agent's frame (COD-246): ignored, so version skew never closes the socket.
      if (parsed.type === "unknown") return;

      if (parsed.type === "conversation.view") {
        showView(parsed.conversationId, parsed.view);
        return;
      }
      // Diagnostics never reach the session reducer: a live frame leaves the conversation state alone. (It does
      // re-render ChatSession, which holds this hook, but only while Diagnostics is open: no frames come otherwise.)
      if (parsed.type === "diag.event") {
        if (!diagWantedRef.current || !diagLiveRef.current) return;
        diagLastIdRef.current = Math.max(diagLastIdRef.current ?? 0, parsed.event.id);
        dispatchDiag({ type: "event", event: parsed.event });
        return;
      }
      if (parsed.type === "command.result" && parsed.command === "diag.subscribe") {
        if (!parsed.ok) {
          dispatchDiag({ type: "failed", message: parsed.error.message });
          return;
        }
        // Unsubscribed while it was on its way: the agent stops on the unsubscribe that follows it.
        if (!diagWantedRef.current || parsed.diag === undefined) return;
        diagLiveRef.current = true;
        const newest = lastDiagId(parsed.diag.events);
        if (newest !== undefined) {
          diagLastIdRef.current = Math.max(diagLastIdRef.current ?? 0, newest);
        }
        dispatchDiag({ type: "snapshot", events: parsed.diag.events, health: parsed.diag.health });
        return;
      }
      if (parsed.type === "command.result" && parsed.command === "diag.unsubscribe") return;
      if (parsed.type === "conversation.ops") {
        const view = viewsRef.current.get(parsed.conversationId);
        if (view !== undefined) {
          const next = applyImmutable(view, parsed.ops);
          const failure = next.docs["pi.live"]?.runFailure;
          if (
            failure !== undefined &&
            JSON.stringify(failure) !== JSON.stringify(view.docs["pi.live"]?.runFailure)
          ) {
            requestUsage(true);
          }
          showView(parsed.conversationId, next);
        }
        return;
      }
      // Work ran, or the owner's message was admitted: the agent is awake, so the usage line can catch up.
      if (
        parsed.type === "session.activity" ||
        (parsed.type === "command.result" && parsed.command === "prompt.submit" && parsed.ok)
      ) {
        requestUsage();
      }
      if (parsed.type === "command.result" && parsed.command === "usage.read") {
        // A readout that couldn't be read leaves the last one; the line is a glance, not a control.
        if (parsed.ok) setUsage(parsed.usage);
        return;
      }
      if (parsed.type === "command.result" && parsed.command === "options.list") {
        if (parsed.ok) setOptions(parsed.options);
        else dispatch({ type: "error", message: parsed.error.message });
        return;
      }
      if (parsed.type === "command.result" && parsed.command === "conversation.entries") {
        const pending = pagesRef.current.get(parsed.requestId);
        pagesRef.current.delete(parsed.requestId);
        if (parsed.ok)
          pending?.resolve({ items: parsed.page?.items ?? [], next: parsed.page?.next });
        else pending?.reject(new Error(parsed.error.message));
        return;
      }

      if (
        parsed.type === "error" &&
        (parsed.error.code === "invalid_message" ||
          parsed.error.code === "invalid_command" ||
          parsed.error.code === "frame_too_large")
      ) {
        terminal = true;
        failureMessage = parsed.error.message;
      }
      if (parsed.type === "session.snapshot") {
        // Archived under this tab: the agent moved its watch to MiPi, so the selection (and a reconnect) goes there too.
        if (conversationOpened) {
          selectedConversationRef.current = conversationAfterSnapshot(
            conversationsRef.current,
            parsed.session.conversations,
            selectedConversationRef.current,
          );
        }
        conversationsRef.current = parsed.session.conversations;
        capabilitiesRef.current = new Set(parsed.session.capabilities ?? []);
      }
      dispatch({ type: "event", event: parsed });
      if (parsed.type === "session.snapshot" && !conversationOpened) {
        conversationOpened = true;
        socket.send(
          JSON.stringify({
            type: "options.list",
            requestId: crypto.randomUUID(),
          } satisfies ClientCommand),
        );
        requestUsage(true);
        const desiredConversationId = selectedConversationRef.current;
        const selectedStillExists = parsed.session.conversations.some(
          ({ id }) => id === desiredConversationId,
        );
        const main = mainConversationId(parsed.session.conversations);
        const conversationId = selectedStillExists ? desiredConversationId : main;
        if (conversationId !== undefined) {
          selectedConversationRef.current = conversationId;
          // The door opened MiPi already: any other choice is opened again.
          if (conversationId !== main) {
            dispatch({ type: "select", conversationId });
            socket.send(
              JSON.stringify({
                type: "conversation.open",
                requestId: crypto.randomUUID(),
                conversationId,
              } satisfies ClientCommand),
            );
          }
        }
        // Restore the previous watch first. Replayed create/fork commands then leave the server
        // watching the newest acknowledged conversation rather than the pre-disconnect one.
        outbox.replay((command) => socket.send(JSON.stringify(command)));
        resubscribeDiag();
      }
      if (parsed.type === "command.result") {
        const acknowledged = outbox.acknowledge(parsed);
        if (
          acknowledged !== undefined &&
          parsed.ok &&
          parsed.conversationId !== undefined &&
          (acknowledged.type === "bot.create" ||
            acknowledged.type === "cobot.create" ||
            acknowledged.type === "conversation.fork")
        ) {
          selectedConversationRef.current = parsed.conversationId;
        }
      }
    });
    socket.addEventListener("error", () => {
      if (!terminal) dispatch({ type: "connection", status: "connecting" });
    });
    socket.addEventListener("close", (event) => {
      for (const pending of pagesRef.current.values()) {
        pending.reject(new Error("The session connection closed"));
      }
      pagesRef.current.clear();
      // The new socket subscribes again (`resubscribeDiag`); until then nothing streams.
      diagLiveRef.current = false;
      dispatchDiag({ type: "stopped" });
      if (disposed) return;
      if (terminalProtocolClose(event.code)) {
        terminal = true;
        if (failureMessage === "The session connection failed." && event.reason.length > 0) {
          failureMessage = event.reason;
        }
      }
      if (terminal) {
        if (socketRef.current === socket) socketRef.current = null;
        outbox.clear();
        dispatch({ type: "connection", status: "failed" });
        dispatch({ type: "error", message: failureMessage });
      } else {
        dispatch({ type: "connection", status: "connecting" });
      }
    });

    return () => {
      disposed = true;
      if (usageLater !== undefined) window.clearTimeout(usageLater);
      document.removeEventListener("visibilitychange", onVisible);
      outbox.clear();
      socket.close(1000, "Session view closed");
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [outbox, sessionId, showView]);

  const send = useCallback((command: ClientCommand): boolean => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== socket.OPEN) {
      dispatch({ type: "error", message: "The session is not connected" });
      return false;
    }
    dispatch({ type: "clear-error" });
    socket.send(JSON.stringify(command));
    return true;
  }, []);

  const sendRetriable = useCallback(
    (command: RetriableCommand, complete?: (accepted: boolean) => void): boolean => {
      outbox.enqueue(command, complete);
      if (send(command)) return true;
      outbox.cancel(command.requestId);
      return false;
    },
    [outbox, send],
  );

  const openConversation = useCallback(
    (conversationId: number) => {
      selectedConversationRef.current = conversationId;
      dispatch({ type: "select", conversationId });
      send({ type: "conversation.open", requestId: crypto.randomUUID(), conversationId });
    },
    [send],
  );

  const configureConversation = useCallback(
    (conversationId: number, change: { readonly model?: string; readonly profile?: string }) => {
      send({
        type: "conversation.configure",
        requestId: crypto.randomUUID(),
        conversationId,
        ...change,
      });
    },
    [send],
  );

  const createBot = useCallback(
    (bot: { readonly name: string; readonly purpose: string; readonly profile: string }) =>
      new Promise<boolean>((resolve) => {
        if (
          !sendRetriable({ type: "bot.create", requestId: crypto.randomUUID(), ...bot }, resolve)
        ) {
          resolve(false);
        }
      }),
    [sendRetriable],
  );

  const createCobot = useCallback(
    (bot: number, name: string) =>
      new Promise<boolean>((resolve) => {
        if (
          !sendRetriable(
            { type: "cobot.create", requestId: crypto.randomUUID(), bot, name },
            resolve,
          )
        ) {
          resolve(false);
        }
      }),
    [sendRetriable],
  );

  const renameBot = useCallback(
    (conversationId: number, name: string) => {
      send({ type: "bot.rename", requestId: crypto.randomUUID(), conversationId, name });
    },
    [send],
  );

  const archiveBot = useCallback(
    (conversationId: number) => {
      // Archiving is idempotent on the agent (an archived one archives nothing), so a plain send is enough.
      send({ type: "bot.archive", requestId: crypto.randomUUID(), conversationId });
    },
    [send],
  );

  const restoreBot = useCallback(
    (conversationId: number) => {
      // Restoring is idempotent on the agent (a live one restores nothing), so a plain send is enough.
      send({ type: "bot.restore", requestId: crypto.randomUUID(), conversationId });
    },
    [send],
  );

  const forkConversation = useCallback(
    (conversationId: number, entryId: number) => {
      sendRetriable({
        type: "conversation.fork",
        requestId: crypto.randomUUID(),
        conversationId,
        entryId,
      });
    },
    [sendRetriable],
  );

  const setTyping = useCallback((conversationId: number, typing: boolean) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== socket.OPEN) return;
    socket.send(
      JSON.stringify({ type: "presence.typing", conversationId, typing } satisfies ClientCommand),
    );
  }, []);

  const submitPrompt = useCallback(
    (conversationId: number, content: string): Promise<boolean> => {
      if (content.trim().length === 0) {
        dispatch({ type: "error", message: "A prompt must contain text" });
        return Promise.resolve(false);
      }
      if (content.length > MAX_PROMPT_CHARACTERS) {
        dispatch({
          type: "error",
          message: `A prompt cannot exceed ${MAX_PROMPT_CHARACTERS.toLocaleString()} characters`,
        });
        return Promise.resolve(false);
      }
      if (outbox.has("prompt.submit")) {
        throw new Error("A prompt submission is already pending");
      }
      const command = {
        type: "prompt.submit",
        requestId: crypto.randomUUID(),
        conversationId,
        content,
      } satisfies Extract<ClientCommand, { readonly type: "prompt.submit" }>;
      return new Promise((resolve) => {
        sendRetriable(command, resolve);
      });
    },
    [outbox, sendRetriable],
  );

  const subscribeDiag = useCallback(
    (query: { readonly limit?: number; readonly after?: number } = {}) => {
      diagWantedRef.current = true;
      const socket = socketRef.current;
      // Not connected, or no snapshot has said the agent has diagnostics yet: the session's snapshot subscribes, if
      // the agent has them (`resubscribeDiag`).
      if (
        socket === null ||
        socket.readyState !== socket.OPEN ||
        !capabilitiesRef.current.has("diagnostics")
      )
        return;
      socket.send(
        JSON.stringify({
          type: "diag.subscribe",
          requestId: crypto.randomUUID(),
          ...(query.after === undefined ? {} : { after: query.after }),
          // A catch-up (`after`) takes everything since, up to the agent's own cap, unless a limit is given.
          ...(query.after === undefined
            ? { limit: query.limit ?? DEFAULT_DIAG_TAIL }
            : query.limit === undefined
              ? {}
              : { limit: query.limit }),
        } satisfies ClientCommand),
      );
    },
    [],
  );

  const unsubscribeDiag = useCallback(() => {
    diagWantedRef.current = false;
    diagLiveRef.current = false;
    dispatchDiag({ type: "stopped" });
    const socket = socketRef.current;
    // An agent without diagnostics was never subscribed, and may not know the command.
    if (
      socket === null ||
      socket.readyState !== socket.OPEN ||
      !capabilitiesRef.current.has("diagnostics")
    )
      return;
    socket.send(
      JSON.stringify({
        type: "diag.unsubscribe",
        requestId: crypto.randomUUID(),
      } satisfies ClientCommand),
    );
  }, []);

  const loadEarlier = useCallback((conversationId: number) => {
    const transcript = transcriptsRef.current.get(conversationId);
    if (transcript === undefined) return;
    transcript.loadEarlier(BACKGROUND_CONTEXT).then(
      (view) => dispatch({ type: "view", conversationId, view }),
      (error: Error) => dispatch({ type: "error", message: error.message }),
    );
  }, []);

  const fillGap = useCallback((conversationId: number, gap: TranscriptGap) => {
    const transcript = transcriptsRef.current.get(conversationId);
    if (transcript === undefined) return;
    transcript.fillGap(gap, BACKGROUND_CONTEXT).then(
      (view) => dispatch({ type: "view", conversationId, view }),
      (error: Error) => dispatch({ type: "error", message: error.message }),
    );
  }, []);

  const activeConversation =
    state.activeConversationId === undefined
      ? undefined
      : state.snapshots[state.activeConversationId];

  return {
    status: state.status,
    capabilities: state.capabilities,
    conversations: state.conversations,
    activeConversationId: state.activeConversationId,
    activeConversation,
    activity: state.activity,
    error: state.error,
    options,
    usage,
    diag,
    subscribeDiag,
    unsubscribeDiag,
    configureConversation,
    openConversation,
    createBot,
    createCobot,
    renameBot,
    archiveBot,
    restoreBot,
    forkConversation,
    setTyping,
    submitPrompt,
    loadEarlier,
    fillGap,
  };
}
