/**
 * Approvals (COD-173, COD-237): tool calls that wait for the owner's yes. A gate, so it lives in core: core owns the
 * signal the answer arrives on, the `beforeTool` gate, the list of pending approvals and the resolve API. Core code: it
 * names no door and no extension, and no tool.
 *
 * A tool asks in one of two ways (`ApprovalPolicy`, on its registration):
 *
 * - **`gate`**: core's `beforeTool` hook parks the call before it runs (Pi Durable's gate pattern, README "Gates before
 *   a tool runs"). Hooks get a read-only `HookApi`, so the gate only reads and returns: it writes nothing.
 * - **`self`**: the tool decides in `execute()`, from its own transaction, and parks through `awaitApproval`.
 *
 * Either way the call sleeps on `ApprovalSignal` under its task id, with the deadline as the sleep's `until`, so it
 * holds no process and a hibernated object wakes (`onWake`, the alarm) to time it out. A timeout counts as a deny.
 *
 * The pending list is not stored: it is read off Pi Durable's task graph (`approvalsIn`), as the sleeping tool tasks
 * waiting on an approval key. A call that ends any other way (abort, archive, fault, restart limit) leaves the graph,
 * and with it the list, so there is nothing to clean up. The one thing stored is which requests the owner was already
 * told about (`ApprovalNotices`), so a restart doesn't tell them twice.
 */
import {
  defineDoc,
  defineExtension,
  defineSignal,
  type CallArguments,
  type ConversationId,
  type Extension,
  type Harness,
  hook,
  type TaskGraph,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type ToolPark,
  type ToolRegistration,
  ToolTask,
  type ToolTaskInput,
  type Tx,
  type WakeReason,
} from "./pi/durable.ts";
import type { Context } from "./pi/context.ts";
import { int, obj, oneOf, opt, str } from "./pi/schema.ts";
import type { Delivery } from "./delivery.ts";
import { type ApprovalSummary, MAX_APPROVAL_ARGUMENTS_CHARACTERS } from "../protocol.ts";
import type { DiagSink } from "./diag.ts";
import type { Origins } from "./origin.ts";

/** The name of core's approvals extension: the gate. */
export const APPROVALS_EXTENSION_NAME = "approvals";

/** How long the owner has to answer, unless the tool says otherwise. */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** The most characters of the owner's note kept with a decision. */
export const MAX_APPROVAL_NOTE = 500;

export const APPROVAL_DECISIONS = ["approve", "deny"] as const;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISIONS)[number];

/** The owner's answer to one request: delivered to the waiting call's task under the approval's id. */
export const ApprovalSignal = defineSignal({
  name: "app.approval",
  version: 1,
  schema: obj({
    decision: oneOf(APPROVAL_DECISIONS),
    note: opt(str({ maxLength: MAX_APPROVAL_NOTE })),
    decidedBy: str({ minLength: 1 }),
    decidedAt: int(),
  }),
});

/** The signal name as the task graph shows it on a sleeping task. */
const APPROVAL_SIGNAL_NAME = ApprovalSignal.key("name").signal;

/** The one approval a call can wait on: one `pi.tool` task runs one call, and its id survives restarts. */
const approvalId = (taskId: TaskId): string => String(taskId);

/** What the model is told when the owner says no. */
export function deniedText(note: string | undefined): string {
  const said = note?.trim();
  return said ? `Denied by the owner. Their note: ${said}` : "Denied by the owner.";
}

export const EXPIRED_TEXT = "Approval timed out without an answer; the action was not run.";

/**
 * Core's gate (`gate` policies): parks a call until the owner answers, then lets it run or blocks it. It runs again on
 * every wake, every registry change and every reopen, so it only reads: the deadline is memoized, and a second pass
 * that finds no answer sleeps again on the same key. `tools` is the composition's tool table (read lazily: the gate is
 * made before the table is resolved).
 */
export function approvalsExtension(tools: () => ReadonlyMap<string, ToolRegistration>): Extension {
  return defineExtension({
    name: APPROVALS_EXTENSION_NAME,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const policy = tools().get(call.name)?.approval;
          if (policy?.kind !== "gate") return undefined;
          if (policy.when !== undefined && !policy.when(call.arguments)) return undefined;
          const key = approvalId(api.taskId);
          const state = await api.readSignal(ApprovalSignal, key, context);
          if (state === undefined) {
            // One deadline per call: a pass after a reopen keeps the first.
            const until = await api.memo(
              "approval.until",
              api.now() + (policy.ttlMs ?? DEFAULT_APPROVAL_TTL_MS),
              context,
            );
            return { sleep: { signals: [ApprovalSignal.key(key)], until } };
          }
          switch (state.kind) {
            case "expired":
              return { block: EXPIRED_TEXT };
            case "value":
              return state.value.decision === "approve"
                ? undefined
                : { block: deniedText(state.value.note) };
            default: {
              const _: never = state;
              return { block: EXPIRED_TEXT };
            }
          }
        },
      }),
    ],
  });
}

