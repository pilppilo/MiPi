/**
 * The React side of the web session (COD-245): a `SessionClient` (`session/session-client.ts`) on the web's
 * transport and platform, read with `useSyncExternalStore`. The connection, outbox, paging, usage throttle and
 * diagnostics tail all live in the client; this only binds it to a component's lifetime.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type {
  ConnectionStatus,
  ConversationSummary,
  Options,
  TaskGraph,
  UsageReadout,
} from "../protocol.ts";
import { webPlatform } from "./platform/web.ts";
import { connectWebTransport } from "./platform/web-transport.ts";
import type { DiagState } from "./session/diag-buffer.ts";
import type { Platform } from "./session/platform.ts";
import { SessionClient } from "./session/session-client.ts";
import type { ConversationSnapshot, TranscriptGap } from "./session/session-state.ts";
import type { ConnectTransport } from "./session/transport.ts";

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

export function usePiSession(
  sessionId: string,
  initialConversationId?: number,
  host: { readonly platform: Platform; readonly connect: ConnectTransport } = {
    platform: webPlatform,
    connect: connectWebTransport,
  },
): PiSession {
  // One client per session id: the conversation to open first is read only when it is made.
  const client = useMemo(
    () =>
      new SessionClient({
        sessionId,
        ...(initialConversationId === undefined ? {} : { initialConversationId }),
        platform: host.platform,
        connect: host.connect,
      }),
    [sessionId],
  );
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  const { session, options, usage, diag } = useSyncExternalStore(
    client.subscribe,
    client.getState,
    client.getState,
  );

  return {
    status: session.status,
    capabilities: session.capabilities,
    conversations: session.conversations,
    activeConversationId: session.activeConversationId,
    activeConversation:
      session.activeConversationId === undefined
        ? undefined
        : session.snapshots[session.activeConversationId],
    activity: session.activity,
    error: session.error,
    options,
    usage,
    diag,
    subscribeDiag: client.subscribeDiag,
    unsubscribeDiag: client.unsubscribeDiag,
    configureConversation: client.configureConversation,
    openConversation: client.openConversation,
    createBot: client.createBot,
    createCobot: client.createCobot,
    renameBot: client.renameBot,
    archiveBot: client.archiveBot,
    restoreBot: client.restoreBot,
    forkConversation: client.forkConversation,
    setTyping: client.setTyping,
    submitPrompt: client.submitPrompt,
    loadEarlier: client.loadEarlier,
    fillGap: client.fillGap,
  };
}
