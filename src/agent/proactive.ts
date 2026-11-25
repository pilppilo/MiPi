/**
 * Proactive runs (M6): runs started by a reminder rather than by the owner. They may stay quiet when there is
 * nothing to say (`NO_SEND`), but never hide a failure, never swallow a message the owner sent in the same turn, and
 * run on a daily budget.
 *
 * - **Provenance.** Pi Durable records which inputs a run answers only while it runs (`pi.live.run.inputs`). When a
 *   run that includes a reminder answers, an `onYield` hook asks for `RecordRun`, which stores those inputs and their
 *   request ids under the answer. A run is reminder-only exactly when every one is automated (`origin.ts`).
 * - **Rounds.** After each tool round of a reminder-only run, an `afterTools` hook asks for `RoundBudget`. It records
 *   the round's failed tools for the run's inputs, counts the round against the daily cap, and ends the run with
 *   `terminate` at the cap (`daily-cap`) or at `RUN_ROUND_LIMIT` rounds (`run-limit`).
 * - **Replies (the answer policy).** One `reconcileAnswers()` turns every settled input a door expects an answer for
 *   ("direct", from the doors' pending sources) and every settled reminder ("proactive", `pending` here) into
 *   messages, grouped by the answer they share, so each answer is judged once. Inputs queued behind a run join it
 *   (`followUpMode: "all"`), so one run can answer both kinds; one settlement covers both. Messages go out through
 *   delivery, in the same commit (`delivery.ts`).
 *
 * The document keeps its kind and every stored field name from 0.1.0-beta.1, so rolling back reads it unchanged. Code
 * treats `reminderId` as an opaque source id and `destination` as an opaque delivery destination.
 */
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  defineDoc,
  defineExtension,
  defineTask,
  type EntryRecord,
  GenerationTask,
  hook,
  type HookApi,
  hookTask,
  LiveDoc,
  type SubmissionId,
  type Tx,
} from "./pi/durable.ts";
import type { Connectors, PendingInput } from "./connectors.ts";
import type { Delivery, DeliveryDestination, DeliveryMessage } from "./delivery.ts";
import { isNoSend, visibleAnswer } from "../lib/proactive-text.ts";
import { chicagoDay } from "../lib/cap-day.ts";
import { holdOf, measureSpend, noticeSpend, Spend } from "./spend.ts";
import {
  ProviderLimits,
  providerHeldUntil,
  settledLimit,
  tellProviderLimit,
  TRANSIENT_REMINDER_COOLDOWN_MS,
} from "./limits.ts";
import type { Providers } from "./providers.ts";

export { afterNextChicagoMidnight, CAP_ZONE, chicagoDay } from "../lib/cap-day.ts";

const context = BACKGROUND_CONTEXT;

/** Model rounds proactive runs may take per Chicago day, unless `MIPI_DAILY_RUN_CAP` says otherwise. */
export const DEFAULT_DAILY_RUN_CAP = 50;
/** Tool rounds one proactive run may take. */
export const RUN_ROUND_LIMIT = 8;
/** Confirmed proactive messages kept, and shown to the next reminder so it doesn't repeat itself. */
export const RECENT_SENDS_KEPT = 10;
/** Runs, stops and tool errors kept for reconciliation; far more than are ever waiting at once. */
const RECORDS_KEPT = 100;

export const CAP_NOTICE = "Daily limit for scheduled runs reached; they resume tomorrow.";
export const MIXED_FALLBACK = "I didn't produce an answer for your message; send it again.";

/** Why `RoundBudget` ended a run. An older build reads `spend-cap` and `paused` as `run-limit`. */
export type StopReason = "daily-cap" | "run-limit" | "spend-cap" | "paused" | "provider-limit";

export type ProactiveRun = {
  readonly at: number;
  readonly outcome: "sent" | "quiet" | "failed" | "stopped";
};