/** Where a `self` tool is after `awaitApproval`: go ahead, stop with this result, or park (return `park`). */
export type ApprovalStep =
  | { readonly kind: "approved"; readonly note?: string }
  | { readonly kind: "refused"; readonly result: ToolExecutionResult }
  | { readonly kind: "park"; readonly park: ToolPark };

const refused = (text: string): ApprovalStep => ({
  kind: "refused",
  result: { isError: true, output: [{ type: "text", text }] },
});

/**
 * For a `self` tool: on a fresh call, the park that asks the owner (return it from `execute()`); after the wake, the
 * owner's answer. Call it on every run after a park (`api.wake !== undefined`), and on a fresh call once the tool knows
 * it must ask. A wake for any reason but the answer or the deadline is refused: it can't be an approval.
 */
export async function awaitApproval(
  api: Pick<ToolExecutionApi, "taskId" | "wake" | "now" | "readSignal">,
  context: Context,
  ttlMs: number = DEFAULT_APPROVAL_TTL_MS,
): Promise<ApprovalStep> {
  const key = approvalId(api.taskId);
  const wake: WakeReason | undefined = api.wake;
  if (wake === undefined) {
    return {
      kind: "park",
      park: { kind: "sleep", signals: [ApprovalSignal.key(key)], until: api.now() + ttlMs },
    };
  }
  switch (wake.reason) {
    case "signal": {
      const state = await api.readSignal(ApprovalSignal, key, context);
      if (state?.kind !== "value") return refused(EXPIRED_TEXT);
      if (state.value.decision === "deny") return refused(deniedText(state.value.note));
      return state.value.note === undefined
        ? { kind: "approved" }
        : { kind: "approved", note: state.value.note };
    }
    case "expired":
      return refused(EXPIRED_TEXT);
    // A sleep with signals never wakes for time alone, and an approval waits on no tasks: fail closed.
    case "time":
    case "tasks":
      return refused(EXPIRED_TEXT);
    default: {
      const _: never = wake;
      return refused(EXPIRED_TEXT);
    }
  }
}

/** One pending approval as the task graph shows it. */
export interface ApprovalRef {
  readonly id: string;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly background: boolean;
  /** The deadline; absent only for a sleep without one, which MiPi never parks. */
  readonly expiresAt?: number;
}

/** The pending approvals: the live tool tasks sleeping on an approval key, oldest task first. */
export function approvalsIn(graph: TaskGraph): ApprovalRef[] {
  const refs: ApprovalRef[] = [];
  for (const node of Object.values(graph.tasks)) {
    if (node.kind !== ToolTask.definition.name || node.state.status !== "sleeping") continue;
    if (node.abortRequested) continue;
    const id = approvalId(node.id);
    const waits = (node.state.signals ?? []).some(
      ({ signal, key }) => signal === APPROVAL_SIGNAL_NAME && key === id,
    );
    if (!waits) continue;
    refs.push({
      id,
      taskId: node.id,
      conversationId: node.conversationId,
      background: node.background,
      ...(node.state.until === undefined ? {} : { expiresAt: node.state.until }),
    });
  }
  return refs.sort((a, b) => Number(a.taskId) - Number(b.taskId));
}

/** One pending approval with what the owner is asked. */
export interface PendingApproval extends ApprovalRef {
  readonly tool: string;
  readonly arguments: CallArguments;
  readonly summary: string;
  readonly reason: string;
}

/** The call a tool task runs: from its assistant entry (a model's call) or its input (a nested call). */
async function callOf(
  harness: Harness,
  taskId: TaskId,
  context: Context,
): Promise<{ readonly name: string; readonly arguments: CallArguments } | undefined> {
  const record = await harness.getTask(taskId, context);
  // `getTask` keeps ended tasks: only one still waiting is asking.
  if (record === undefined || record.state.status !== "sleeping") return undefined;
  // pi-ledger L14: a tool task's input is Pi Durable's `ToolTaskInput`; the graph names the task but not its call.
  const input = record.input as ToolTaskInput;
  switch (input.kind) {
    case "nested":
      return { name: input.call.name, arguments: input.call.arguments };
    case "model": {
      const entry = await harness.commit((tx) => tx.entry(input.assistant), context);
      for (const message of entry?.model ?? []) {
        if (message.role !== "assistant") continue;
        for (const part of message.content) {
          if (part.type === "toolCall" && part.id === input.callId) {
            return { name: part.name, arguments: part.arguments };
          }
        }
      }
      return undefined;
    }
    default: {
      const _: never = input;
      return undefined;
    }
  }
}

