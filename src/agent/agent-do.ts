import { DurableObject } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  type Conversation,
  type ConversationId,
  type ConversationRecord,
  type ConversationView,
  configure,
  type Cursor,
  defineDocFamily,
  type ReportInfo,
  type EntryId,
  Harness,
  type TaskGraph,
  type WatchHandle,
} from "./pi/durable.ts";
import { openDurableObjectSqliteStorage } from "./pi/sqlite.ts";
import { normalizeUsername } from "../lib/identity.ts";
import type { MutableModels } from "./pi/ai.ts";
import type { AgentComposition } from "./harness.ts";
import { composeMipi } from "./composition.ts";
import {
  boundConversation,
  Bots,
  clearBotFields,
  ConversationMeta,
  type ConversationMetaState,
  profileOf,
  setProfile,
  startingProfile,
  syncProfileTools,
} from "./conversations.ts";
import { ModelList } from "./model-list.ts";
import { DEFAULT_MODEL_ID } from "./pi/models.ts";
import {
  DEFAULT_PROFILE,
  isProfileName,
  MAIN_PROFILE,
  PICKABLE_PROFILES,
  profileOrDefault,
} from "./profiles.ts";
import { createBot, createCobot, ensureBots, renameBot } from "./bots.ts";
import { bindBotDoor, BOT_LIST_CHANGE } from "./bot-tools.ts";
import {
  abortArchived,
  archivedIn,
  archivedRefusal,
  archiveBot,
  firstLineOf,
  replayHeld,
  restoreBot,
} from "./archive.ts";
import { nameFromFirstMessage, writeTitle } from "./titles.ts";
import { AgentSettings, withOwnHost } from "./settings.ts";
import { ownerTimeZone, stampInput } from "./stamp.ts";
import { checkStoredData } from "./guard.ts";
import { parseDailyRunCap, Proactive } from "./proactive.ts";
import { measureSpend, PAUSED_REPLY, parsePaused, parseSpendCap, Spend } from "./spend.ts";
import { bindLimitRecorder } from "./limits.ts";
import { isPausedNow } from "./gates.ts";
import { AnswerSettlement } from "./answers.ts";
import { readUsage, usageText } from "./usage.ts";
import { ProviderUsageCache } from "./providers.ts";
import {
  type ExportCursor,
  type ExportHeader,
  type ExportPage,
  type ExportRow,
  exportHeader,
  exportPage,
  assertExportable,
  fingerprint,
  isStaleExport,
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
  type DiagEvent,
  type DiagHealth,
  type DiagSnapshot,
  DEFAULT_DIAG_TAIL,
  type Options,
  type ServerEvent,
  type UsageReadout,
} from "../protocol.ts";
import { KeyedSerialQueue } from "../lib/serial.ts";
import type { TelegramInbound } from "../doors/telegram/update.ts";
import type { TelegramAdmission } from "../worker/telegram.ts";
import {
  AlarmScheduler,
  earliestWake,
  HEARTBEAT_MS,
  runAlarmConsumers,
  suspectLostAlarm,
} from "./alarm.ts";
import { type HeartbeatStatus, readHeartbeat } from "./heartbeat.ts";
import { WakeSources } from "./wake-sources.ts";
import { DIAG_TABLE, type DiagInput, DiagLog, type DiagQuery, errorText } from "./diag.ts";
import { isTelegramChange, TelegramChannelRuntime } from "../doors/telegram/channel.ts";
import { botApiSender } from "../doors/telegram/bot-api.ts";
import { RelayRuntime, type RelayResult } from "../doors/relay/relay.ts";
import { webRequest } from "../doors/web/index.ts";

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

type ReportTask = Extract<ReportInfo, { kind: "task_error" }>["task"];

/** A harness report as a diagnostic event: its kind, task and extension, and the error's message. */
const harnessReportEvent = (report: ReportInfo, error: unknown): DiagInput => {
  const event = (
    level: "warn" | "error",
    about: {
      readonly task?: ReportTask;
      readonly extension?: string;
      readonly detail?: Readonly<Record<string, string | number>>;
    } = {},
  ): DiagInput => ({
    level,
    source: "harness",
    kind: "harness.report",
    outcome: "fault",
    summary: `${report.kind}: ${errorText(error)}`,
    ...(about.task === undefined
      ? {}
      : { taskId: String(about.task.id), convId: about.task.conversationId }),
    detail: {
      report: report.kind,
      ...(about.task === undefined ? {} : { task: about.task.kind }),
      ...(about.extension === undefined ? {} : { extension: about.extension }),
      ...about.detail,
    },
  });
  switch (report.kind) {
    case "storage_failed":
    case "listener_error":
      return event(report.kind === "storage_failed" ? "error" : "warn");
    case "migration_failed":
      return event("error", report);
    case "task_faulted":
    case "task_outdated":
      return event("error", { ...report, detail: { reason: report.reason } });
    case "task_interrupted":
      return event("error", {
        ...report,
        detail: { reason: report.reason, restarts: report.restarts },
      });
    case "task_error":
      return event("warn", report);
    case "extension_error":
      return event("error", report);
    case "host_error":
      return event("error", { ...report, detail: { callback: report.callback } });
    default: {
      const _: never = report;
      return event("error");
    }
  }
};

const CONVERSATION_PAGE_SIZE = 100;