export type ProactiveState = {
  lastRun?: ProactiveRun;
  /** Proactive inputs (reminder occurrences) admitted and not settled yet. `reminderId` is the opaque source id. */
  pending: Array<{
    submissionId: number;
    reminderId: string;
    instruction: string;
    conversationId: number;
    destination: DeliveryDestination;
    repeating?: true;
  }>;
  /** Recently settled transient failures, used to keep a recurring schedule from readmitting immediately. */
  transientFailures?: Array<{ submissionId: number; reminderId: string; until: number }>;
  /** The inputs of each run that answered with a reminder among them, by answer entry. */
  runs: Array<{ answer: number; inputs: Array<{ submissionId: number; requestId?: string }> }>;
  /** Inputs whose run `RoundBudget` ended, and why. */
  stopped: Array<{ submissionId: number; reason: StopReason }>;
  /** Failed tools of reminder-only runs, by input. */
  toolErrors: Array<{ submissionId: number; tool: string; reason: string }>;
  /** The last confirmed proactive messages, oldest first. `chatId` is the door's numeric address (`onDelivered`). */
  recentSends: Array<{ sentAt: number; chatId: number; reminderId: string; snippet: string }>;
  /** Model rounds proactive runs took on `day`, and whether that day's notice was sent. */
  cap?: { day: string; count: number; noticeSent: boolean };
  /** The cap in force, written by the agent at start from `MIPI_DAILY_RUN_CAP`. */
  limit?: number;
};

export const Proactive = defineDoc<ProactiveState>({
  kind: "app.proactive",
  version: 1,
  scope: "session",
  initial: () => ({ pending: [], runs: [], stopped: [], toolErrors: [], recentSends: [] }),
  checkpointWhen: (value) => value.pending.length === 0,
});

export const PROACTIVE_DOC_KIND = "app.proactive";

// ---- The daily cap ----

/** `MIPI_DAILY_RUN_CAP`: a whole number, 0 or more (0 pauses proactive runs). Anything else is the default. */
export function parseDailyRunCap(value: string | undefined): { cap: number; invalid?: string } {
  if (value === undefined || value.trim() === "") return { cap: DEFAULT_DAILY_RUN_CAP };
  const cap = Number(value.trim());
  return Number.isInteger(cap) && cap >= 0
    ? { cap }
    : { cap: DEFAULT_DAILY_RUN_CAP, invalid: value };
}

/** Today's count, started afresh on a new day. */
function today(state: ProactiveState, now: number): NonNullable<ProactiveState["cap"]> {
  const day = chicagoDay(now);
  if (state.cap?.day !== day) state.cap = { day, count: 0, noticeSent: false };
  return state.cap;
}

/** Whether today's budget has room for one more model round; changes nothing. */
export function hasRound(state: ProactiveState, now: number): boolean {
  const count = state.cap?.day === chicagoDay(now) ? state.cap.count : 0;
  return count < (state.limit ?? DEFAULT_DAILY_RUN_CAP);
}

/** Counts one model round if today's budget has room; false at the cap, counting nothing. */
export function takeRound(state: ProactiveState, now: number): boolean {
  const cap = today(state, now);
  if (cap.count >= (state.limit ?? DEFAULT_DAILY_RUN_CAP)) return false;
  cap.count += 1;
  return true;
}

/**
 * Today's one cap notice: at `prefer` when the blocked run answers somewhere that can push, otherwise wherever delivery
 * says the owner is. With nobody to tell, nothing is sent and the day isn't marked noticed, so a later blocked run can
 * still tell. In the caller's commit.
 */
export async function noticeCap(
  tx: Tx,
  state: ProactiveState,
  delivery: Delivery,
  prefer: DeliveryDestination | undefined,
  now: number,
): Promise<void> {
  const cap = today(state, now);
  if (cap.noticeSent) return;
  if (await delivery.tellOwner(tx, { id: `cap:${cap.day}`, text: CAP_NOTICE }, now, prefer)) {
    cap.noticeSent = true;
  }
}