/**
 * What the owner is asked about `ref`, worded by its tool's policy; undefined when the task no longer waits. The
 * arguments are the call as the model (or the calling tool) made it: no MiPi `beforeTool` hook rewrites arguments, so
 * they are also what the gate approves (pi-ledger L14).
 */
export async function describeApproval(
  harness: Harness,
  ref: ApprovalRef,
  tools: ReadonlyMap<string, ToolRegistration>,
  context: Context,
): Promise<PendingApproval | undefined> {
  const call = await callOf(harness, ref.taskId, context);
  if (call === undefined) return undefined;
  const ask = tools.get(call.name)?.approval?.describe(call.arguments) ?? {
    summary: `Run ${call.name}`,
    reason: "This tool needs your approval.",
  };
  return { ...ref, tool: call.name, arguments: call.arguments, ...ask };
}

export type ApprovalAnswer = {
  readonly decision: ApprovalDecisionKind;
  readonly note?: string;
  /** Who decided: the door and person, such as `web:owner`. */
  readonly decidedBy: string;
};

/** What happened to an answer: delivered, or why not. */
export type ResolveResult =
  | { readonly kind: "resolved" }
  | { readonly kind: "not_found" }
  | { readonly kind: "already_decided" };

/**
 * Delivers the owner's answer to approval `id`, if `graph` (the current task graph) shows it pending: an id that names
 * no waiting approval is refused here, so an answer never lands early in a task that may ask later. Enables
 * scheduling, so the host arms its recovery wakeup first, as before `submit()`.
 */
export async function resolveApproval(
  harness: Harness,
  graph: TaskGraph,
  id: string,
  answer: ApprovalAnswer,
  now: number,
  context: Context,
): Promise<ResolveResult> {
  const ref = approvalsIn(graph).find((pending) => pending.id === id);
  if (ref === undefined) return { kind: "not_found" };
  const note = answer.note?.trim().slice(0, MAX_APPROVAL_NOTE);
  const result = await harness.signal(
    ref.taskId,
    ApprovalSignal,
    id,
    {
      decision: answer.decision,
      ...(note ? { note } : {}),
      decidedBy: answer.decidedBy,
      decidedAt: Math.floor(now),
    },
    context,
  );
  switch (result) {
    case "delivered":
      return { kind: "resolved" };
    // Answered already, or the call ended (timed out, aborted) since the graph was read.
    case "duplicate":
    case "closed":
      return { kind: "already_decided" };
    case "not_found":
      return { kind: "not_found" };
    case "invalid":
      throw new Error("The approval answer did not match its schema");
    default: {
      const _: never = result;
      throw new Error("Unknown signal result");
    }
  }
}

/** How a pending approval left the list. */
export type ApprovalEnd = "resolved" | "expired" | "canceled";

export type ApprovalChange =
  | { readonly kind: "requested"; readonly ref: ApprovalRef }
  | { readonly kind: "ended"; readonly ref: ApprovalRef; readonly how: ApprovalEnd };

/**
 * Follows the pending list across task-graph updates, for diagnostics and owner notices. In memory only: the Durable
 * Object seeds it from the graph when it opens (`seed`), so a restart neither loses nor re-announces a request.
 *
 * A request that stops sleeping while its task is still live is kept, unless it was answered: a gate checks again on
 * every wake and reopen (`pending`, `running`, then asleep once more), and that is not the request ending. It ends
 * when its task leaves the graph (or, once answered, when it stops sleeping), and is told apart by whether this
 * object answered it and by its deadline.
 */
export class ApprovalTracker {
  readonly #pending = new Map<string, ApprovalRef>();
  readonly #answered = new Set<string>();

