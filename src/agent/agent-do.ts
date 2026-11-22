import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type ConversationView,
  type Cursor,
  defineDocFamily,
  type EntryId,
  Harness,
  type TaskGraph,
  type Wake,
  type WatchHandle,
} from "./pi/durable.ts";
import { openDurableObjectSqliteStorage } from "./pi/sqlite.ts";
import { normalizeUsername } from "../lib/identity.ts";
import { APP_TASKS, createHarnessOptions } from "./harness.ts";
import { checkStoredData } from "./guard.ts";
import {
  type ExportCursor,
  type ExportHeader,
  type ExportPage,
  type ExportRow,
  exportHeader,
  exportPage,
  fingerprint,
  type Meta,
  readMeta,
  readSchema,
  restoreRows,
  restoreSchema,
  rowCounts,
  writeMeta,
} from "./maintenance.ts";
import {
  storedSchemaVersion,
  SUPPORTED_SCHEMA_VERSION,
  supportedTaskVersions,
} from "./pi/storage.ts";
import { MIPI_VERSION, PI_DURABLE_VERSION } from "../version.ts";
import {
  InvalidClientCommand,
  MAX_CLIENT_FRAME_CHARACTERS,
  parseClientCommand,
  type ClientCommand,
  type ConversationSummary,
  type ServerEvent,
} from "../protocol.ts";
import { KeyedSerialQueue } from "../lib/serial.ts";

const json = (body: unknown, status: number, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });

const reportError = (
  message: string,
  error: unknown,
  details: Readonly<Record<string, unknown>> = {},
): void => {
  console.error(
    JSON.stringify({
      message,
      ...details,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};

/** While work can run, the alarm stays this far ahead, so an evicted instance is woken to resume it. */
const HEARTBEAT_MS = 60_000;
const CONVERSATION_PAGE_SIZE = 100;

type ConversationCommandReceipt =
  | {
      command: "conversation.create";
      conversationId: ConversationId;
    }
  | {
      command: "conversation.fork";
      conversationId: ConversationId;
      parentConversationId: ConversationId;
      entryId: EntryId;
    };

const ConversationCommandReceipts = defineDocFamily<
  {
    receipt?: ConversationCommandReceipt;
  },
  null
>({
  family: true,
  kind: "app.conversation-command-receipt",
  version: 1,
  scope: "session",
  initial: () => ({}),
  // Written once per request ID, so there is no delta history to bound.
  checkpointWhen: () => false,
});

type SessionConnectionState = {
  readonly username: string;
  readonly conversationId?: number;
  readonly typing?: true;
};

type LegacyPartyServerAttachment = {
  readonly __user?: unknown;
};

type WSMessage = string | ArrayBuffer;

const isSessionConnectionState = (value: unknown): value is SessionConnectionState => {
  if (typeof value !== "object" || value === null || !("username" in value)) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.username === "string" &&
    (state.conversationId === undefined ||
      (typeof state.conversationId === "number" &&
        Number.isSafeInteger(state.conversationId) &&
        state.conversationId > 0)) &&
    (state.typing === undefined || state.typing === true)
  );
};

const connectionState = (socket: WebSocket): SessionConnectionState | null => {
  const attachment: unknown = socket.deserializeAttachment();
  // Hibernated sockets can survive a deployment from the former PartyServer implementation.
  if (isSessionConnectionState(attachment)) return attachment;
  if (typeof attachment !== "object" || attachment === null || !("__user" in attachment)) {
    return null;
  }
  const legacy = attachment as LegacyPartyServerAttachment;
  return isSessionConnectionState(legacy.__user) ? legacy.__user : null;
};

const setConnectionState = (socket: WebSocket, state: SessionConnectionState): void => {
  socket.serializeAttachment(state);
};

const usernameForConnection = (connectionId: string, request: Request): string => {
  const requested = new URL(request.url).searchParams.get("username") ?? "";
  const username = normalizeUsername(requested);
  if (username.length > 0) return username;
  const suffix = connectionId.replace(/[^a-z0-9]/giu, "").slice(0, 6) || "guest";
  return `Guest-${suffix}`;
};

const isReservedCloseCode = (code: number): boolean =>
  code === 1005 || code === 1006 || code === 1015;

const reciprocateClose = (socket: WebSocket, code: number, reason: string): void => {
  if (isReservedCloseCode(code)) return;
  try {
    socket.close(code, reason);
  } catch {
    // The socket is already closed or the peer is no longer reachable.
  }
};

const attributedPrompt = (username: string, content: string): string => `[${username}]\n${content}`;

const conversationSummary = (conversation: ConversationRecord): ConversationSummary => ({
  id: conversation.id,
  ...(conversation.parent === undefined
    ? {}
    : {
        parent: {
          conversationId: conversation.parent.conversationId,
          at: conversation.parent.at,
        },
      }),
  ...(conversation.owner === undefined
    ? {}
    : { owner: { conversationId: conversation.owner.conversationId } }),
});

/**
 * What the agent is doing. Only `open` has a harness; every other state keeps doors and alarms paused.
 * - `refused`: the startup guard found data from a newer build (or a restore in progress) and didn't open it.
 * - `maintenance`: an export or restore is running; the harness is closed so nothing else writes.
 */
export type AgentState =
  | { readonly kind: "open" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "maintenance"; readonly mode: "export" | "restore" };

export interface AdminStatus {
  readonly state: AgentState;
  readonly meta: Meta;
  readonly build: {
    readonly mipi: string;
    readonly piDurable: string;
    readonly supportedSchema: number;
  };
  readonly bookmark?: string;
  readonly rows: Readonly<Record<string, number>>;
}

export class MipiAgent extends DurableObject<Env> {
  #harness!: Harness;
  #state: AgentState = { kind: "refused", reason: "Starting" };
  /** The data's fingerprint when the current export began; a different one at the end means something wrote. */
  #exportFingerprint: string | undefined;
  #activity!: WatchHandle<TaskGraph>;
  readonly #views = new Map<WebSocket, WatchHandle<ConversationView>>();
  readonly #typingConnections = new Set<WebSocket>();
  readonly #connectionOperations = new KeyedSerialQueue<WebSocket>();
  #alarmWrites: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.#start());
  }

  /** Opens the agent unless maintenance is running or the startup guard refuses the stored data. */
  async #start(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const meta = readMeta(sql);
    if (meta.maintenance === "export" || meta.maintenance === "restore") {
      this.#state = { kind: "maintenance", mode: meta.maintenance };
      reportError("Started during maintenance", new Error(`A ${meta.maintenance} was running`), {
        build: MIPI_VERSION,
      });
      return;
    }
    const guard = checkStoredData(sql, APP_TASKS);
    if (!guard.ok) {
      this.#state = { kind: "refused", reason: guard.reason };
      reportError("Startup guard refused the stored data", new Error(guard.reason), {
        storedBy: guard.storedBy,
        build: MIPI_VERSION,
      });
      // Nothing can run, so no heartbeat: a newer deploy or a restore reopens the object.
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.#initialize();
    // Recorded only after Pi Durable opened the data successfully.
    writeMeta(sql, {
      app_version: MIPI_VERSION,
      pi_durable_version: PI_DURABLE_VERSION,
      schema_version: String(storedSchemaVersion(sql) ?? SUPPORTED_SCHEMA_VERSION),
      task_versions: JSON.stringify(supportedTaskVersions(APP_TASKS)),
    });
    this.#state = { kind: "open" };
  }

  /** Closes the harness and every connection, so nothing writes while maintenance runs. */
  async #shutdown(): Promise<void> {
    if (this.#state.kind !== "open") return;
    this.#state = { kind: "refused", reason: "Closing" };
    for (const socket of this.#connections()) {
      try {
        socket.close(1012, "Maintenance");
      } catch {
        // Already closing.
      }
      await this.#stopView(socket);
    }
    this.#typingConnections.clear();
    await this.#activity.stop();
    await this.#harness.close(BACKGROUND_CONTEXT);
    await this.#alarmWrites;
  }

  #refusal(): Response {
    const state = this.#state;
    return json(
      state.kind === "refused"
        ? { error: "Unavailable", reason: state.reason }
        : {
            error: "Maintenance in progress",
            mode: state.kind === "maintenance" ? state.mode : undefined,
          },
      503,
      { "Retry-After": "60" },
    );
  }

  // ---- Admin (called by the Worker's /api/admin routes, which check ADMIN_TOKEN) ----

  async adminStatus(): Promise<AdminStatus> {
    let bookmark: string | undefined;
    try {
      bookmark = await this.ctx.storage.getCurrentBookmark();
    } catch {
      // Point-in-time recovery is not available here.
    }
    return {
      state: this.#state,
      meta: readMeta(this.ctx.storage.sql),
      build: {
        mipi: MIPI_VERSION,
        piDurable: PI_DURABLE_VERSION,
        supportedSchema: SUPPORTED_SCHEMA_VERSION,
      },
      ...(bookmark === undefined ? {} : { bookmark }),
      rows: rowCounts(this.ctx.storage.sql),
    };
  }

  /** Starts an export: closes the harness, pauses everything, and returns the header. Works on refused data too. */
  async exportBegin(): Promise<ExportHeader> {
    return this.#exclusive(async () => {
      if (this.#state.kind === "maintenance") {
        throw new Error(`A ${this.#state.mode} is already running`);
      }
      await this.#shutdown();
      writeMeta(this.ctx.storage.sql, { maintenance: "export" });
      this.#state = { kind: "maintenance", mode: "export" };
      // No alarm while exporting: the run that began the export ends it.
      await this.ctx.storage.deleteAlarm();
      this.#exportFingerprint = fingerprint(this.ctx.storage.sql);
      return exportHeader(this.ctx.storage.sql);
    });
  }

  exportPage(cursor: ExportCursor | undefined): ExportPage {
    this.#requireMaintenance("export");
    return exportPage(this.ctx.storage.sql, readSchema(this.ctx.storage.sql), cursor);
  }

  /**
   * Ends an export and reopens the agent. `consistent` is false when anything wrote during the export (the
   * fingerprint changed), or when that can't be checked (the object restarted mid-export): the export must then be
   * thrown away and taken again.
   */
  async exportEnd(): Promise<{ readonly consistent: boolean }> {
    return this.#exclusive(async () => {
      this.#requireMaintenance("export");
      const consistent =
        this.#exportFingerprint !== undefined &&
        fingerprint(this.ctx.storage.sql) === this.#exportFingerprint;
      this.#exportFingerprint = undefined;
      writeMeta(this.ctx.storage.sql, { maintenance: undefined });
      await this.#start();
      return { consistent };
    });
  }

  /**
   * Starts a restore: wipes this object and recreates the export's schema. The `restoring` flag is written first and
   * cleared last (by `restoreEnd`), so an object that restarts halfway stays closed instead of opening partial data.
   * `confirm` must repeat the export's MiPi version.
   */
  async restoreBegin(header: ExportHeader, confirm: string): Promise<void> {
    const expected = header.meta.app_version ?? "unknown";
    if (confirm !== expected) {
      throw new Error(`Confirm the restore by passing the export's version: ${expected}`);
    }
    await this.#exclusive(async () => {
      if (this.#state.kind === "maintenance" && this.#state.mode === "export") {
        throw new Error("An export is running");
      }
      await this.#shutdown();
      const sql = this.ctx.storage.sql;
      writeMeta(sql, { restoring: "1", maintenance: "restore" });
      this.#state = { kind: "maintenance", mode: "restore" };
      await this.ctx.storage.deleteAll();
      writeMeta(sql, { ...header.meta, restoring: "1", maintenance: "restore" });
      restoreSchema(sql, header);
    });
  }

  restoreRows(rows: readonly ExportRow[]): void {
    this.#requireMaintenance("restore");
    const sql = this.ctx.storage.sql;
    restoreRows(sql, readSchema(sql), rows);
  }

  /** Ends a restore once every row is in (checked against the export's counts), then runs the startup guard. */
  async restoreEnd(expectedRows: Readonly<Record<string, number>>): Promise<AdminStatus> {
    await this.#exclusive(async () => {
      this.#requireMaintenance("restore");
      const sql = this.ctx.storage.sql;
      const actual = rowCounts(sql);
      const tables = new Set([...Object.keys(actual), ...Object.keys(expectedRows)]);
      const mismatched = [...tables].filter(
        (table) => (actual[table] ?? 0) !== (expectedRows[table] ?? 0),
      );
      if (mismatched.length > 0) {
        throw new Error(`Restored rows don't match the export: ${mismatched.join(", ")}`);
      }
      writeMeta(sql, { restoring: undefined, maintenance: undefined });
      await this.#start();
    });
    return this.adminStatus();
  }

  /**
   * Rolls this object's storage back to a point-in-time bookmark, then restarts it (Cloudflare applies the bookmark
   * on the next start). The call itself ends with the object's reset.
   */
  async restoreBookmark(bookmark: string, confirm: string): Promise<never> {
    if (confirm !== bookmark.slice(0, 8)) {
      throw new Error("Confirm the bookmark restore by passing its first 8 characters");
    }
    await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    this.ctx.abort("Restoring a point-in-time bookmark");
    throw new Error("Restarting to apply the bookmark");
  }

  /**
   * Runs `work` with every other event held back. A throw inside `blockConcurrencyWhile` resets the whole object,
   * so errors are carried out and thrown after it instead.
   */
  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const outcome = await this.ctx.blockConcurrencyWhile(
      async (): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
        try {
          return { ok: true, value: await work() };
        } catch (error) {
          return { ok: false, error };
        }
      },
    );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  #requireMaintenance(mode: "export" | "restore"): void {
    if (this.#state.kind !== "maintenance" || this.#state.mode !== mode) {
      throw new Error(`No ${mode} is running`);
    }
  }

  async #initialize(): Promise<void> {
    // A fallback before anything can throw: an object whose open or recovery fails is started again.
    const fallback = Date.now() + HEARTBEAT_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > fallback) await this.ctx.storage.setAlarm(fallback);

    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const harness = await Harness.open(
      storage,
      {
        ...createHarnessOptions({
          modelId: this.env.MIPI_MODEL,
          readEnv: (name) => {
            const value: unknown = (this.env as unknown as Record<string, unknown>)[name];
            return typeof value === "string" ? value : undefined;
          },
        }),
        // `kind` says what happened, e.g. `task_faulted` or `task_interrupted`, with the task and extension.
        onReport: ({ error, ...report }) =>
          reportError("Harness reported a failure", error, report),
        // Called after open and whenever the next wake changes. With `onWake`, the Harness keeps no timer for
        // sleeps: the alarm calls `resume()`. A failed alarm write resets the object; it arms again on restart.
        onWake: (wake) => void this.#arm(wake).catch(() => this.ctx.abort("Alarm write failed")),
      },
      BACKGROUND_CONTEXT,
    );

    // A storage error closes the harness. Reset the object so the next event reopens it.
    void harness.closed.then((end) => {
      if (end.kind === "failed") this.ctx.abort("Harness failed");
    });

    let activity: WatchHandle<TaskGraph> | undefined;
    try {
      this.#harness = harness;
      activity = await harness.watchTaskGraph(BACKGROUND_CONTEXT);
      this.#activity = activity;
      activity.start(async (call) => {
        if (call.kind === "value")
          this.#broadcast({ type: "session.activity", activity: call.value });
      });
      // Subagents are created by background tool tasks, not client commands.
      // Notify connected clients when their conversation records are committed.
      harness.observeCommits({
        advance: (publication) => {
          for (const change of publication.changes) {
            if (change.type !== "conversation" || change.value.owner === undefined) continue;
            this.#broadcast({
              type: "conversation.created",
              conversation: conversationSummary(change.value),
            });
          }
        },
        end: () => {},
      });
      await this.#restoreViews();
      // Armed before `resume()` runs anything, as for any call that can start work.
      await this.#arm(harness.wake());
      // Continue work a lost instance left, and make due sleeps runnable.
      harness.resume();
    } catch (error) {
      await activity?.stop();
      await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.#state.kind !== "open") return this.#refusal();
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionId = new URL(request.url).searchParams.get("_pk") || crypto.randomUUID();

    this.ctx.acceptWebSocket(server);
    setConnectionState(server, { username: usernameForConnection(connectionId, request) });
    try {
      await this.#connect(server);
    } catch (error) {
      reportError("Session WebSocket connection failed", error);
      try {
        server.close(1011, "Session setup failed");
      } catch {
        // The accepted socket may already have closed while setup was running.
      }
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * M1 spike: facts about this account's Durable Objects that decide the rollback plan. Point-in-time recovery
   * bookmarks are the cheap rollback path; without them the SQL/JSON export is the only one (plan §3.5).
   */
  async spikeProbe(): Promise<{
    readonly pitrBookmark: { readonly ok: boolean; readonly detail: string };
  }> {
    try {
      const bookmark = await this.ctx.storage.getCurrentBookmark();
      return {
        pitrBookmark: { ok: true, detail: `got a bookmark (${bookmark.length} characters)` },
      };
    } catch (error) {
      return {
        pitrBookmark: { ok: false, detail: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  override async alarm(): Promise<void> {
    if (this.#state.kind === "maintenance") {
      // Paused, and no alarm writes while an export reads: the run that started maintenance ends it.
      return;
    }
    if (this.#state.kind !== "open") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // Armed before `resume()` can start work, as on open.
    await this.#arm({ ...this.#harness.wake(), active: true });
    this.#harness.resume();
    // Alarms are at-least-once, and `onWake` repeats no unchanged wake: an early or spurious alarm would otherwise
    // leave the heartbeat armed with nothing to do. `wake()` already counts the work `resume()` made runnable.
    await this.#arm(this.#harness.wake());
  }

  override async webSocketMessage(socket: WebSocket, message: WSMessage): Promise<void> {
    if (this.#state.kind !== "open") {
      // A socket that outlived a restart into maintenance or refusal: tell the client to come back later.
      socket.close(1012, "Unavailable");
      return;
    }
    try {
      await this.#connectionOperations.run(socket, () => this.#processMessage(socket, message));
    } catch (error) {
      reportError("Session WebSocket message failed", error);
    }
  }

  async #processMessage(socket: WebSocket, message: WSMessage): Promise<void> {
    if (typeof message !== "string") {
      this.#send(socket, {
        type: "error",
        error: { code: "invalid_message", message: "Binary messages are not supported" },
      });
      socket.close(1002, "Binary protocol frame");
      return;
    }

    if (message.length > MAX_CLIENT_FRAME_CHARACTERS) {
      this.#send(socket, {
        type: "error",
        error: { code: "frame_too_large", message: "Command frame exceeds the size limit" },
      });
      socket.close(1009, "Command frame too large");
      return;
    }

    let command: ClientCommand;
    try {
      command = parseClientCommand(message);
    } catch (error) {
      if (!(error instanceof InvalidClientCommand)) throw error;
      this.#send(socket, {
        type: "error",
        error: { code: "invalid_command", message: error.message },
      });
      socket.close(1002, "Invalid command frame");
      return;
    }

    try {
      await this.#handleCommand(socket, command);
    } catch (error) {
      reportError("Session command failed", error, { command: command.type });
      if (command.type === "presence.typing") return;
      this.#send(socket, {
        type: "command.result",
        command: command.type,
        requestId: command.requestId,
        ok: false,
        error: {
          code: "command_failed",
          message: error instanceof Error ? error.message : "Command failed",
        },
      });
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, async () => {
        this.#setTyping(socket, false);
        await this.#stopView(socket);
      });
    } catch (error) {
      reportError("Session WebSocket close failed", error);
    } finally {
      reciprocateClose(socket, code, reason);
    }
  }

  override async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    try {
      await this.#connectionOperations.run(socket, async () => {
        reportError("Session WebSocket failed", error);
        this.#setTyping(socket, false);
        await this.#stopView(socket);
      });
    } catch (handlerError) {
      reportError("Session WebSocket error cleanup failed", handlerError);
    }
  }

  async #connect(server: WebSocket): Promise<void> {
    const root = await this.#harness.root(BACKGROUND_CONTEXT);
    await this.#sendSessionSnapshot(server);
    await this.#watchConversation(server, root.id);
  }

  async #handleCommand(socket: WebSocket, command: ClientCommand): Promise<void> {
    switch (command.type) {
      case "presence.typing":
        if (connectionState(socket)?.conversationId === command.conversationId) {
          this.#setTyping(socket, command.typing);
        }
        return;
      case "conversation.open":
        await this.#requireConversation(command.conversationId as ConversationId);
        await this.#watchConversation(socket, command.conversationId as ConversationId);
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
        });
        return;
      case "conversation.entries": {
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        const page = await conversation.entries(
          {
            ...(command.minEntryId === undefined
              ? {}
              : { minEntryId: command.minEntryId as EntryId }),
            ...(command.maxEntryId === undefined
              ? {}
              : { maxEntryId: command.maxEntryId as EntryId }),
            order: command.order,
          },
          command.limit,
          undefined,
          BACKGROUND_CONTEXT,
        );
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
          page: { items: page.items, ...(page.next === undefined ? {} : { next: page.next }) },
        });
        return;
      }
      case "conversation.create": {
        const conversationId = await this.#harness.commit(async (tx) => {
          const doc = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = doc.receipt;
          if (existing !== undefined) {
            if (existing.command !== command.type) {
              throw new Error(
                `Request ${command.requestId} was already used for ${existing.command}`,
              );
            }
            return existing.conversationId;
          }
          const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
          doc.receipt = {
            command: command.type,
            conversationId: conversation.id,
          };
          return conversation.id;
        }, BACKGROUND_CONTEXT);
        await this.#watchConversation(socket, conversationId);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId,
        });
        return;
      }
      case "conversation.fork": {
        const parentConversationId = command.conversationId as ConversationId;
        const entryId = command.entryId as EntryId;
        const conversationId = await this.#harness.commit(async (tx) => {
          const doc = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = doc.receipt;
          if (existing !== undefined) {
            if (
              existing.command !== command.type ||
              existing.parentConversationId !== parentConversationId ||
              existing.entryId !== entryId
            ) {
              throw new Error(`Request ${command.requestId} was already used for another command`);
            }
            return existing.conversationId;
          }
          const fork = await tx.forkConversation(parentConversationId, entryId, {
            ownership: { kind: "ownerless" },
          });
          doc.receipt = {
            command: command.type,
            conversationId: fork.id,
            parentConversationId,
            entryId,
          };
          return fork.id;
        }, BACKGROUND_CONTEXT);
        await this.#watchConversation(socket, conversationId);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId,
        });
        return;
      }
      case "prompt.submit": {
        this.#setTyping(socket, false);
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        // Arm before admitting work: `onWake` runs after the commit, so an instance that dies in between is
        // still woken. An early alarm is harmless; a missing one strands the turn.
        await this.#arm({ ...this.#harness.wake(), active: true });
        const submission = await conversation.submit(
          {
            type: "input",
            content: attributedPrompt(
              connectionState(socket)?.username ?? "Guest",
              command.content,
            ),
            requestId: command.requestId,
            // Queue behind a running turn instead of rejecting; the inbox places it after the current answer.
            whenBusy: "followUp",
          },
          BACKGROUND_CONTEXT,
        );
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
          submissionId: submission.id,
        });
        return;
      }
    }
  }

  async #requireConversation(id: ConversationId): Promise<Conversation> {
    const conversation = await this.#harness.conversation(id, BACKGROUND_CONTEXT);
    if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
    return conversation;
  }

  async #sendSessionSnapshot(socket: WebSocket): Promise<void> {
    this.#send(socket, {
      type: "session.snapshot",
      session: { conversations: await this.#sessionSnapshot(), activity: this.#activity.value },
    });
  }

  async #broadcastSessionSnapshot(): Promise<void> {
    this.#broadcast({
      type: "session.snapshot",
      session: { conversations: await this.#sessionSnapshot(), activity: this.#activity.value },
    });
  }

  #sessionSnapshot(): Promise<readonly ConversationSummary[]> {
    return this.#harness.commit(async (tx) => {
      const conversations: ConversationSummary[] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, CONVERSATION_PAGE_SIZE, cursor);
        conversations.push(...page.items.map(conversationSummary));
        cursor = page.next;
      } while (cursor !== undefined);
      return conversations;
    }, BACKGROUND_CONTEXT);
  }

  async #watchConversation(
    socket: WebSocket,
    conversationId: ConversationId,
    restoreTyping = false,
  ): Promise<void> {
    this.#setTyping(socket, false);
    await this.#stopView(socket);
    const username = connectionState(socket)?.username ?? "Guest";
    setConnectionState(socket, { username });
    const conversation = await this.#requireConversation(conversationId);
    // A window over the transcript and the conversation's built-in documents: the run, the streamed answer, tool
    // progress, the queue, the agent, and usage. The client pages older entries with `conversation.entries`.
    const view = await conversation.watch(BACKGROUND_CONTEXT);
    this.#views.set(socket, view);
    setConnectionState(socket, {
      username,
      conversationId,
      ...(restoreTyping ? { typing: true } : {}),
    });
    if (restoreTyping) this.#typingConnections.add(socket);
    this.#send(socket, { type: "conversation.view", conversationId, view: view.value });
    view.start(async (call) => {
      if (this.#views.get(socket) !== view || call.kind !== "value") return;
      this.#send(socket, { type: "conversation.ops", conversationId, ops: call.ops });
    });
    void view.closed.finally(() => {
      if (this.#views.get(socket) === view) this.#views.delete(socket);
    });
    this.#broadcastTyping(conversationId);
  }

  async #stopView(socket: WebSocket): Promise<void> {
    const view = this.#views.get(socket);
    if (view === undefined) return;
    this.#views.delete(socket);
    await view.stop();
  }

  async #restoreViews(): Promise<void> {
    for (const socket of this.#connections()) {
      const attachment = connectionState(socket);
      if (attachment?.conversationId !== undefined) {
        const conversationId = attachment.conversationId as ConversationId;
        await this.#watchConversation(socket, conversationId, attachment.typing === true);
      }
    }
  }

  #connections(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((socket) => socket.readyState === WebSocket.READY_STATE_OPEN);
  }

  #broadcast(event: ServerEvent): void {
    const message = JSON.stringify(event);
    for (const socket of this.#connections()) this.#sendMessage(socket, message);
  }

  #send(socket: WebSocket, event: ServerEvent): void {
    this.#sendMessage(socket, JSON.stringify(event));
  }

  #sendMessage(socket: WebSocket, message: string): void {
    if (socket.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      socket.send(message);
    } catch {
      try {
        socket.close(1011, "Unexpected send error");
      } catch {
        // The socket may already have closed after the ready-state check.
      }
    }
  }

  #setTyping(socket: WebSocket, typing: boolean): void {
    const state = connectionState(socket);
    if (state === null || state.conversationId === undefined) return;
    const conversationId = state.conversationId;
    const changed = typing
      ? !this.#typingConnections.has(socket)
      : this.#typingConnections.delete(socket);
    if (typing) this.#typingConnections.add(socket);
    if (socket.readyState === WebSocket.READY_STATE_OPEN) {
      setConnectionState(socket, {
        username: state.username,
        conversationId,
        ...(typing ? { typing: true } : {}),
      });
    }
    if (changed) this.#broadcastTyping(conversationId as ConversationId);
  }

  #broadcastTyping(conversationId: ConversationId): void {
    const connections = this.#connections().filter(
      (connection) => connectionState(connection)?.conversationId === conversationId,
    );
    const typers = connections.filter((connection) => this.#typingConnections.has(connection));
    for (const receiver of connections) {
      const usernames = [
        ...new Set(
          typers
            .filter((connection) => connection !== receiver)
            .map((connection) => connectionState(connection)?.username)
            .filter((username): username is string => username !== undefined),
        ),
      ].sort((left, right) => left.localeCompare(right));
      this.#send(receiver, { type: "presence.typing", conversationId, usernames });
    }
  }

  /** The one alarm: the earliest sleep, or a recovery heartbeat while work can run, whichever comes first. */
  #arm(wake: Wake): Promise<void> {
    // Serialized, so an older wake cannot overwrite a newer, earlier deadline.
    const write = this.#alarmWrites.then(async () => {
      const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined;
      // `wake.at` is on the Harness clock, which is the default `Date.now`.
      const at =
        heartbeat === undefined || wake.at === undefined
          ? (heartbeat ?? wake.at)
          : Math.min(heartbeat, wake.at);
      if (at === undefined) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(at);
    });
    this.#alarmWrites = write.catch(() => undefined);
    return write;
  }
}