/** The transient retry deadline, if settlement already observed this occurrence. */
export async function transientReminderUntil(
  tx: Tx,
  submissionId: number,
): Promise<number | undefined> {
  return (await tx.doc(Proactive)).transientFailures?.find(
    (entry) => entry.submissionId === submissionId,
  )?.until;
}

/** The last confirmed proactive messages, oldest first, for the next reminder to see (copies). */
export async function recentProactiveSends(
  tx: Tx,
): Promise<Array<{ readonly sentAt: number; readonly snippet: string }>> {
  return (await tx.doc(Proactive)).recentSends.map(({ sentAt, snippet }) => ({ sentAt, snippet }));
}

/**
 * Admits a proactive expectation: the answer to `submissionId` is judged and delivered when it settles, and the run's
 * first model round is charged to today. Call it in the commit that submitted the input.
 */
export async function expectProactive(
  tx: Tx,
  expectation: {
    readonly submissionId: number;
    readonly sourceId: string;
    readonly instruction: string;
    readonly conversationId: number;
    readonly destination: DeliveryDestination;
    readonly repeating?: true;
  },
  now: number,
): Promise<void> {
  const state = await tx.doc(Proactive);
  takeRound(state, now);
  state.pending = [
    ...state.pending,
    {
      submissionId: expectation.submissionId,
      reminderId: expectation.sourceId,
      instruction: expectation.instruction,
      conversationId: expectation.conversationId,
      destination: { ...expectation.destination },
      ...(expectation.repeating ? { repeating: true } : {}),
    },
  ];
}

const bounded = <T>(items: T[]): T[] => items.slice(-RECORDS_KEPT);

// ---- Hooks ----

/** Records the inputs of the run that just answered, before the answer stands. */
export const RecordRun = defineTask<
  Record<string, never>,
  { phase: "record" },
  Record<string, never>
>({
  name: "app.proactive-record-run",
  version: 1,
  initial: () => ({ phase: "record" }),
  phases: {
    record: async (_task, runtime, taskContext) => {
      await runtime.commit(async (tx) => {
        const run = (await tx.doc(LiveDoc, runtime.conversationId)).run;
        const answer = run?.yield?.answer;
        if (run !== undefined && answer !== undefined) {
          const inputs: ProactiveState["runs"][number]["inputs"] = [];
          for (const id of run.inputs) {
            const record = await tx.submission(id);
            inputs.push({
              submissionId: id,
              ...(record?.requestId === undefined ? {} : { requestId: record.requestId }),
            });
          }
          const state = await tx.doc(Proactive);
          state.runs = bounded([
            ...state.runs.filter((entry) => entry.answer !== answer),
            { answer, inputs },
          ]);
        }
        // No decision: the answer stands.
        return { status: "terminal", outcome: { status: "completed", result: {} } };
      }, taskContext);
    },
  },
  abort: async (_task, runtime, taskContext) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      taskContext,
    );
  },
});

/** One tool round of a reminder-only run: its failed tools, and whether the run may take another. */
export const RoundBudget = defineTask<
  { readonly results: number[] },
  { phase: "count" },
  { terminate?: true }