  /** The approvals waiting for an answer as of the last update. */
  get pending(): readonly ApprovalRef[] {
    return [...this.#pending.values()].filter(({ id }) => !this.#answered.has(id));
  }

  /** Marks `id` answered, so it is no longer pending and its leaving reads as `resolved`. */
  answered(id: string): void {
    if (this.#pending.has(id)) this.#answered.add(id);
  }

  /** Takes `graph` as the starting point: what it shows pending is pending, with no change to report. */
  seed(graph: TaskGraph): void {
    this.#pending.clear();
    this.#answered.clear();
    for (const ref of approvalsIn(graph)) this.#pending.set(ref.id, ref);
  }

  update(graph: TaskGraph, now: number): ApprovalChange[] {
    const current = new Map(approvalsIn(graph).map((ref) => [ref.id, ref]));
    const next = new Map(current);
    const changes: ApprovalChange[] = [];
    for (const [id, ref] of this.#pending) {
      if (current.has(id)) continue;
      const answered = this.#answered.has(id);
      // Still live and not answered: a gate checking again, or an abort under way. Not ended yet.
      if (!answered && graph.tasks[String(ref.taskId)] !== undefined) {
        next.set(id, ref);
        continue;
      }
      const how: ApprovalEnd = answered
        ? "resolved"
        : ref.expiresAt !== undefined && ref.expiresAt <= now
          ? "expired"
          : "canceled";
      this.#answered.delete(id);
      changes.push({ kind: "ended", ref, how });
    }
    for (const [id, ref] of current) {
      if (!this.#pending.has(id)) changes.push({ kind: "requested", ref });
    }
    this.#pending.clear();
    for (const [id, ref] of next) this.#pending.set(id, ref);
    return changes;
  }
}

/** The diagnostic event for one change. */
export function emitApprovalChange(diag: DiagSink, change: ApprovalChange, now: number): void {
  const { ref } = change;
  const base = {
    source: "gate",
    convId: ref.conversationId,
    taskId: String(ref.taskId),
    ts: now,
  } as const;
  if (change.kind === "requested") {
    diag.emit({
      ...base,
      level: "info",
      kind: "approval.requested",
      outcome: "held",
      summary: "A tool call waits for the owner's approval",
      ...(ref.expiresAt === undefined ? {} : { detail: { expiresAt: ref.expiresAt } }),
    });
    return;
  }
  switch (change.how) {
    case "resolved":
      diag.emit({
        ...base,
        level: "info",
        kind: "approval.resolved",
        outcome: "ok",
        summary: "The owner answered an approval",
      });
      return;
    case "expired":
      diag.emit({
        ...base,
        level: "info",
        kind: "approval.expired",
        outcome: "refused",
        summary: "An approval timed out; the call was not run",
      });
      return;
    case "canceled":
      diag.emit({
        ...base,
        level: "info",
        kind: "approval.canceled",
        outcome: "quiet",
        summary: "A call waiting for approval ended without an answer",
      });
      return;
    default: {
      const _: never = change.how;
    }
  }
}

/** The approvals the owner was told about, so a restart doesn't tell them again. Kept to the pending ones. */
export const ApprovalNotices = defineDoc<{ notified: string[] }>({
  kind: "app.approval-notices",
  version: 1,
  scope: "session",
  initial: () => ({ notified: [] }),
  checkpointWhen: () => false,
});

export const noticeText = (approval: Pick<PendingApproval, "summary">): string =>
  `Approval needed: ${approval.summary}. Open MiPi on the web to approve or deny.`;

/**
 * Tells the owner about each of `approvals` not told yet, where they can be reached (`Delivery.tellOwner`), and forgets
 * the ones no longer in `pending`. Returns the ids told now; one with nowhere to go is not marked told.
 */
export async function noticeApprovals(
  harness: Harness,
  delivery: Pick<Delivery, "tellOwner">,
  approvals: readonly PendingApproval[],
  pending: readonly ApprovalRef[],
  now: number,
  context: Context,
  shouldTell: (tx: Tx, approval: PendingApproval) => boolean | Promise<boolean>,
): Promise<string[]> {
  return harness.commit(async (tx) => {
    const state = await tx.doc(ApprovalNotices);
    const live = new Set(pending.map(({ id }) => id));
    const kept = state.notified.filter((id) => live.has(id));
    if (kept.length !== state.notified.length) state.notified = kept;
    const told: string[] = [];
    for (const approval of approvals) {
      if (!live.has(approval.id) || state.notified.includes(approval.id)) continue;
      if (!(await shouldTell(tx, approval))) continue;
      // Nobody to tell yet (no door knows where the owner is): left untold, as the cap notice is.
      const notice = { id: `approval:${approval.id}`, text: noticeText(approval) };
      if (!(await delivery.tellOwner(tx, notice, now))) continue;
      state.notified.push(approval.id);
      told.push(approval.id);
    }
    return told;
  }, context);
}

export interface ApprovalWatchOptions {
  readonly harness: Harness;
  readonly delivery: Pick<Delivery, "tellOwner">;
  /** The composition's tool table, for wording a request. */
  readonly tools: ReadonlyMap<string, ToolRegistration>;
  readonly diag: DiagSink;
  /** Whether a web socket is open. Background calls notify the owner even when one is open. */
  readonly watched: () => boolean;
  readonly origins?: Pick<Origins, "runAutomatedOnly">;
  readonly now: () => number;
  readonly report: (error: unknown) => void;
  /** The pending approvals as the owner is shown them, each time that list changes. */
  readonly onList?: (approvals: readonly PendingApproval[]) => void;
}

/** One pending approval for the web: what it asks, with its arguments as bounded JSON text. */
export function approvalSummary(approval: PendingApproval): ApprovalSummary {
  const json = JSON.stringify(approval.arguments, null, 2) ?? "{}";
  return {
    id: approval.id,
    conversationId: approval.conversationId,
    tool: approval.tool,
    summary: approval.summary,
    reason: approval.reason,
    arguments:
      json.length <= MAX_APPROVAL_ARGUMENTS_CHARACTERS
        ? json
        : `${json.slice(0, MAX_APPROVAL_ARGUMENTS_CHARACTERS - 1)}…`,
    ...(approval.expiresAt === undefined ? {} : { expiresAt: approval.expiresAt }),
  };
}

/**
 * What the Durable Object runs on its task-graph watch: the diagnostics of the pending list's changes, and a notice to
 * the owner for each request not told yet while nobody watches. `seed` takes the graph as the watch opens (a watch
 * only delivers later frames); `observe` each frame after. Notices run one after another, off the watch callback, and
 * read the pending list again when their turn comes, so a request answered or ended meanwhile isn't announced.
 */
export class ApprovalWatch {
  readonly #options: ApprovalWatchOptions;
  readonly #tracker = new ApprovalTracker();
  /** The pending approvals described, by id, in the order they were asked. */
  readonly #described = new Map<string, PendingApproval>();
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ApprovalWatchOptions) {
    this.#options = options;
  }

  get pending(): readonly ApprovalRef[] {
    return this.#tracker.pending;
  }

  /** The pending approvals with what each asks, as last described. */
  get list(): readonly PendingApproval[] {
    return [...this.#described.values()];
  }

  /** Marks `id` answered: it leaves the pending list and the owner's list at once. */
  answered(id: string): void {
    this.#tracker.answered(id);
    if (this.#described.delete(id)) this.#options.onList?.(this.list);
  }

  /**
   * Takes the graph as the watch opens: what it shows pending is pending, with no diagnostic, and the owner is told
   * about any request a crash kept from being told. The promise settles when that is done. Never rejects.
   */
  seed(graph: TaskGraph, context: Context): Promise<void> {
    this.#tracker.seed(graph);
    return this.#notice(this.#tracker.pending, context);
  }

  /** Takes one graph update; the promise settles when its notices are sent (for `waitUntil`). Never rejects. */
  observe(graph: TaskGraph, context: Context): Promise<void> {
    const { diag, now } = this.#options;
    const at = now();
    const changes = this.#tracker.update(graph, at);
    if (changes.length === 0) return this.#queue;
    for (const change of changes) emitApprovalChange(diag, change, at);
    return this.#notice(
      changes.flatMap((change) => (change.kind === "requested" ? [change.ref] : [])),
      context,
    );
  }

  /** Settles when every queued notice has: awaited before the harness closes. */
  settled(): Promise<void> {
    return this.#queue;
  }

  #notice(requested: readonly ApprovalRef[], context: Context): Promise<void> {
    const { harness, delivery, tools, watched, origins, now, report, onList } = this.#options;
    const tell = !watched();
    this.#queue = this.#queue
      .then(async () => {
        // As of now, not as of the frame: a request answered or ended since isn't described or announced.
        const pending = this.#tracker.pending;
        const live = new Set(pending.map(({ id }) => id));
        let changed = false;
        for (const id of this.#described.keys()) {
          if (!live.has(id)) changed = this.#described.delete(id) || changed;
        }
        const asked: PendingApproval[] = [];
        for (const ref of requested) {
          if (!live.has(ref.id) || this.#described.has(ref.id)) continue;
          const approval = await describeApproval(harness, ref, tools, context);
          if (approval === undefined || !this.#tracker.pending.some(({ id }) => id === ref.id)) {
            continue;
          }
          this.#described.set(ref.id, approval);
          asked.push(approval);
          changed = true;
        }
        if (changed) onList?.(this.list);
        await noticeApprovals(
          harness,
          delivery,
          asked,
          this.#tracker.pending,
          now(),
          context,
          (tx, approval) =>
            tell ||
            approval.background ||
            (origins?.runAutomatedOnly(tx, approval.conversationId) ?? false),
        );
      })
      .catch(report);
    return this.#queue;
  }
}