type ConversationCommandReceipt =
  | {
      // Stored by builds before bots, which had `conversation.create`: kept so their receipts still read.
      command: "conversation.create";
      conversationId: ConversationId;
    }
  | {
      command: "bot.create";
      conversationId: ConversationId;
      name: string;
    }
  | {
      command: "cobot.create";
      conversationId: ConversationId;
      bot: ConversationId;
      name: string;
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
  /**
   * The conversation was archived when this socket opened it (COD-201): a read-only view, which archive changes never
   * move to MiPi. Cleared when it is restored. Kept in the attachment, so it survives hibernation.
   */
  readonly readOnly?: true;
  /** The socket takes the diagnostic live tail (`diag.subscribe`, COD-235). Kept across hibernation. */
  readonly diag?: true;
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
    (state.typing === undefined || state.typing === true) &&
    (state.readOnly === undefined || state.readOnly === true) &&
    (state.diag === undefined || state.diag === true)
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

/** Every message is the owner's: the speaker comes from `MIPI_OWNER`, never from what a client sends. */
const ownerName = (owner: string | undefined): string => normalizeUsername(owner ?? "") || "owner";

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

const conversationSummary = (
  conversation: ConversationRecord,
  meta?: Readonly<ConversationMetaState> & { readonly profile?: string },
  latestEntryId?: number,
): ConversationSummary => ({
  id: conversation.id,
  ...(meta?.title === undefined ? {} : { title: meta.title }),
  ...(meta?.profile === undefined ? {} : { profile: meta.profile }),
  ...(meta?.kind === undefined ? {} : { kind: meta.kind }),
  ...(meta?.name === undefined ? {} : { name: meta.name }),
  ...(meta?.purpose === undefined ? {} : { purpose: meta.purpose }),
  ...(meta?.bot === undefined ? {} : { bot: meta.bot }),
  ...(meta?.archivedAt === undefined ? {} : { archivedAt: meta.archivedAt }),
  ...(latestEntryId === undefined ? {} : { latestEntryId }),
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
  /** The usage readout (M9) as last measured, with providers' cached figures, while open; absent if it failed. */
  readonly usage?: UsageReadout;
  readonly heartbeat?: HeartbeatStatus;
  /** The extensions in use, in default order, and any replaced at startup (COD-209); absent until composed. */
  readonly extensions?: {
    readonly active: readonly string[];
    readonly replaced: readonly {
      readonly replaced: string;
      readonly by: string;
      readonly tool: string;
    }[];
  };
}

export class MipiAgent extends DurableObject<Env> {
  #harness!: Harness;
  #models!: MutableModels;
  /** The agent as composed at the last start: core, the built-in extensions, the profile table. */
  #composition: AgentComposition | undefined;
  #modelList!: ModelList;
  #state: AgentState = { kind: "refused", reason: "Starting" };
  #pendingAlarmLost: number | undefined;
  /** The close in progress before maintenance (`#closeForMaintenance`). */
  #closing: Promise<void> | undefined;
  /** The data's fingerprint when the current export began; a different one at the end means something wrote. */
  #exportFingerprint: string | undefined;
  #activity!: WatchHandle<TaskGraph>;
  readonly #views = new Map<WebSocket, WatchHandle<ConversationView>>();
  readonly #typingConnections = new Set<WebSocket>();
  readonly #connectionOperations = new KeyedSerialQueue<WebSocket>();
  /**
   * The diagnostic log (COD-216, `diag.ts`): raw SQLite outside Pi Durable, so it records in every state. Nothing is
   * written while maintenance runs: an export's fingerprint includes the database size.
   */
  readonly #diag = new DiagLog(this.ctx.storage.sql, {
    canWrite: () => this.#state.kind !== "maintenance",
    // The live tail: only sockets that asked get a frame, so plain chat sends none.
    onEmit: (event) => this.#broadcastDiag(event),
  });
  /**
   * The parts that need the alarm besides Pi Durable (`wake-sources.ts`): registered while the harness opens
   * (`#initialize`), cleared when it closes (`#shutdown`).
   */
  readonly #wakeSources = new WakeSources(reportError, this.#diag);
  /** The one alarm, for Pi Durable's sleeps, the wake sources and the heartbeat (`alarm.ts`). */
  readonly #alarm = new AlarmScheduler(this.ctx.storage, () => this.#wakeSources.wake());
  /** The Telegram door's admissions, replies and outbox; present while the harness is open. */
  #telegram: TelegramChannelRuntime | undefined;
  /** The PiDu relay's admissions and results (M7); present while the harness is open. */
  #relay: RelayRuntime | undefined;
  /** Each provider's own usage figures for the readout (M9), cached in memory only. */
  #providerUsage = new ProviderUsageCache([]);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => this.#start({ checkAlarm: true }));
  }

  /** Opens the agent unless maintenance is running or the startup guard refuses the stored data. */
  async #start({ checkAlarm = false }: { readonly checkAlarm?: boolean } = {}): Promise<void> {
    const sql = this.ctx.storage.sql;
    let meta = readMeta(sql);
    const staleExport = isStaleExport(meta);
    // Read before the flag is cleared below; reported once the agent is out of maintenance.
    const staleStartedAt = staleExport ? Number(meta.maintenance_started_at) : undefined;
    if (staleExport) {
      // The script that began this export died; nothing is half-written by an export, so the agent opens again.
      reportError("Abandoned a stale export", new Error("The export never ended"), {
        startedAt: meta.maintenance_started_at,
      });
      writeMeta(sql, { maintenance: undefined, maintenance_started_at: undefined });
      meta = readMeta(sql);
    }
    if (meta.maintenance === "export" || meta.maintenance === "restore") {
      this.#state = { kind: "maintenance", mode: meta.maintenance };
      reportError("Started during maintenance", new Error(`A ${meta.maintenance} was running`), {
        build: MIPI_VERSION,
      });
      // Not stored while maintenance runs: it goes to the console in the event's shape.
      this.#diag.emit({
        level: "warn",
        source: "do",
        kind: "startup.maintenance",
        outcome: "held",
        summary: `Started during a ${meta.maintenance}; the agent stays closed until it ends`,
        detail: { mode: meta.maintenance, build: MIPI_VERSION },
      });
      return;
    }
    // Out of maintenance from here (after `exportEnd`, `restoreEnd`, a stale export): what opening reports is stored.
    this.#state = { kind: "refused", reason: "Starting" };
    if (staleStartedAt !== undefined) {
      this.#diag.emit({
        level: "warn",
        source: "do",
        kind: "maintenance.stale_export",
        outcome: "fault",
        summary: "Abandoned an export whose script never ended it",
        ...(Number.isFinite(staleStartedAt) ? { detail: { startedAt: staleStartedAt } } : {}),
      });
    }
    // A composition from an earlier start must not show beside a refusal of this one.
    this.#composition = undefined;
    let composition: AgentComposition;
    try {
      composition = this.#compose();
    } catch (error) {
      // Two extensions claiming one name or tool: a wiring mistake in this build. Refuse clearly, never half-run.
      const reason = `The extensions don't compose: ${error instanceof Error ? error.message : String(error)}`;
      this.#state = { kind: "refused", reason };
      reportError("Composing the agent failed", error, { build: MIPI_VERSION });
      this.#diag.emit({
        level: "error",
        source: "do",
        kind: "startup.refused",
        outcome: "refused",
        summary: reason,
        detail: { cause: "composition", build: MIPI_VERSION },
      });
      await this.ctx.storage.deleteAlarm();
      return;
    }
    this.#composition = composition;
    const guard = checkStoredData(sql, composition.tasks);
    if (!guard.ok) {
      this.#state = { kind: "refused", reason: guard.reason };
      reportError("Startup guard refused the stored data", new Error(guard.reason), {
        storedBy: guard.storedBy,
        build: MIPI_VERSION,
      });
      this.#diag.emit({
        level: "error",
        source: "do",
        kind: "startup.refused",
        outcome: "refused",
        summary: guard.reason,
        detail: {
          cause: "startup-guard",
          build: MIPI_VERSION,
          ...(guard.storedBy === undefined ? {} : { storedBy: guard.storedBy }),
        },
      });
      // Nothing can run, so no heartbeat: a newer deploy or a restore reopens the object.
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const opening = Date.now();
    await this.#initialize(checkAlarm && !staleExport && meta.app_version !== undefined);
    // Recorded only after Pi Durable opened the data successfully.
    writeMeta(sql, {
      app_version: MIPI_VERSION,
      pi_durable_version: PI_DURABLE_VERSION,
      schema_version: String(storedSchemaVersion(sql) ?? SUPPORTED_SCHEMA_VERSION),
      task_versions: JSON.stringify(supportedTaskVersions(composition.tasks)),
    });
    this.#state = { kind: "open" };
    this.#diag.emit({
      level: "info",
      source: "do",
      kind: "startup.open",
      outcome: "ok",
      summary: `Opened MiPi ${MIPI_VERSION}`,
      durationMs: Date.now() - opening,
      detail: {
        build: MIPI_VERSION,
        piDurable: PI_DURABLE_VERSION,
        ...(meta.app_version === undefined || meta.app_version === MIPI_VERSION
          ? {}
          : { previous: meta.app_version }),
      },
    });
  }

  /**
   * Closes the agent before maintenance takes the object, outside `blockConcurrencyWhile`. `harness.close()` waits for
   * the work in flight (a reminder that came due as the agent opened, a door's commit), and that work can wait on
   * events the object's input gate holds back while `blockConcurrencyWhile` runs: closed inside it, the two waited on
   * each other until the object was reset, and an export beginning on a cold start (a deploy's backup) never began.
   * The agent stops taking work first (`#shutdown` leaves `open` before it awaits anything), so nothing new starts.
   */
  async #closeForMaintenance(): Promise<void> {
    // Two maintenance calls at once share one close: the second must not take the object while the first still closes.
    this.#closing ??= this.#shutdown().finally(() => {
      this.#closing = undefined;
    });
    await this.#closing;
  }

  /** Closes the harness and every connection, so nothing writes while maintenance runs. */
  async #shutdown(): Promise<void> {
    if (this.#state.kind !== "open") return;
    this.#flushPendingAlarmLost();
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
    // Closes the Telegram door and the memory pass, and empties the list for the next open.
    this.#wakeSources.close();
    this.#telegram = undefined;
    this.#relay?.close();
    this.#relay = undefined;
    await this.#activity.stop();
    await this.#harness.close(BACKGROUND_CONTEXT);
    await this.#alarm.settled();
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
    this.#flushPendingAlarmLost();
    let bookmark: string | undefined;
    try {
      bookmark = await this.ctx.storage.getCurrentBookmark();
    } catch {
      // Point-in-time recovery is not available here.
    }
    let usage: UsageReadout | undefined;
    let heartbeat: HeartbeatStatus | undefined;
    if (this.#state.kind === "open") {
      const now = Date.now();
      try {
        heartbeat = await readHeartbeat(
          this.#harness,
          this.ctx.storage.sql,
          this.#composition!.extensions.active.flatMap(({ schedules }) => schedules ?? []),
          now,
        );
      } catch (error) {
        reportError("Reading the heartbeat for the admin status failed", error);
      }
      try {
        // As stored: no provider is asked and nothing is written, so a deploy's checks never wait or write.
        usage = await readUsage(this.#harness, this.#providerUsage, now, { fresh: false });
      } catch (error) {
        reportError("Reading the usage for the admin status failed", error);
      }
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
      ...(usage === undefined ? {} : { usage }),
      ...(heartbeat === undefined ? {} : { heartbeat }),
      ...(this.#composition === undefined
        ? {}
        : {
            extensions: {
              active: this.#composition.extensions.active.map(({ name }) => name),
              replaced: this.#composition.extensions.replacements,
            },
          }),
    };
  }

  /**
   * The diagnostic events as stored (COD-216), oldest first. Readable in every state, maintenance too: it writes
   * nothing. The admin API and the live tail come with COD-235.
   */
  diagEvents(query: DiagQuery = {}): readonly DiagEvent[] {
    return this.#diag.read(query);
  }

  /**
   * The admin events route (`GET /api/admin/events`, COD-235): the stored events and the agent's health, in every
   * state. Writes nothing: no pending alarm loss is flushed, and the log is only read.
   */
  adminEvents(query: DiagQuery = {}): Promise<DiagSnapshot> {
    return this.#diagSnapshot(query);
  }

  async #diagSnapshot(query: DiagQuery): Promise<DiagSnapshot> {
    return { events: this.#diag.read(query), health: await this.#diagHealth() };
  }

  async #diagHealth(): Promise<DiagHealth> {
    const state = this.#state;
    const meta = readMeta(this.ctx.storage.sql);
    let alarmAt: number | null = null;
    try {
      alarmAt = await this.ctx.storage.getAlarm();
    } catch (error) {
      reportError("Reading the alarm for diagnostics failed", error);
    }
    const lostAt = Number(meta.alarm_lost_at);
    const health: DiagHealth = {
      state: state.kind,
      ...(state.kind === "refused" ? { reason: state.reason } : {}),
      ...(state.kind === "maintenance" ? { reason: state.mode } : {}),
      ...(alarmAt === null ? {} : { alarmAt }),
      ...(Number.isFinite(lostAt) && lostAt > 0 ? { alarmLostAt: lostAt } : {}),
      overdueSchedules: 0,
    };
    if (state.kind !== "open") return health;
    try {
      const heartbeat = await readHeartbeat(
        this.#harness,
        this.ctx.storage.sql,
        this.#composition!.extensions.active.flatMap(({ schedules }) => schedules ?? []),
        Date.now(),
      );
      return {
        ...health,
        ...(heartbeat.held === undefined ? {} : { held: heartbeat.held }),
        ...(heartbeat.heldUntil === undefined ? {} : { heldUntil: heartbeat.heldUntil }),
        overdueSchedules: heartbeat.overdue.length,
        ...(heartbeat.lastProactiveRun === undefined
          ? {}
          : { lastProactiveRun: heartbeat.lastProactiveRun }),
      };
    } catch (error) {
      reportError("Reading the heartbeat for diagnostics failed", error);
      return health;
    }
  }

  /** Core, the built-in extensions and the profile table, configured from the bindings. Throws on a conflict. */
  #compose(): AgentComposition {
    const composition = composeMipi({
      diag: this.#diag,
      modelId: this.env.MIPI_MODEL,
      profile: profileOrDefault(this.env.MIPI_PROFILE),
      readEnv: (name) => {
        const value: unknown = (this.env as unknown as Record<string, unknown>)[name];
        return typeof value === "string" ? value : undefined;
      },
    });
    for (const replacement of composition.extensions.replacements) {
      console.log(JSON.stringify({ message: "Replaced a built-in extension", ...replacement }));
    }
    return composition;
  }

  /** Starts an export: closes the harness, pauses everything, and returns the header. Works on refused data too. */
  async exportBegin(): Promise<ExportHeader> {
    const refuseBusy = () => {
      // An abandoned export doesn't block a new one; a running restore does.
      if (
        this.#state.kind === "maintenance" &&
        !(this.#state.mode === "export" && isStaleExport(readMeta(this.ctx.storage.sql)))
      ) {
        throw new Error(`A ${this.#state.mode} is already running`);
      }
    };
    refuseBusy();
    // Before anything closes: data the export can't copy is refused while the agent keeps running.
    assertExportable(this.ctx.storage.sql);
    await this.#closeForMaintenance();
    return this.#exclusive(async () => {
      refuseBusy();
      // Before the agent enters maintenance (no writes after that) and before the fingerprint is taken.
      this.#diag.emit({
        level: "info",
        source: "do",
        kind: "maintenance.export_begin",
        outcome: "ok",
        summary: "An export began; the agent is closed until it ends",
      });
      writeMeta(this.ctx.storage.sql, {
        maintenance: "export",
        maintenance_started_at: String(Date.now()),
      });
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
      writeMeta(this.ctx.storage.sql, {
        maintenance: undefined,
        maintenance_started_at: undefined,
      });
      await this.#start();
      // After the reopen: maintenance is over, so the event is stored.
      this.#diag.emit({
        level: consistent ? "info" : "warn",
        source: "do",
        kind: "maintenance.export_end",
        outcome: consistent ? "ok" : "fault",
        summary: consistent
          ? "The export ended consistent"
          : "The export ended inconsistent: something wrote during it, so it must be taken again",
        detail: { consistent },
      });
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
    if (this.#state.kind === "maintenance" && this.#state.mode === "export") {
      throw new Error("An export is running");
    }
    await this.#closeForMaintenance();
    await this.#exclusive(async () => {
      if (this.#state.kind === "maintenance" && this.#state.mode === "export") {
        throw new Error("An export is running");
      }
      const sql = this.ctx.storage.sql;
      writeMeta(sql, {
        restoring: "1",
        maintenance: "restore",
        maintenance_started_at: String(Date.now()),
      });
      this.#state = { kind: "maintenance", mode: "restore" };
      await this.ctx.storage.deleteAll();
      // The diagnostic table went with everything else; the next event made after the restore makes it again.
      this.#diag.reset();
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
      // An older build's export counts the diagnostic log too; the restore leaves it out (`restoreRows`).
      const tables = new Set(
        [...Object.keys(actual), ...Object.keys(expectedRows)].filter(
          (table) => table !== DIAG_TABLE,
        ),
      );
      const mismatched = [...tables].filter(
        (table) => (actual[table] ?? 0) !== (expectedRows[table] ?? 0),
      );
      if (mismatched.length > 0) {
        throw new Error(`Restored rows don't match the export: ${mismatched.join(", ")}`);
      }
      writeMeta(sql, {
        restoring: undefined,
        maintenance: undefined,
        maintenance_started_at: undefined,
      });
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

  /** An object that stayed in memory through an abandoned export opens again on the next request. */
  async #reopenIfStaleExport(): Promise<void> {
    if (this.#state.kind !== "maintenance" || this.#state.mode !== "export") return;
    if (!isStaleExport(readMeta(this.ctx.storage.sql))) return;
    await this.#exclusive(async () => {
      if (this.#state.kind === "maintenance" && this.#state.mode === "export") {
        this.#exportFingerprint = undefined;
        await this.#start();
      }
    });
  }

  #requireMaintenance(mode: "export" | "restore"): void {
    if (this.#state.kind !== "maintenance" || this.#state.mode !== mode) {
      throw new Error(`No ${mode} is running`);
    }
  }

  /** Stores the daily cap for scheduled runs (`MIPI_DAILY_RUN_CAP`); an invalid value is reported and the default used. */
  async #applyDailyRunCap(harness: Harness): Promise<void> {
    const { cap, invalid } = parseDailyRunCap(this.env.MIPI_DAILY_RUN_CAP);
    if (invalid !== undefined) {
      reportError("MIPI_DAILY_RUN_CAP is not a whole number", new Error(`Got "${invalid}"`), {
        using: cap,
      });
    }
    await harness.commit(async (tx) => {
      const state = await tx.doc(Proactive);
      if (state.limit !== cap) state.limit = cap;
    }, BACKGROUND_CONTEXT);
  }

  /**
   * Stores the spend cap (`MIPI_DAILY_SPEND_CAP`) and the pause switch (`MIPI_PAUSED`) where tasks read them (M9). An
   * invalid cap is reported and means none; an invalid pause value is reported and pauses.
   */
  async #applySpendSettings(harness: Harness): Promise<void> {
    const { cap, invalid } = parseSpendCap(this.env.MIPI_DAILY_SPEND_CAP);
    if (invalid !== undefined) {
      reportError(
        "MIPI_DAILY_SPEND_CAP is not an amount of dollars",
        new Error(`Got "${invalid}"`),
        {
          using: "no cap",
        },
      );
    }
    const pause = parsePaused(this.env.MIPI_PAUSED);
    if (pause.invalid !== undefined) {
      reportError("MIPI_PAUSED is neither on nor off", new Error(`Got "${pause.invalid}"`), {
        using: "paused",
      });
    }
    await harness.commit(async (tx) => {
      const state = await tx.doc(Spend);
      // The first start with the cap: today's count starts now, not at the first reminder or message to come.
      if (state.lastTotal === undefined) await measureSpend(tx, Date.now());
      if (cap === undefined) {
        if (state.limit !== undefined) delete state.limit;
      } else if (state.limit !== cap) {
        state.limit = cap;
      }
      if (pause.paused && state.paused !== true) state.paused = true;
      if (!pause.paused && state.paused !== undefined) delete state.paused;
    }, BACKGROUND_CONTEXT);
  }

  #readUsage(): Promise<UsageReadout> {
    return readUsage(this.#harness, this.#providerUsage, Date.now());
  }

  #flushPendingAlarmLost(): void {
    const at = this.#pendingAlarmLost;
    if (at === undefined) return;
    writeMeta(this.ctx.storage.sql, { alarm_lost_at: String(at) });
    this.#pendingAlarmLost = undefined;
    reportError("The agent's alarm was missing at startup", new Error("Lost alarm"), { at });
    this.#diag.emit({
      level: "warn",
      source: "do",
      kind: "alarm.lost",
      outcome: "fault",
      summary: "The agent's alarm was missing at startup",
      ts: at,
      detail: { at },
    });
  }

  async #initialize(checkAlarm: boolean): Promise<void> {
    // A fallback before anything can throw: an object whose open or recovery fails is started again.
    const fallback = Date.now() + HEARTBEAT_MS;
    const alarmBeforeStart = await this.ctx.storage.getAlarm();
    if (alarmBeforeStart === null || alarmBeforeStart > fallback) {
      await this.ctx.storage.setAlarm(fallback);
    }

    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const composition = this.#composition ?? this.#compose();
    const { options, profiles } = composition;
    this.#models = options.models as MutableModels;
    const read = (name: string) => this.#setting(name);
    this.#modelList = new ModelList(composition.providers.modelSources(read), fetch, this.#diag);
    this.#providerUsage = new ProviderUsageCache(
      composition.providers.usageSources(read),
      fetch,
      this.#diag,
    );
    const harness = await Harness.open(
      storage,
      {
        ...options,
        // `kind` says what happened, e.g. `task_faulted` or `task_interrupted`, with the task and extension.
        onReport: ({ error, ...report }) => {
          reportError("Harness reported a failure", error, report);
          this.#diag.emit(harnessReportEvent(report, error));
        },
        // Called after open and whenever the next wake changes. With `onWake`, the Harness keeps no timer for
        // sleeps: the alarm calls `resume()`. A failed alarm write resets the object; it arms again on restart.
        onWake: (wake) =>
          void this.#alarm.schedule(wake).catch(() => this.ctx.abort("Alarm write failed")),
      },
      BACKGROUND_CONTEXT,
    );

    // A storage error closes the harness. Reset the object so the next event reopens it.
    void harness.closed.then((end) => {
      if (end.kind !== "failed") return;
      this.#diag.emit({
        level: "error",
        source: "harness",
        kind: "harness.failed",
        outcome: "fault",
        summary: "The harness failed and closed; the object resets",
      });
      this.ctx.abort("Harness failed");
    });

    let activity: WatchHandle<TaskGraph> | undefined;
    try {
      this.#harness = harness;
      bindLimitRecorder(
        composition.limitExtension,
        harness,
        composition.providers,
        this.#providerUsage,
        Date.now,
        (error, provider) => reportError("Recording a provider limit failed", error, { provider }),
        this.#diag,
      );
      // Tasks (scheduled deliveries) read the owner's time zone from the session, not from module state.
      const timeZone = ownerTimeZone(this.env.MIPI_TIMEZONE);
      await harness.commit(async (tx) => {
        const settings = await tx.doc(AgentSettings);
        if (settings.timeZone !== timeZone) settings.timeZone = timeZone;
      }, BACKGROUND_CONTEXT);
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
          // Each source decides which commits make it look again (`WakeSource.observes`).
          this.#wakeSources.observe(publication);
          // Each conversation's newest stored entry: the list's unread dots, from the commit itself (COD-197).
          const heads = new Map<number, number>();
          for (const change of publication.changes) {
            if (change.type === "entry") {
              const { conversationId, id } = change.value;
              heads.set(conversationId, Math.max(id, heads.get(conversationId) ?? 0));
            }
            if (change.type !== "conversation" || change.value.owner === undefined) continue;
            this.#broadcast({
              type: "conversation.created",
              conversation: conversationSummary(change.value),
            });
          }
          for (const [conversationId, latestEntryId] of heads) {
            this.#broadcast({ type: "conversation.head", conversationId, latestEntryId });
          }
          if (
            this.#connections().length > 0 &&
            publication.changes.some(
              (change) =>
                (change.type === "document" && change.record?.kind === BOT_LIST_CHANGE) ||
                (change.type === "conversation" && change.value.owner === undefined),
            )
          ) {
            this.ctx.waitUntil(
              Promise.resolve()
                .then(async () => {
                  if (this.#harness !== harness || this.#state.kind !== "open") return;
                  const archived =
                    (await harness.snapshot(Bots, BACKGROUND_CONTEXT))?.archived ?? {};
                  if (this.#harness !== harness || this.#state.kind !== "open") return;
                  // Archived by a tool (`stop_bot`), say: its watchers move. A read-only view stays (`readOnly`).
                  await this.#leaveArchived(
                    Object.keys(archived).map(Number) as ConversationId[],
                    harness,
                  );
                  if (this.#harness === harness && this.#state.kind === "open") {
                    await this.#broadcastSessionSnapshot();
                  }
                })
                .catch((error) => {
                  if (this.#harness === harness && this.#state.kind === "open") {
                    reportError("Refreshing the web bot list failed", error);
                  }
                }),
            );
          }
        },
        end: () => {},
      });
      // MiPi, once: before any door reads a binding, so every door reaches it (COD-197).
      if (await ensureBots(harness, profiles, Date.now())) {
        console.log(JSON.stringify({ message: "Made the main bot and archived older chats" }));
      }
      // Before anything runs: every conversation offers its profile's tools (older ones may lack them).
      const synced = await syncProfileTools(harness, profiles);
      if (synced.length > 0) {
        console.log(
          JSON.stringify({
            message: "Gave conversations their profile's tools",
            conversations: synced,
          }),
        );
      }
      await this.#applyDailyRunCap(harness);
      await this.#applySpendSettings(harness);
      await this.#restoreViews();
      const telegram = new TelegramChannelRuntime({
        harness,
        owner: ownerName(this.env.MIPI_OWNER),
        timeZone: this.env.MIPI_TIMEZONE,
        profile: startingProfile("telegram", profileOrDefault(this.env.MIPI_PROFILE)),
        profiles,
        version: MIPI_VERSION,
        modelList: this.#modelList,
        send: botApiSender(this.#setting("TELEGRAM_BOT_TOKEN")),
        delivery: composition.connectors.delivery,
        armAlarm: () => this.#alarm.schedule({ ...harness.wake(), active: true }),
        onWakeChange: () =>
          void this.#alarm
            .schedule(harness.wake())
            .catch(() => this.ctx.abort("Alarm write failed")),
        onSubmitted: (conversationId, text) => this.#nameConversation(conversationId, text),
        usage: async () => usageText(await this.#readUsage(), this.env.MIPI_TIMEZONE),
        report: reportError,
        diag: this.#diag,
      });
      this.#telegram = telegram;
      // Core's answer settlement: every door's inputs and every reminder, judged once and delivered through the doors.
      const answers = new AnswerSettlement({
        harness,
        connectors: composition.connectors,
        providers: composition.providers,
        // Telegram sends what was queued now, rather than at the next alarm.
        onQueued: () => telegram.refresh(),
        onWakeChange: () =>
          this.#alarm.schedule(harness.wake()).catch(() => this.ctx.abort("Alarm write failed")),
        report: reportError,
      });
      // Each part that needs the alarm, once. The alarm runs them in this order, after Pi Durable's resume: answers
      // first, so what they queue drains in the same alarm.
      this.#wakeSources.register(answers);
      this.#wakeSources.register({
        name: "Telegram door",
        wake: () => telegram.wake(),
        // Telegram windows, replies, deferred commands and sends that are due.
        run: () => telegram.recover(),
        // Core's settlement, a reminder or a notice queues Telegram messages in the door's outbox.
        observes: isTelegramChange,
        refresh: () => telegram.refresh(),
        close: () => telegram.close(),
      });
      // Then each extension's background work, in default order (today the memory pass).
      const prepares: Array<() => Promise<void>> = [];
      for (const extension of composition.extensions.active) {
        const sources =
          extension.wakeSources?.({
            harness,
            origins: composition.connectors.origins,
            models: this.#models,
            untrustedTools: composition.extensions.untrustedTools,
            onWakeChange: () =>
              void this.#alarm
                .schedule(harness.wake())
                .catch(() => this.ctx.abort("Alarm write failed")),
            report: reportError,
            diag: this.#diag,
          }) ?? [];
        for (const source of sources) {
          this.#wakeSources.register(source);
          const prepare = source.prepare;
          if (prepare !== undefined) prepares.push(() => prepare.call(source));
        }
      }
      this.#relay = new RelayRuntime({
        harness,
        providers: composition.providers,
        timeZone: this.env.MIPI_TIMEZONE,
        profile: startingProfile("relay", profileOrDefault(this.env.MIPI_PROFILE)),
        profiles,
        armAlarm: () => this.#alarm.schedule({ ...harness.wake(), active: true }),
        onSubmitted: (conversationId, text) => this.#nameConversation(conversationId, text),
        report: reportError,
        diag: this.#diag,
      });
      // Each source's first look, before the alarm is set: its wake is in the first write, and nothing of it is in
      // flight once opening is over (the memory pass).
      for (const prepare of prepares) await prepare();
      if (checkAlarm) {
        const now = Date.now();
        const wake = earliestWake(harness.wake(), this.#wakeSources.wake());
        // The alarm handler gets the first chance to identify an ordinary alarm delivery.
        if (suspectLostAlarm(alarmBeforeStart, wake, now)) this.#pendingAlarmLost = now;
      }
      // Armed before `resume()` runs anything, as for any call that can start work.
      await this.#alarm.schedule(harness.wake());
      // Continue work a lost instance left, and make due sleeps runnable.
      harness.resume();
      // Answers and sends a lost instance left; not awaited, so opening never waits on Telegram.
      void answers
        .start()
        .catch((error) => reportError("Starting the answer settlement failed", error));
      void telegram
        .start()
        .catch((error) => reportError("Starting the Telegram door failed", error));
      // Held reminders a restore left (cut short, or paused then): sent now, if MiPi isn't paused (COD-198).
      void replayHeld(harness, undefined, Date.now(), BACKGROUND_CONTEXT, () =>
        this.#alarm.schedule({ ...harness.wake(), active: true }),
      )
        .then((sent) => {
          if (sent > 0) console.log(JSON.stringify({ message: "Sent held reminders", sent }));
        })
        .catch((error) => reportError("Sending held reminders failed", error));
    } catch (error) {
      // A failed open leaves no source behind for the next one to register again.
      this.#wakeSources.close();
      this.#telegram = undefined;
      this.#relay?.close();
      this.#relay = undefined;
      await activity?.stop();
      await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  /** Optional configuration, read where the object meets its bindings: a secret may be absent at runtime. */
  #setting(name: string): string | undefined {
    const value: unknown = (this.env as unknown as Record<string, unknown>)[name];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }

  /**
   * Called by the Worker's Telegram webhook with an update it authenticated and parsed. Resolves once the update is
   * stored; `unavailable` (maintenance, refused data, a failed commit) makes Telegram deliver it again later.
   */
  async telegramAdmit(update: TelegramInbound, host?: string): Promise<TelegramAdmission> {
    this.#flushPendingAlarmLost();
    await this.#reopenIfStaleExport();
    const telegram = this.#telegram;
    if (this.#state.kind !== "open" || telegram === undefined) {
      this.#diag.emit({
        level: "warn",
        source: "door:telegram",
        kind: "telegram.admit",
        outcome: "refused",
        summary: `A Telegram update waits: the agent is ${this.#state.kind}`,
        reqId: `tg:${update.updateId}`,
        detail: { state: this.#state.kind },
      });
      return { kind: "unavailable" };
    }
    await this.#noteHost(host);
    try {
      await telegram.admit(update);
      return { kind: "stored" };
    } catch (error) {
      reportError("Admitting a Telegram update failed", error, { updateId: update.updateId });
      this.#diag.emit({
        level: "error",
        source: "door:telegram",
        kind: "telegram.admit",
        outcome: "fault",
        summary: `Admitting a Telegram update failed: ${errorText(error)}`,
        reqId: `tg:${update.updateId}`,
      });
      return { kind: "unavailable" };
    }
  }

  /**
   * Called by the Worker's relay route with an authenticated message (M7). Admits it and waits a while for the answer;
   * `pending` means the client polls `relayResult`. Nothing here holds a queue while it waits.
   */
  async relayAdmit(key: string, text: string, host?: string): Promise<RelayResult> {
    return this.#relayCall("relay.admit", "Admitting a relay message failed", key, host, (relay) =>
      relay.admit(key, text),
    );
  }

  /** Where a relay key stands (M7). */
  async relayResult(key: string, host?: string): Promise<RelayResult> {
    return this.#relayCall("relay.poll", "Reading a relay result failed", key, host, (relay) =>
      relay.result(key),
    );
  }

  async #relayCall(
    kind: "relay.admit" | "relay.poll",
    failure: string,
    key: string,
    host: string | undefined,
    call: (relay: RelayRuntime) => Promise<RelayResult>,
  ): Promise<RelayResult> {
    this.#flushPendingAlarmLost();
    await this.#reopenIfStaleExport();
    const relay = this.#relay;
    if (this.#state.kind !== "open" || relay === undefined) {
      this.#diag.emit({
        level: "warn",
        source: "door:relay",
        kind,
        outcome: "refused",
        summary: `A relay call was refused: the agent is ${this.#state.kind}`,
        reqId: `relay:${key}`,
        detail: { state: this.#state.kind },
      });
      return { kind: "unavailable" };
    }
    await this.#noteHost(host);
    try {
      return await call(relay);
    } catch (error) {
      reportError(failure, error, { key });
      this.#diag.emit({
        level: "error",
        source: "door:relay",
        kind,
        outcome: "fault",
        summary: `${failure}: ${errorText(error)}`,
        reqId: `relay:${key}`,
      });
      return { kind: "unavailable" };
    }
  }

  /**
   * Records a hostname this agent was reached on, for `web_fetch` to refuse (`AgentSettings.ownHosts`). Writes only
   * for a host not seen before; a failure is reported and never fails the request that brought it.
   */
  async #noteHost(host: string | undefined): Promise<void> {
    if (host === undefined || this.#state.kind !== "open") return;
    try {
      await this.#harness.commit(async (tx) => {
        const settings = await tx.doc(AgentSettings);
        const hosts = withOwnHost(settings.ownHosts, host);
        if (hosts !== undefined) settings.ownHosts = hosts;
      }, BACKGROUND_CONTEXT);
    } catch (error) {
      reportError("Recording this agent's hostname failed", error, { host });
    }
  }

  override async fetch(request: Request): Promise<Response> {
    this.#flushPendingAlarmLost();
    await this.#reopenIfStaleExport();
    if (this.#state.kind !== "open") return this.#refusal();
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
    }
    await this.#noteHost(new URL(request.url).hostname);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    setConnectionState(server, { username: ownerName(this.env.MIPI_OWNER) });
    try {
      await this.#connect(server);
      this.#diag.emit({
        level: "debug",
        source: "door:web",
        kind: "ws.connect",
        outcome: "ok",
        summary: "A web socket connected",
        detail: { sockets: this.#connections().length },
      });
    } catch (error) {
      reportError("Session WebSocket connection failed", error);
      this.#diag.emit({
        level: "error",
        source: "door:web",
        kind: "ws.connect",
        outcome: "fault",
        summary: `A web socket failed to set up: ${errorText(error)}`,
      });
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
    this.#flushPendingAlarmLost();
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
    this.#pendingAlarmLost = undefined;
    if (this.#state.kind === "maintenance") {
      // Paused, and no alarm writes while an export reads: the run that started maintenance ends it.
      return;
    }
    if (this.#state.kind !== "open") {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const harness = this.#harness;
    // Armed before `resume()` can start work, as on open.
    await this.#alarm.schedule({ ...harness.wake(), active: true });
    await runAlarmConsumers(
      [
        // Continue work a lost instance left, and make due sleeps runnable.
        ["Pi Durable resume", () => harness.resume()],
        // Then each wake source, in registration order.
        ...this.#wakeSources.consumers(),
      ],
      reportError,
      // Alarms are at-least-once, and `onWake` repeats no unchanged wake: an early or spurious alarm would otherwise
      // leave the heartbeat armed with nothing to do. `wake()` already counts the work `resume()` made runnable. Not
      // while maintenance runs: the export or restore that started it owns the alarm until it ends.
      async () => {
        if (this.#state.kind === "open") await this.#alarm.schedule(harness.wake());
      },
      this.#diag,
    );
  }

  override async webSocketMessage(socket: WebSocket, message: WSMessage): Promise<void> {
    this.#flushPendingAlarmLost();
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
      this.#diag.emit({
        // The owner sees it in the command's reply: most are refusals (an archived bot, a model not served).
        level: "warn",
        source: "door:web",
        kind: "ws.command_failed",
        outcome: "fault",
        summary: `${command.type} failed: ${errorText(error)}`,
        ...(command.type === "presence.typing" ? {} : { reqId: command.requestId }),
        detail: { command: command.type },
      });
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
    this.#flushPendingAlarmLost();
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
    this.#flushPendingAlarmLost();
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
    // The web door opens the bot its binding names: MiPi, until the owner picks another (COD-197).
    const bound = await this.#harness.commit(
      (tx) =>
        boundConversation(
          tx,
          "web",
          startingProfile("web", profileOrDefault(this.env.MIPI_PROFILE)),
          this.#composition!.profiles,
        ),
      BACKGROUND_CONTEXT,
    );
    await this.#sendSessionSnapshot(server);
    await this.#watchConversation(server, bound);
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
      case "bot.create": {
        const profile = command.profile;
        // A purpose bot runs on a profile the pickers offer: never MiPi's `main`, nor the relay's old `pidu`.
        if (!isProfileName(profile) || !PICKABLE_PROFILES.includes(profile)) {
          throw new Error(
            `${profile} can't be a bot's profile: pick one of ${PICKABLE_PROFILES.join(", ")}`,
          );
        }
        const conversationId = await this.#harness.commit(async (tx) => {
          const doc = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = doc.receipt;
          if (existing !== undefined) {
            if (existing.command !== command.type || existing.name !== command.name) {
              throw new Error(`Request ${command.requestId} was already used for another command`);
            }
            return existing.conversationId;
          }
          const id = await createBot(
            tx,
            {
              kind: "bot",
              name: command.name,
              purpose: command.purpose,
              profile,
              createdBy: "owner",
            },
            this.#composition!.profiles,
          );
          doc.receipt = { command: command.type, conversationId: id, name: command.name };
          return id;
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
      case "cobot.create": {
        const bot = command.bot as ConversationId;
        const conversationId = await this.#harness.commit(async (tx) => {
          const doc = await tx.doc(ConversationCommandReceipts, command.requestId, null);
          const existing = doc.receipt;
          if (existing !== undefined) {
            if (
              existing.command !== command.type ||
              existing.bot !== bot ||
              existing.name !== command.name
            ) {
              throw new Error(`Request ${command.requestId} was already used for another command`);
            }
            const archived = await archivedRefusal(tx, existing.conversationId);
            if (archived !== undefined) throw new Error(archived);
            return existing.conversationId;
          }
          const id = await createCobot(tx, bot, command.name, this.#composition!.profiles);
          doc.receipt = { command: command.type, conversationId: id, bot, name: command.name };
          return id;
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
      case "bot.bind": {
        const conversationId = command.conversationId as ConversationId;
        await this.#harness.commit(
          (tx) =>
            bindBotDoor(
              tx,
              this.#composition!.connectors.rebindableKeys,
              command.channel,
              conversationId,
            ),
          BACKGROUND_CONTEXT,
        );
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId,
        });
        return;
      }
      case "bot.rename": {
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        await this.#harness.commit(
          (tx) => renameBot(tx, conversation.id, command.name),
          BACKGROUND_CONTEXT,
        );
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
        });
        return;
      }
      case "bot.archive": {
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        // One commit: the bot and its cobots (or a cobot alone) archived and indexed, so from here no door reaches them, nothing lists
        // them and their schedules hold. Then what they were doing is stopped (`Conversation.abort()`).
        const archived = await this.#harness.commit(
          (tx) => archiveBot(tx, conversation.id, Date.now()),
          BACKGROUND_CONTEXT,
        );
        await abortArchived(this.#harness, archived, BACKGROUND_CONTEXT);
        await this.#leaveArchived(archived);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
        });
        return;
      }
      case "bot.restore": {
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        const firstLine = await this.#earlierChatFirstLine(conversation);
        const { restored, conversations } = await this.#harness.commit(
          (tx) => restoreBot(tx, conversation.id, this.#composition!.profiles, firstLine),
          BACKGROUND_CONTEXT,
        );
        // Live again: its views stop being read-only, so a later archive moves them to MiPi as any.
        this.#clearReadOnly(restored);
        // Held reminders go out marked late; while paused they stay held for the next start (`replayHeld`).
        await replayHeld(this.#harness, conversations, Date.now(), BACKGROUND_CONTEXT, () =>
          this.#alarm.schedule({ ...this.#harness.wake(), active: true }),
        );
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
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
          // A fork is a chat of its own, never a second copy of its bot (the meta forks with it), nor on MiPi's
          // `main`, whose tools are MiPi's alone.
          const forkMeta = await tx.doc(ConversationMeta, fork.id);
          clearBotFields(forkMeta);
          if (forkMeta.profile === MAIN_PROFILE) {
            await setProfile(tx, fork.id, DEFAULT_PROFILE, this.#composition!.profiles);
          }
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
        const requestId = webRequest(command.requestId);
        // A retry of an input already admitted is answered with that input, and admits nothing.
        const [admitted, archived] = await this.#harness.commit(
          async (tx) =>
            [
              await tx.submissionByRequest(conversation.id, requestId),
              await archivedRefusal(tx, conversation.id),
            ] as const,
          BACKGROUND_CONTEXT,
        );
        if (admitted !== undefined) {
          this.#send(socket, {
            type: "command.result",
            command: command.type,
            requestId: command.requestId,
            ok: true,
            conversationId: conversation.id,
            submissionId: admitted.id,
          });
          return;
        }
        // An archived conversation never runs (COD-198), and is read-only when opened (COD-201): restore it first.
        if (archived !== undefined) throw new Error(archived);
        // Paused (`MIPI_PAUSED`, M9): a new message is refused with a clear reason, nothing admitted. A retry of one
        // admitted before still gets its answer above.
        if (await isPausedNow(this.#harness)) {
          throw new Error(PAUSED_REPLY);
        }
        // Arm before admitting work: `onWake` runs after the commit, so an instance that dies in between is
        // still woken. An early alarm is harmless; a missing one strands the turn.
        await this.#alarm.schedule({ ...this.#harness.wake(), active: true });
        const submission = await conversation.submit(
          {
            type: "input",
            content: stampInput(
              ownerName(this.env.MIPI_OWNER),
              command.content,
              this.env.MIPI_TIMEZONE,
            ),
            requestId,
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
        await this.#nameConversation(conversation.id, command.content);
        return;
      }
      case "usage.read": {
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          usage: await this.#readUsage(),
        });
        return;
      }
      case "options.list": {
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          options: await this.#options(),
        });
        return;
      }
      case "conversation.configure": {
        const conversation = await this.#requireConversation(
          command.conversationId as ConversationId,
        );
        if (command.profile !== undefined && !isProfileName(command.profile)) {
          throw new Error(
            `${command.profile} is not a profile: pick one of ${PICKABLE_PROFILES.join(", ")}`,
          );
        }
        // Checked before the commit: a model outside the live list ∩ catalog is refused.
        const model =
          command.model === undefined ? undefined : await this.#modelList.require(command.model);
        const profile = command.profile;
        await this.#harness.commit(async (tx) => {
          // Read-only while archived (COD-201): nothing about it changes until it is restored.
          const archived = await archivedRefusal(tx, conversation.id);
          if (archived !== undefined) throw new Error(archived);
          if (model !== undefined) await configure(tx, conversation.id, { model });
          if (profile !== undefined && isProfileName(profile)) {
            await setProfile(tx, conversation.id, profile, this.#composition!.profiles);
          }
        }, BACKGROUND_CONTEXT);
        await this.#broadcastSessionSnapshot();
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          conversationId: conversation.id,
        });
        return;
      }
      case "diag.subscribe": {
        const state = connectionState(socket);
        if (state !== null) setConnectionState(socket, { ...state, diag: true });
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
          diag: await this.#diagSnapshot({
            ...(command.after === undefined ? {} : { after: command.after }),
            limit: command.limit ?? DEFAULT_DIAG_TAIL,
          }),
        });
        return;
      }
      case "diag.unsubscribe": {
        const state = connectionState(socket);
        if (state?.diag === true) {
          const { diag: _, ...rest } = state;
          setConnectionState(socket, rest);
        }
        this.#send(socket, {
          type: "command.result",
          command: command.type,
          requestId: command.requestId,
          ok: true,
        });
        return;
      }
      default: {
        const _: never = command;
        throw new Error("Unknown client command");
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
        for (const record of page.items) {
          const latestEntryId = await tx.latestEntryId(record.id);
          // Subagents carry the owning conversation from the Pi record and have no bot meta.
          if (record.owner !== undefined) {
            conversations.push(conversationSummary(record, undefined, latestEntryId));
            continue;
          }
          const meta = await tx.doc(ConversationMeta, record.id);
          conversations.push(
            conversationSummary(record, { ...meta, profile: profileOf(meta) }, latestEntryId),
          );
        }
        cursor = page.next;
      } while (cursor !== undefined);
      return conversations;
    }, BACKGROUND_CONTEXT);
  }

  /** What the web pickers offer. A failed live model list leaves the model picker empty, with the reason. */
  async #options(): Promise<Options> {
    const table = this.#composition!.profiles;
    const profiles = PICKABLE_PROFILES.map((name) => ({ id: name, name: table.description(name) }));
    const defaultModel = this.env.MIPI_MODEL || DEFAULT_MODEL_ID;
    try {
      return { models: await this.#modelList.models(), profiles, defaultModel };
    } catch (error) {
      reportError("Reading the model list failed", error);
      return {
        models: [],
        profiles,
        defaultModel,
        modelsError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Titles a conversation from its first message, then, for a long one, asks its model for a better title. The model
   * call runs after the reply to the client and never fails the submit.
   */
  async #nameConversation(conversationId: ConversationId, text: string): Promise<void> {
    const provisional = await this.#harness.commit(
      (tx) => nameFromFirstMessage(tx, conversationId, text),
      BACKGROUND_CONTEXT,
    );
    await this.#broadcastSessionSnapshot();
    if (provisional === undefined) return;
    void writeTitle(this.#harness, this.#models, conversationId, text, provisional, (error) =>
      reportError("Writing a conversation title failed", error, { conversationId }),
    ).then(async (changed) => {
      if (changed && this.#state.kind === "open") await this.#broadcastSessionSnapshot();
    });
  }

  async #watchConversation(
    socket: WebSocket,
    conversationId: ConversationId,
    restoreTyping = false,
  ): Promise<void> {
    this.#setTyping(socket, false);
    await this.#stopView(socket);
    const previous = connectionState(socket);
    const username = previous?.username ?? "Guest";
    const diag = previous?.diag === true ? { diag: true as const } : {};
    setConnectionState(socket, { username, ...diag });
    const conversation = await this.#requireConversation(conversationId);
    // Opened while archived: read-only, and it stays here through archive changes until it is restored (COD-201).
    const readOnly = archivedIn(
      (await this.#harness.snapshot(Bots, BACKGROUND_CONTEXT)) ?? {},
      conversationId,
    );
    // A window over the transcript and the conversation's built-in documents: the run, the streamed answer, tool
    // progress, the queue, the agent, and usage. The client pages older entries with `conversation.entries`.
    const view = await conversation.watch(BACKGROUND_CONTEXT);
    this.#views.set(socket, view);
    setConnectionState(socket, {
      username,
      conversationId,
      ...(restoreTyping ? { typing: true } : {}),
      ...(readOnly ? { readOnly: true } : {}),
      ...diag,
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

  /** Drops the read-only mark of every socket watching one of `restored`. */
  #clearReadOnly(restored: readonly ConversationId[]): void {
    const live = new Set<number>(restored);
    for (const socket of this.#connections()) {
      const state = connectionState(socket);
      if (state?.readOnly !== true || state.conversationId === undefined) continue;
      if (!live.has(state.conversationId)) continue;
      const { readOnly: _, ...rest } = state;
      setConnectionState(socket, rest);
    }
  }

  /**
   * An untitled chat from before bots' first line, to name it when it is restored (COD-201): its first message's
   * text, after the stamp. Undefined for anything else, and for a chat with a title or no message.
   */
  async #earlierChatFirstLine(conversation: Conversation): Promise<string | undefined> {
    const meta = await this.#harness.snapshot(
      ConversationMeta,
      conversation.id,
      BACKGROUND_CONTEXT,
    );
    if (meta === undefined || meta.kind !== undefined || meta.title !== undefined) return undefined;
    const page = await conversation.entries(
      { order: "ascending" },
      20,
      undefined,
      BACKGROUND_CONTEXT,
    );
    for (const entry of page.items) {
      const message = entry.model?.[0];
      if (message?.role !== "user") continue;
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
      return firstLineOf(text);
    }
    return undefined;
  }

  /** Moves every socket watching an archived conversation to where the web door is bound now (MiPi). */
  async #leaveArchived(
    archived: readonly ConversationId[],
    harness = this.#harness,
  ): Promise<void> {
    const gone = new Set<number>(archived);
    const watching = this.#connections().filter((socket) => {
      const state = connectionState(socket);
      // A read-only view was opened on an archived conversation on purpose: it stays.
      return (
        state?.conversationId !== undefined &&
        state.readOnly !== true &&
        gone.has(state.conversationId)
      );
    });
    if (watching.length === 0) return;
    const bound = await harness.commit(
      (tx) =>
        boundConversation(
          tx,
          "web",
          startingProfile("web", profileOrDefault(this.env.MIPI_PROFILE)),
          this.#composition!.profiles,
        ),
      BACKGROUND_CONTEXT,
    );
    for (const socket of watching) {
      if (this.#harness !== harness || this.#state.kind !== "open") return;
      const state = connectionState(socket);
      if (
        state?.conversationId !== undefined &&
        state.readOnly !== true &&
        gone.has(state.conversationId)
      ) {
        await this.#watchConversation(socket, bound);
      }
    }
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

  /** One new diagnostic event to the sockets that subscribed. */
  #broadcastDiag(event: DiagEvent): void {
    const subscribed = this.#connections().filter(
      (socket) => connectionState(socket)?.diag === true,
    );
    if (subscribed.length === 0) return;
    const message = JSON.stringify({ type: "diag.event", event } satisfies ServerEvent);
    for (const socket of subscribed) this.#sendMessage(socket, message);
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
        ...(state.readOnly === true ? { readOnly: true } : {}),
        ...(state.diag === true ? { diag: true } : {}),
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
}