>({
  name: "app.proactive-round-budget",
  version: 1,
  initial: () => ({ phase: "count" }),
  phases: {
    count: async (task, runtime, taskContext) => {
      const failed: Array<{ tool: string; reason: string }> = [];
      for (const id of task.input.results) {
        const message = (await runtime.entry(id as never, taskContext))?.model?.[0];
        if (message?.role !== "toolResult" || !message.isError) continue;
        const text = message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        failed.push({ tool: message.toolName, reason: text.slice(0, 160) || "failed" });
      }
      await runtime.commit(async (tx) => {
        const run = (await tx.doc(LiveDoc, runtime.conversationId)).run;
        const inputs = run?.inputs ?? [];
        const state = await tx.doc(Proactive);
        if (failed.length > 0) {
          state.toolErrors = bounded([
            ...state.toolErrors,
            ...inputs.flatMap((submissionId) =>
              failed.map((error) => ({ submissionId, ...error })),
            ),
          ]);
        }
        // pi-ledger L7. Rounds are counted here, after each tool round, because `beforeRequest` can't write. The spend
        // cap and a pause are checked here too, with today's spend measured first (M9).
        const now = runtime.now();
        const hold =
          holdOf(await measureSpend(tx, now), now) ??
          (providerHeldUntil(await tx.doc(ProviderLimits), now) === undefined
            ? undefined
            : "provider-limit");
        // The run's own limit first: a round it won't take is never charged to the day.
        const reason: StopReason | undefined =
          (run?.turns ?? 0) >= RUN_ROUND_LIMIT
            ? "run-limit"
            : hold !== undefined
              ? hold
              : !takeRound(state, now)
                ? "daily-cap"
                : undefined;
        if (reason === undefined) {
          return { status: "terminal", outcome: { status: "completed", result: {} } };
        }
        state.stopped = bounded([
          ...state.stopped,
          ...inputs.map((submissionId) => ({ submissionId, reason })),
        ]);
        return {
          status: "terminal",
          outcome: { status: "completed", result: { terminate: true } },
        };
      }, taskContext);
    },
  },
  abort: async (_task, runtime, taskContext) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      taskContext,
    );
  },
});

