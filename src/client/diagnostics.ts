/**
 * What Settings → Diagnostics shows (COD-236), as plain functions of the events and the health: filters, the
 * summary counts, the fault/hold banner, the frozen view while scrolling is paused, and the Ask MiPi prompt. The
 * section's component (`DiagnosticsSection.tsx`) only holds the choices and renders these.
 */
import {
  type ConversationSummary,
  type DiagEvent,
  type DiagHealth,
  type DiagLevel,
  mainConversationId,
} from "../protocol.ts";

/** A severity chip: one level, or every level. */
export type LevelFilter = "all" | DiagLevel;
export const LEVEL_FILTERS: readonly { readonly id: LevelFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "error", label: "Error" },
  { id: "warn", label: "Warn" },
  { id: "info", label: "Info" },
  { id: "debug", label: "Debug" },
];

export interface DiagFilters {
  readonly level: LevelFilter;
  /** One source, or every source (`undefined`). */
  readonly source: string | undefined;
}

export const ALL_EVENTS: DiagFilters = { level: "all", source: undefined };

/** Errors this recent show in the banner. */
export const RECENT_ERROR_MS = 60 * 60_000;
/** A lost alarm this recent shows in the banner, as the heartbeat counts it. */
export const RECENT_ALARM_LOSS_MS = 26 * 60 * 60_000;
/** Events the Ask MiPi prompt carries, newest last. */
export const ASK_MIPI_EVENTS = 15;

export const matchesFilters = (event: DiagEvent, filters: DiagFilters): boolean =>
  (filters.level === "all" || event.level === filters.level) &&
  (filters.source === undefined || event.source === filters.source);

/** The sources present, for their chips: sorted, each once. */
export const sourcesOf = (events: readonly DiagEvent[]): string[] =>
  [...new Set(events.map(({ source }) => source))].sort();

/**
 * The rows shown, oldest first. While scrolling is paused (`frozenAt`: the newest id when it paused), events that came
 * after stay out, counted in `pending`, so a row being read doesn't move.
 */
export function shownEvents(
  events: readonly DiagEvent[],
  filters: DiagFilters,
  frozenAt: number | undefined,
): { readonly rows: readonly DiagEvent[]; readonly pending: number } {
  const matching = events.filter((event) => matchesFilters(event, filters));
  if (frozenAt === undefined) return { rows: matching, pending: 0 };
  const rows = matching.filter(({ id }) => id <= frozenAt);
  return { rows, pending: matching.length - rows.length };
}

export interface DiagCounts {
  readonly total: number;
  readonly ok: number;
  /** Warnings, and events held by a gate whatever their level. */
  readonly warnHeld: number;
  readonly error: number;
}

export function countEvents(events: readonly DiagEvent[]): DiagCounts {
  let ok = 0;
  let warnHeld = 0;
  let error = 0;
  for (const event of events) {
    if (event.level === "error") error += 1;
    else if (event.level === "warn" || event.outcome === "held") warnHeld += 1;
    else if (event.outcome === "ok") ok += 1;
  }
  return { total: events.length, ok, warnHeld, error };
}

/** One line of the banner: something wrong or waiting now. */
export type BannerItem =
  | { readonly kind: "state"; readonly text: string }
  | { readonly kind: "alarm-lost"; readonly text: string }
  | { readonly kind: "held"; readonly text: string }
  | { readonly kind: "overdue"; readonly text: string }
  | { readonly kind: "errors"; readonly text: string };

export const HOLD_LABELS: Readonly<Record<NonNullable<DiagHealth["held"]>, string>> = {
  paused: "MiPi is paused",
  "spend-cap": "Today's spend cap is reached",
  "provider-limit": "The provider's limit is reached",
  "run-cap": "Today's run cap is reached",
};

/** What the fault/hold banner says, most serious first; empty when all is well. */
export function bannerItems(
  health: DiagHealth | undefined,
  events: readonly DiagEvent[],
  now: number,
  time: (at: number) => string = localTime,
): BannerItem[] {
  const items: BannerItem[] = [];
  if (health !== undefined && health.state !== "open") {
    items.push({
      kind: "state",
      text: `The agent is ${health.state}${health.reason === undefined ? "" : `: ${health.reason}`}.`,
    });
  }
  if (health?.alarmLostAt !== undefined && now - health.alarmLostAt < RECENT_ALARM_LOSS_MS) {
    items.push({
      kind: "alarm-lost",
      text: `The alarm was lost at ${time(health.alarmLostAt)}; work may have waited.`,
    });
  }
  if (health?.held !== undefined) {
    items.push({
      kind: "held",
      text: `${HOLD_LABELS[health.held]}${health.heldUntil === undefined ? "" : ` until ${time(health.heldUntil)}`}: scheduled work waits.`,
    });
  }
  if (health !== undefined && health.overdueSchedules > 0) {
    items.push({
      kind: "overdue",
      text: `${health.overdueSchedules} ${health.overdueSchedules === 1 ? "schedule is" : "schedules are"} more than two hours late.`,
    });
  }
  const errors = events.filter(
    ({ level, ts }) => level === "error" && now - ts < RECENT_ERROR_MS,
  ).length;
  if (errors > 0) {
    items.push({
      kind: "errors",
      text: `${errors} ${errors === 1 ? "error" : "errors"} in the last hour.`,
    });
  }
  return items;
}

