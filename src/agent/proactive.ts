/**
 * Proactive runs (M6): runs started by a reminder rather than by the owner. They may stay quiet when there is
 * nothing to say (`NO_SEND`), but never hide a failure, never swallow a message the owner sent in the same turn, and
 * run on a daily budget.
 *
 * - **Provenance.** Pi Durable records which inputs a run answers only while it runs (`pi.live.run.inputs`). When a
 *   run that includes a reminder answers, an `onYield` hook asks for `RecordRun`, which stores those inputs and their
 *   request ids under the answer. A run is reminder-only exactly when every one is `sched:`.
 * - **Rounds.** After each tool round of a reminder-only run, an `afterTools` hook asks for `RoundBudget`. It records
 *   the round's failed tools for the run's inputs, counts the round against the daily cap, and ends the run with
 *   `terminate` at the cap (`daily-cap`) or at `RUN_ROUND_LIMIT` rounds (`run-limit`).
 * - **Replies.** One `reconcileAnswers()` turns every settled input of the Telegram door and every settled reminder
 *   into messages, grouped by the answer they share, so each answer is judged once.
 */
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import {
  configure,
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
} from "./pi/durable.ts";
import { TelegramChannel, type TelegramChannelState } from "./telegram-state.ts";
import { enqueueReply, TelegramOutbox, type OutboxState } from "./telegram-outbox.ts";
import { isNoSend, visibleAnswer } from "../lib/proactive-text.ts";
import { zonedMoment } from "../lib/when.ts";

type Tx = Parameters<typeof configure>[0];
const context = BACKGROUND_CONTEXT;

/** Model rounds proactive runs may take per Chicago day, unless `MIPI_DAILY_RUN_CAP` says otherwise. */
export const DEFAULT_DAILY_RUN_CAP = 50;
/** Tool rounds one proactive run may take. */
export const RUN_ROUND_LIMIT = 8;
/** The cap's day is the owner's calendar day. */
export const CAP_ZONE = "America/Chicago";
/** Confirmed proactive messages kept, and shown to the next reminder so it doesn't repeat itself. */
export const RECENT_SENDS_KEPT = 10;
/** Runs, stops and tool errors kept for reconciliation; far more than are ever waiting at once. */
const RECORDS_KEPT = 100;

export const CAP_NOTICE = "Daily limit for scheduled runs reached; they resume tomorrow.";
export const MIXED_FALLBACK = "I didn't produce an answer for your message; send it again.";

export type ReminderDestination =
  | { readonly kind: "telegram"; readonly chatId: number }
  | { readonly kind: "web"; readonly conversationId: number };

export type StopReason = "daily-cap" | "run-limit";