/** Whether the live run's inputs include (`some`) or are all (`every`) pending reminders. */
async function reminderRun(api: HookApi, which: "some" | "every"): Promise<boolean> {
  const inputs = (await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs ?? [];
  if (inputs.length === 0) return false;
  const pending = new Set(
    ((await api.snapshot(Proactive, context))?.pending ?? []).map(
      ({ submissionId }) => submissionId,
    ),
  );
  return inputs[which]((id) => pending.has(id));
}

export const proactiveExtension = defineExtension({
  name: "proactive",
  tasks: [RecordRun, RoundBudget],
  hooks: [
    hook(GenerationTask, {
      onYield: async (_answer, api) =>
        (await reminderRun(api, "some")) ? { tasks: [hookTask(RecordRun, {})] } : undefined,
      afterTools: async (_assistant, results, api) =>
        (await reminderRun(api, "every"))
          ? { tasks: [hookTask(RoundBudget, { results: results.map(Number) })] }
          : undefined,
    }),
  ],
});

// ---- Replies ----

/** The visible text of an answer entry: its text parts, without thinking. */
export function answerText(entry: EntryRecord | undefined): string {
  const message = entry?.model?.find((candidate) => candidate.role === "assistant");
  if (message === undefined || message.role !== "assistant") return "";
  return visibleAnswer(
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
  );
}

type Settled =
  | {
      readonly source: "direct";
      readonly input: PendingInput;
      readonly record: SettledRecord;
    }
  | {
      readonly source: "proactive";
      readonly input: ProactiveState["pending"][number];
      readonly record: SettledRecord;
    };

type SettledRecord =
  | { readonly status: "done"; readonly answer: number }
  | { readonly status: "unanswered"; readonly reason: string; readonly detail?: string };

async function settledRecord(tx: Tx, submissionId: number): Promise<SettledRecord | "open"> {
  const stored = await tx.submission(submissionId as SubmissionId);
  const record = stored?.type === "input" ? stored : undefined;
  if (record === undefined) return { status: "unanswered", reason: "its record is gone" };
  switch (record.status) {
    case "queued":
    case "placed":
      return "open";
    case "done":
      return { status: "done", answer: record.answer };
    case "unanswered":
      return {
        status: "unanswered",
        reason: record.reason,
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      };
    default: {
      const _: never = record;
      throw new Error("Unknown submission status");
    }
  }
}

const reminderLabel = (instruction: string): string =>
  instruction.length > 60 ? `${instruction.slice(0, 59)}…` : instruction;

/** Every input waiting for a delivered answer: the doors' and the reminders'. */
export async function pendingSubmissions(tx: Tx, connectors: Connectors): Promise<number[]> {
  const ids: number[] = [];
  for (const source of connectors.pending) {
    for (const { submissionId } of await source.readPending(tx)) ids.push(submissionId);
  }
  for (const { submissionId } of (await tx.doc(Proactive)).pending) ids.push(submissionId);
  return ids;
}

/**
 * Turns every settled input a door expects an answer for, and every settled reminder, into messages, in the commit
 * that clears them. Returns whether anything changed. Destinations that can't push (the web) get nothing: their
 * answer is in the transcript.
 *
 * - An answer to a door's input goes to its destination once, as an answer; `NO_SEND` or an empty one there means the
 *   model produced nothing for the owner, so the owner is told so.
 * - A reminder in a reminder-only run sends its answer to its destination, unless the answer is `NO_SEND` and no tool
 *   failed. A failed tool always sends a notice, with any real answer. A run whose inputs weren't recorded is never
 *   quiet.
 * - A reminder in a mixed run is answered like the message beside it, once per destination.
 * - A stopped run sends today's cap notice (`daily-cap`, `spend-cap`) or a notice for that reminder (`run-limit`).
 * - Inputs that ended without an answer get one notice per destination and conversation.
 */
export async function reconcileAnswers(
  tx: Tx,
  now: number,
  connectors: Connectors,
  providers?: Providers,
): Promise<boolean> {
  const { delivery, origins } = connectors;
  const sources: Array<{
    readonly source: Connectors["pending"][number];
    readonly inputs: readonly PendingInput[];
  }> = [];
  for (const source of connectors.pending) {
    sources.push({ source, inputs: await source.readPending(tx) });
  }
  const proactive = await tx.doc(Proactive);
  if (sources.every(({ inputs }) => inputs.length === 0) && proactive.pending.length === 0) {
    return false;
  }

  const settled: Settled[] = [];
  const settledDirect: Array<{ source: Connectors["pending"][number]; ids: Set<number> }> = [];
  for (const { source, inputs } of sources) {
    const ids = new Set<number>();
    for (const input of inputs) {
      const record = await settledRecord(tx, input.submissionId);
      if (record === "open") continue;
      ids.add(input.submissionId);
      settled.push({
        source: "direct",
        input: { ...input, destination: { ...input.destination } },
        record,
      });
    }
    if (ids.size > 0) settledDirect.push({ source, ids });
  }
  const keptPending: ProactiveState["pending"] = [];
  for (const input of proactive.pending) {
    const record = await settledRecord(tx, input.submissionId);
    if (record === "open") keptPending.push(input);
    else settled.push({ source: "proactive", input: JSON.parse(JSON.stringify(input)), record });
  }
  if (settled.length === 0) return false;

  const stopOf = new Map(
    proactive.stopped.map(({ submissionId, reason }) => [submissionId, reason]),
  );
  const errorsOf = (submissionId: number) =>
    proactive.toolErrors.filter((error) => error.submissionId === submissionId);
  // A batch settles at one time. Use admission order to break ties across answer and failure groups.
  let latestSubmission = -1;
  const recordOutcome = (submissionId: number, outcome: ProactiveRun["outcome"]) => {
    if (submissionId <= latestSubmission) return;
    latestSubmission = submissionId;
    proactive.lastRun = { at: now, outcome };
  };
  const send = (destination: DeliveryDestination, message: DeliveryMessage) =>
    delivery.send(tx, destination, message, now);
  /** A destination's part of a message id, kept as 0.1.0-beta.1 built it (Telegram: the chat id). */
  const keyOf = (destination: DeliveryDestination) => delivery.key(destination);
  const spend = await tx.doc(Spend);
  const pushable = (destination: DeliveryDestination) =>
    delivery.canPush(destination) ? destination : undefined;
  const stopNotice = async (input: ProactiveState["pending"][number], reason: StopReason) => {
    const prefer = pushable(input.destination);
    switch (reason) {
      case "daily-cap":
        await noticeCap(tx, proactive, delivery, prefer, now);
        return;
      case "spend-cap":
        await noticeSpend(tx, spend, delivery, prefer, now);
        return;
      case "provider-limit":
        await tellProviderLimit(tx, delivery, prefer, now);
        return;
      case "paused":
        // The owner paused MiPi: the run stops without a word.
        return;
      case "run-limit":
        if (prefer !== undefined) {
          await send(prefer, {
            id: `run-limit:${input.submissionId}`,
            text: `The reminder "${reminderLabel(input.instruction)}" stopped after ${RUN_ROUND_LIMIT} rounds.`,
          });
        }
        return;
      default: {
        const _: never = reason;
        throw new Error("Unknown stop reason");
      }
    }
  };

  // Answered: one judgement per answer, over every input it answered.
  const groups = new Map<number, Settled[]>();
  const unanswered: Array<Settled & { record: { status: "unanswered" } }> = [];
  for (const item of settled) {
    if (item.record.status === "done") {
      groups.set(item.record.answer, [...(groups.get(item.record.answer) ?? []), item]);
    } else {
      unanswered.push(item as Settled & { record: { status: "unanswered" } });
    }
  }
  for (const [answer, group] of groups) {
    const text = answerText(await tx.entry(answer as never));
    const quiet = isNoSend(text) || text.length === 0;
    const run = proactive.runs.find((entry) => entry.answer === answer);
    const reminderOnly =
      run !== undefined &&
      run.inputs.length > 0 &&
      run.inputs.every(({ requestId }) => origins.originOf(requestId).automated);
    const answered = new Set<string>();
    for (const item of group) {
      if (item.source !== "direct") continue;
      const destination = pushable(item.input.destination);
      if (destination === undefined) continue;
      const identity = delivery.identity(destination);
      if (answered.has(identity)) continue;
      answered.add(identity);
      // `NO_SEND` is never an answer to the owner; an empty answer in a mixed run isn't one either.
      const nothing = isNoSend(text) || (text.length === 0 && group.length > 1);
      await send(destination, {
        id: `answer:${answer}:${keyOf(destination)}`,
        text: nothing ? MIXED_FALLBACK : text,
      });
    }
    for (const item of group) {
      if (item.source !== "proactive") continue;
      const { input } = item;
      const stop = stopOf.get(input.submissionId);
      if (stop !== undefined) {
        recordOutcome(input.submissionId, "stopped");
        // Only reminder-only runs are stopped; the run ended on a tool call, with no answer of its own (and no
        // `onYield`, so no run record). The notice is the whole message.
        await stopNotice(input, stop);
        continue;
      }
      const errors = reminderOnly ? errorsOf(input.submissionId) : [];
      let outcome: ProactiveRun["outcome"] = "sent";
      if (errors.length > 0) outcome = "failed";
      else if (reminderOnly && isNoSend(text)) outcome = "quiet";
      recordOutcome(input.submissionId, outcome);
      const destination = pushable(input.destination);
      if (destination === undefined) continue;
      const identity = delivery.identity(destination);
      const id = `answer:${answer}:${keyOf(destination)}`;
      if (!reminderOnly) {
        // Mixed, or not recorded: answered like a message, once per destination, never quietly.
        if (answered.has(identity)) continue;
        answered.add(identity);
        await send(destination, { id, text: quiet ? MIXED_FALLBACK : text });
        continue;
      }
      if (errors.length > 0) {
        const tools = [...new Set(errors.map(({ tool }) => tool))].join(", ");
        const notice = `The reminder "${reminderLabel(input.instruction)}" hit a failed tool (${tools}): ${errors[0]!.reason}`;
        await send(destination, {
          id: `tool-error:${input.submissionId}`,
          text: quiet ? notice : `${notice}\n\n${text}`,
        });
        continue;
      }
      if (isNoSend(text)) continue;
      if (text.length === 0) {
        // Thinking only, or nothing: a reminder is never dropped without a word.
        await send(destination, {
          id: `empty:${input.submissionId}`,
          text: `The reminder "${reminderLabel(input.instruction)}" ran but produced no answer.`,
        });
        continue;
      }
      await send(destination, { id, text, proactive: { sourceId: input.reminderId } });
    }
  }

  // Unanswered: a stopped reminder's notice, or one failure notice per destination and conversation.
  const failures = new Map<
    string,
    {
      destination: DeliveryDestination;
      first: number;
      reason: string;
      notice?: string;
      reminder?: string;
    }
  >();
  for (const item of unanswered) {
    const stop = item.source === "proactive" ? stopOf.get(item.input.submissionId) : undefined;
    if (item.source === "proactive") {
      recordOutcome(item.input.submissionId, stop === undefined ? "failed" : "stopped");
    }
    if (item.source === "proactive" && stop !== undefined) {
      await stopNotice(item.input, stop);
      continue;
    }
    const destination = pushable(item.input.destination);
    const notice =
      item.record.reason === "model_error"
        ? await settledLimit(tx, providers, item.record.detail, now)
        : undefined;
    if (item.source === "proactive" && item.input.repeating) {
      if (notice?.limit.kind === "rate") {
        const { reminderId, submissionId } = item.input;
        proactive.transientFailures = bounded([
          ...(proactive.transientFailures ?? []).filter(
            (failure) => failure.reminderId !== reminderId,
          ),
          { reminderId, submissionId, until: now + TRANSIENT_REMINDER_COOLDOWN_MS },
        ]);
      }
      if (notice?.limit.kind === "usage") {
        const status = await tellProviderLimit(
          tx,
          delivery,
          destination,
          now,
          notice.limit.provider,
        );
        if (status === "active") continue;
      }
    }
    if (destination === undefined) continue;
    if (item.source === "proactive" && !item.input.repeating && notice?.limit.kind === "usage") {
      await send(destination, {
        id: `reminder-limit:${item.input.submissionId}`,
        text: `Reminder: ${item.input.instruction} (sent without MiPi: ${notice.text.replace(/\.$/, "")}).`,
      });
      continue;
    }
    const key = `${delivery.identity(destination)}:${item.input.conversationId}`;
    const group = failures.get(key);
    if (group === undefined || item.input.submissionId < group.first) {
      failures.set(key, {
        destination,
        first: item.input.submissionId,
        reason: item.record.reason,
        ...(notice === undefined ? {} : { notice: notice.text }),
        ...(item.source === "proactive" ? { reminder: item.input.instruction } : {}),
      });
    }
  }
  for (const { destination, first, reason, notice, reminder } of failures.values()) {
    await send(destination, {
      id: `unanswered:${first}:${keyOf(destination)}`,
      text:
        notice ??
        (reminder === undefined
          ? `I couldn't answer that (${reason}). Send it again to retry.`
          : `The reminder "${reminderLabel(reminder)}" couldn't run (${reason}).`),
    });
  }

  const done = new Set(settled.map((item) => item.input.submissionId));
  for (const { source, ids } of settledDirect) await source.clearSettled(tx, ids);
  proactive.pending = keptPending;
  proactive.runs = proactive.runs.filter((entry) => !groups.has(entry.answer));
  proactive.stopped = proactive.stopped.filter(({ submissionId }) => !done.has(submissionId));
  proactive.toolErrors = proactive.toolErrors.filter(({ submissionId }) => !done.has(submissionId));
  return true;
}

/**
 * The delivery connector's `onDelivered`: a door confirmed the first part of a proactive message. It joins the recent
 * sends, which the next reminder sees so it doesn't repeat itself. The door calls it once per message (Telegram marks
 * its reply recorded), in the commit that records the send. `address` is the door's numeric address, stored as
 * `chatId` as 0.1.0-beta.1 stored it.
 */
export async function onDelivered(
  tx: Tx,
  delivered: { readonly sourceId: string; readonly address: number; readonly text: string },
  now: number,
): Promise<void> {
  const state = await tx.doc(Proactive);
  state.recentSends = [
    ...state.recentSends,
    {
      sentAt: now,
      chatId: delivered.address,
      reminderId: delivered.sourceId,
      snippet: delivered.text.replace(/\s+/g, " ").trim().slice(0, 80),
    },
  ].slice(-RECENT_SENDS_KEPT);
}