export const localTime = (at: number): string => new Date(at).toLocaleString();

/** The health in one line, for the prompt. */
export function healthLine(health: DiagHealth | undefined): string {
  if (health === undefined) return "Health: not read yet.";
  const parts = [
    `state ${health.state}${health.reason === undefined ? "" : ` (${health.reason})`}`,
    health.alarmAt === undefined
      ? "no alarm set"
      : `next alarm ${new Date(health.alarmAt).toISOString()}`,
    ...(health.alarmLostAt === undefined
      ? []
      : [`alarm lost at ${new Date(health.alarmLostAt).toISOString()}`]),
    ...(health.held === undefined
      ? []
      : [
          `held: ${health.held}${health.heldUntil === undefined ? "" : ` until ${new Date(health.heldUntil).toISOString()}`}`,
        ]),
    `overdue schedules ${health.overdueSchedules}`,
    ...(health.lastProactiveRun === undefined
      ? []
      : [
          `last scheduled run ${health.lastProactiveRun.outcome} at ${new Date(health.lastProactiveRun.at).toISOString()}`,
        ]),
  ];
  return `Health: ${parts.join("; ")}.`;
}

/** One event as a prompt line: what the table shows, with its correlation ids. */
export function eventPromptLine(event: DiagEvent): string {
  const ids = [
    event.reqId === undefined ? undefined : `req ${event.reqId}`,
    event.convId === undefined ? undefined : `conversation ${event.convId}`,
    event.taskId === undefined ? undefined : `task ${event.taskId}`,
  ].filter((id): id is string => id !== undefined);
  return `- ${new Date(event.ts).toISOString()} ${event.level} ${event.source} ${event.kind} (${event.outcome}): ${event.summary.replaceAll(/\s+/g, " ")}${ids.length === 0 ? "" : ` [${ids.join(", ")}]`}`;
}

/**
 * The Ask MiPi draft: the health and the last `ASK_MIPI_EVENTS` of the events shown, as plain text the owner reads and
 * sends (or not). Events hold no message text or secrets (`src/agent/diag.ts`), so neither does this.
 */
export function askMiPiPrompt(health: DiagHealth | undefined, shown: readonly DiagEvent[]): string {
  const recent = shown.slice(-ASK_MIPI_EVENTS);
  return [
    "Something may be wrong with you. Here is what Settings → Diagnostics shows. What do you make of it, and what should I check?",
    "",
    healthLine(health),
    "",
    recent.length === 0
      ? "No recent events."
      : `Recent events, oldest first (${recent.length}):\n${recent.map(eventPromptLine).join("\n")}`,
  ].join("\n");
}

/** An event's expandable part: its detail and its correlation fields, as the table's JSON shows them. */
export function eventDetail(event: DiagEvent): Readonly<Record<string, unknown>> {
  return {
    ...(event.reqId === undefined ? {} : { reqId: event.reqId }),
    ...(event.convId === undefined ? {} : { convId: event.convId }),
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.detail === undefined ? {} : { detail: event.detail }),
  };
}

/** What Ask MiPi does in the session around Settings (`ChatSession.tsx`). */
export interface AskMiPiTarget {
  readonly conversations: readonly ConversationSummary[];
  /** Opens a conversation (and its link). */
  readonly open: (conversationId: number) => void;
  readonly setDraft: (text: string) => void;
  readonly closeSettings: () => void;
  readonly focusComposer: () => void;
}

/**
 * Ask MiPi: MiPi's conversation opens with the prompt in the composer, Settings closes and the composer takes focus.
 * Nothing is sent: the owner reads the draft and sends it, or not. False when there is no MiPi to ask yet.
 */
export function askMiPi(prompt: string, target: AskMiPiTarget): boolean {
  const main = mainConversationId(target.conversations);
  if (main === undefined) return false;
  target.open(main);
  target.setDraft(prompt);
  target.closeSettings();
  target.focusComposer();
  return true;
}