export type ProactiveState = {
  /** Reminder occurrences admitted and not settled yet. */
  pending: Array<{
    submissionId: number;
    reminderId: string;
    instruction: string;
    conversationId: number;
    destination: ReminderDestination;
  }>;
  /** The inputs of each run that answered with a reminder among them, by answer entry. */
  runs: Array<{ answer: number; inputs: Array<{ submissionId: number; requestId?: string }> }>;
  /** Inputs whose run `RoundBudget` ended, and why. */
  stopped: Array<{ submissionId: number; reason: StopReason }>;
  /** Failed tools of reminder-only runs, by input. */
  toolErrors: Array<{ submissionId: number; tool: string; reason: string }>;
  /** The last confirmed proactive messages, oldest first. */
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

const dayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAP_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Chicago calendar day of `now`, as `YYYY-MM-DD`. */
export const chicagoDay = (now: number): string => dayFormat.format(now);

/** A second past the next Chicago midnight, so a wake right on the boundary is already in the new day. */
export function afterNextChicagoMidnight(now: number): number {
  const [year, month, day] = chicagoDay(now).split("-").map(Number) as [number, number, number];
  return zonedMoment(year, month, day + 1, 0, 0, CAP_ZONE) + 1_000;
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
 * Today's one cap notice: to `chatId` when the blocked reminder answers in a chat, otherwise the private chat that last
 * wrote. With neither, nothing is sent and the day isn't marked noticed, so a later blocked run can still tell.
 */
export function noticeCap(
  state: ProactiveState,
  channel: TelegramChannelState,
  outbox: OutboxState,
  chatId: number | undefined,
  now: number,
): void {
  const cap = today(state, now);
  if (cap.noticeSent) return;
  const chat = chatId ?? channel.lastChat;
  // With no chat to tell, the notice waits for a later blocked run that has one.
  if (chat === undefined) return;
  cap.noticeSent = true;
  enqueueReply(outbox, { id: `cap:${cap.day}`, chatId: chat, text: CAP_NOTICE }, now);
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
        // pi-ledger L7. Rounds are counted here, after each tool round, because `beforeRequest` can't write.
        const now = runtime.now();
        // The run's own limit first: a round it won't take is never charged to the day.
        const reason: StopReason | undefined =
          (run?.turns ?? 0) >= RUN_ROUND_LIMIT
            ? "run-limit"
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

const isReminderRequest = (requestId: string | undefined): boolean =>
  requestId?.startsWith("sched:") === true;

type Settled =
  | {
      readonly source: "telegram";
      readonly input: TelegramChannelState["inputs"][number];
      readonly record: SettledRecord;
    }
  | {
      readonly source: "reminder";
      readonly input: ProactiveState["pending"][number];
      readonly record: SettledRecord;
    };

type SettledRecord =
  | { readonly status: "done"; readonly answer: number }
  | { readonly status: "unanswered"; readonly reason: string };

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
      return { status: "unanswered", reason: record.reason };
    default: {
      const _: never = record;
      throw new Error("Unknown submission status");
    }
  }
}

const reminderLabel = (instruction: string): string =>
  instruction.length > 60 ? `${instruction.slice(0, 59)}…` : instruction;

/**
 * Turns every settled input of the Telegram door and every settled reminder into messages, in the commit that clears
 * them. Returns whether anything changed.
 *
 * - An answer to a Telegram message goes to its chat once, as an answer; `NO_SEND` or an empty one there means the
 *   model produced nothing for the owner, so the chat is told so.
 * - A reminder in a reminder-only run sends its answer to its chat, unless the answer is `NO_SEND` and no tool failed.
 *   A failed tool always sends a notice, with any real answer. A run whose inputs weren't recorded is never quiet.
 * - A reminder in a mixed run is answered like the message beside it, once per chat.
 * - A stopped run sends today's cap notice (`daily-cap`) or a notice for that reminder (`run-limit`).
 * - Inputs that ended without an answer get one notice per chat and conversation.
 */
export async function reconcileAnswers(tx: Tx, now: number): Promise<boolean> {
  const channel = await tx.doc(TelegramChannel);
  const proactive = await tx.doc(Proactive);
  if (channel.inputs.length === 0 && proactive.pending.length === 0) return false;
  const outbox = await tx.doc(TelegramOutbox);

  const settled: Settled[] = [];
  const keptInputs: TelegramChannelState["inputs"] = [];
  for (const input of channel.inputs) {
    const record = await settledRecord(tx, input.submissionId);
    if (record === "open") keptInputs.push(input);
    else settled.push({ source: "telegram", input: { ...input }, record });
  }
  const keptPending: ProactiveState["pending"] = [];
  for (const input of proactive.pending) {
    const record = await settledRecord(tx, input.submissionId);
    if (record === "open") keptPending.push(input);
    else settled.push({ source: "reminder", input: JSON.parse(JSON.stringify(input)), record });
  }
  if (settled.length === 0) return false;

  const stopOf = new Map(
    proactive.stopped.map(({ submissionId, reason }) => [submissionId, reason]),
  );
  const errorsOf = (submissionId: number) =>
    proactive.toolErrors.filter((error) => error.submissionId === submissionId);
  const send = (id: string, chatId: number, text: string, reminderId?: string) =>
    enqueueReply(
      outbox,
      { id, chatId, text, ...(reminderId === undefined ? {} : { proactive: { reminderId } }) },
      now,
    );
  const stopNotice = (input: ProactiveState["pending"][number], reason: StopReason) => {
    const chat = input.destination.kind === "telegram" ? input.destination.chatId : undefined;
    if (reason === "daily-cap") {
      noticeCap(proactive, channel, outbox, chat, now);
    } else if (chat !== undefined) {
      send(
        `run-limit:${input.submissionId}`,
        chat,
        `The reminder "${reminderLabel(input.instruction)}" stopped after ${RUN_ROUND_LIMIT} rounds.`,
      );
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
      run.inputs.every(({ requestId }) => isReminderRequest(requestId));
    const answered = new Set<number>();
    for (const item of group) {
      if (item.source !== "telegram" || answered.has(item.input.chatId)) continue;
      answered.add(item.input.chatId);
      // `NO_SEND` is never an answer to the owner; an empty answer in a mixed run isn't one either.
      const nothing = isNoSend(text) || (text.length === 0 && group.length > 1);
      send(
        `answer:${answer}:${item.input.chatId}`,
        item.input.chatId,
        nothing ? MIXED_FALLBACK : text,
      );
    }
    for (const item of group) {
      if (item.source !== "reminder") continue;
      const { input } = item;
      const stop = stopOf.get(input.submissionId);
      if (stop !== undefined) {
        // Only reminder-only runs are stopped; the run ended on a tool call, with no answer of its own (and no
        // `onYield`, so no run record). The notice is the whole message.
        stopNotice(input, stop);
        continue;
      }
      if (input.destination.kind !== "telegram") continue;
      const chat = input.destination.chatId;
      if (!reminderOnly) {
        // Mixed, or not recorded: answered like a message, once per chat, never quietly.
        if (answered.has(chat)) continue;
        answered.add(chat);
        send(`answer:${answer}:${chat}`, chat, quiet ? MIXED_FALLBACK : text);
        continue;
      }
      const errors = errorsOf(input.submissionId);
      if (errors.length > 0) {
        const tools = [...new Set(errors.map(({ tool }) => tool))].join(", ");
        const notice = `The reminder "${reminderLabel(input.instruction)}" hit a failed tool (${tools}): ${errors[0]!.reason}`;
        send(`tool-error:${input.submissionId}`, chat, quiet ? notice : `${notice}\n\n${text}`);
        continue;
      }
      if (isNoSend(text)) continue;
      if (text.length === 0) {
        // Thinking only, or nothing: a reminder is never dropped without a word.
        send(
          `empty:${input.submissionId}`,
          chat,
          `The reminder "${reminderLabel(input.instruction)}" ran but produced no answer.`,
        );
        continue;
      }
      send(`answer:${answer}:${chat}`, chat, text, input.reminderId);
    }
  }

  // Unanswered: a stopped reminder's notice, or one failure notice per chat and conversation.
  const failures = new Map<
    string,
    { chatId: number; first: number; reason: string; reminder?: string }
  >();
  for (const item of unanswered) {
    const stop = item.source === "reminder" ? stopOf.get(item.input.submissionId) : undefined;
    if (item.source === "reminder" && stop !== undefined) {
      stopNotice(item.input, stop);
      continue;
    }
    const chat =
      item.source === "telegram"
        ? item.input.chatId
        : item.input.destination.kind === "telegram"
          ? item.input.destination.chatId
          : undefined;
    if (chat === undefined) continue;
    const key = `${chat}:${item.input.conversationId}`;
    const group = failures.get(key);
    if (group === undefined || item.input.submissionId < group.first) {
      failures.set(key, {
        chatId: chat,
        first: item.input.submissionId,
        reason: item.record.reason,
        ...(item.source === "reminder" ? { reminder: item.input.instruction } : {}),
      });
    }
  }
  for (const { chatId, first, reason, reminder } of failures.values()) {
    send(
      `unanswered:${first}:${chatId}`,
      chatId,
      reminder === undefined
        ? `I couldn't answer that (${reason}). Send it again to retry.`
        : `The reminder "${reminderLabel(reminder)}" couldn't run (${reason}).`,
    );
  }

  const done = new Set(settled.map((item) => item.input.submissionId));
  channel.inputs = keptInputs;
  proactive.pending = keptPending;
  proactive.runs = proactive.runs.filter((entry) => !groups.has(entry.answer));
  proactive.stopped = proactive.stopped.filter(({ submissionId }) => !done.has(submissionId));
  proactive.toolErrors = proactive.toolErrors.filter(({ submissionId }) => !done.has(submissionId));
  return true;
}

/**
 * After a send confirmed: a proactive reply's first confirmed chunk adds it to the recent sends, once, whatever later
 * splits do to its chunks.
 */
export async function recordProactiveSend(tx: Tx, replyId: string, now: number): Promise<void> {
  const outbox = await tx.doc(TelegramOutbox);
  const reply = outbox.replies.find(({ id }) => id === replyId);
  if (reply?.proactive === undefined || reply.proactiveRecorded === true) return;
  const first = reply.chunks.find(({ status }) => status === "sent");
  if (first === undefined) return;
  reply.proactiveRecorded = true;
  const state = await tx.doc(Proactive);
  state.recentSends = [
    ...state.recentSends,
    {
      sentAt: now,
      chatId: reply.chatId,
      reminderId: reply.proactive.reminderId,
      snippet: first.text.replace(/\s+/g, " ").trim().slice(0, 80),
    },
  ].slice(-RECENT_SENDS_KEPT);
}
