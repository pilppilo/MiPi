import type { ScheduleReader, ScheduledWork } from "./extensions.ts";
import { type ProactiveHold, readProactiveHold } from "./gates.ts";
import { readMeta } from "./maintenance.ts";
import { BACKGROUND_CONTEXT } from "./pi/context.ts";
import type { Harness } from "./pi/durable.ts";
import type { ProactiveRun } from "./proactive.ts";

export const OVERDUE_MS = 2 * 60 * 60_000;

export interface HeartbeatStatus {
  readonly at: number;
  readonly lastProactiveRun?: ProactiveRun;
  readonly activeSchedules: number;
  readonly nextDueAt?: number;
  readonly overdue: readonly (ScheduledWork & { readonly overdueMs: number })[];
  readonly alarmLost?: { readonly at: number };
  readonly held?: ProactiveHold;
  readonly heldUntil?: number;
}

export async function readHeartbeat(
  harness: Harness,
  sql: SqlStorage,
  scheduleReaders: readonly ScheduleReader[],
  now: number,
): Promise<HeartbeatStatus> {
  const [schedules, { held, heldUntil, lastProactiveRun }] = await Promise.all([
    scheduleReaders.length === 0
      ? []
      : harness.commit(async (tx) => {
          const schedules: ScheduledWork[] = [];
          for (const read of scheduleReaders) schedules.push(...(await read(tx)));
          return schedules;
        }, BACKGROUND_CONTEXT),
    readProactiveHold(harness, now),
  ]);
  schedules.sort((a, b) => a.dueAt - b.dueAt);
  const alarmLostAt = Number(readMeta(sql).alarm_lost_at);
  return {
    at: now,
    lastProactiveRun,
    activeSchedules: schedules.length,
    nextDueAt: schedules[0]?.dueAt,
    overdue: schedules
      .filter(({ dueAt }) => now - dueAt > OVERDUE_MS)
      .map((schedule) => ({ ...schedule, overdueMs: now - schedule.dueAt })),
    alarmLost: Number.isFinite(alarmLostAt) ? { at: alarmLostAt } : undefined,
    held,
    heldUntil,
  };
}
