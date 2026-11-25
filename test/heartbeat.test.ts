import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";
import { ALARM_LOST_WINDOW_MS, evaluateHeartbeat } from "../scripts/heartbeat-check.ts";
import { HEARTBEAT_MS, suspectLostAlarm } from "../src/agent/alarm.ts";
import { composeMipi } from "../src/agent/composition.ts";
import { OVERDUE_MS, readHeartbeat } from "../src/agent/heartbeat.ts";
import { ProviderLimits } from "../src/agent/limits.ts";
import { rowCounts, STALE_EXPORT_MS, writeMeta } from "../src/agent/maintenance.ts";
import { Proactive } from "../src/agent/proactive.ts";
import { Spend } from "../src/agent/spend.ts";
import { ScheduledReminder } from "../src/extensions/builtin/reminders/reminder-task.ts";
import { DeliverScheduledInstruction } from "../src/extensions/builtin/reminders/schedule-task.ts";
import { afterNextChicagoMidnight } from "../src/lib/cap-day.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const open = { kind: "open" };
const healthy = { activeSchedules: 1, overdue: [] };

describe("external heartbeat check", () => {
  const now = Date.UTC(2026, 10, 25, 14, 17);

  it("fails for non-open state and missing or malformed health", () => {
    for (const kind of ["maintenance", "refused"]) {
      expect(evaluateHeartbeat({ state: { kind }, heartbeat: healthy }, now).ok).toBe(false);
    }
    expect(evaluateHeartbeat({ state: open }, now).ok).toBe(false);
    expect(evaluateHeartbeat({ state: open, heartbeat: { overdue: [] } }, now).ok).toBe(false);
  });

  it("fails for a recent alarm loss and ages it out at 26 hours", () => {
    const check = (at: number) =>
      evaluateHeartbeat({ state: open, heartbeat: { ...healthy, alarmLost: { at } } }, now);
    expect(check(now - ALARM_LOST_WINDOW_MS + 1)).toMatchObject({ ok: false });
    expect(check(now - ALARM_LOST_WINDOW_MS)).toMatchObject({ ok: true });
  });

  it("fails overdue work with no known hold and explains all known holds", () => {
    const overdue = [
      { id: "reminder", dueAt: now - 3 * HOUR, overdueMs: 3 * HOUR, repeating: true },
    ];
    for (const held of [undefined, "mistyped"]) {
      expect(
        evaluateHeartbeat({ state: open, heartbeat: { ...healthy, overdue, held } }, now).ok,
      ).toBe(false);
    }
    for (const held of ["paused", "spend-cap", "provider-limit", "run-cap"]) {
      const result = evaluateHeartbeat(
        { state: open, heartbeat: { ...healthy, overdue, held } },
        now,
      );
      expect(result.ok).toBe(true);
      expect(result.message).toContain(held);
    }
  });
});

describe("alarm loss", () => {
  it("uses strict future and overdue grace windows and detects an active recovery wake", () => {
    const now = 10 * MINUTE;
    expect(suspectLostAlarm(null, { active: false }, now)).toBe(false);
    for (const at of [now, now + MINUTE, now - 5 * MINUTE]) {
      expect(suspectLostAlarm(null, { active: false, at }, now)).toBe(false);
    }
    for (const at of [now + MINUTE + 1, now - 5 * MINUTE - 1]) {
      expect(suspectLostAlarm(null, { active: false, at }, now)).toBe(true);
      expect(suspectLostAlarm(now, { active: false, at }, now)).toBe(false);
    }
    expect(suspectLostAlarm(null, { active: true }, now)).toBe(true);
  });

  async function coldObject(name: string) {
    const stub = env.AGENT.getByName(name);
    const dueAt = Date.now() + HOUR;
    await runInDurableObject(stub, async (_instance, state) => {
      await state.blockConcurrencyWhile(async () => {});
      const harness = await Harness.open(
        await openDurableObjectSqliteStorage(state.storage),
        { ...composeMipi().options, onWake: () => {} },
        ctx,
      );
      const root = await harness.root(ctx);
      await harness.commit(
        (tx) =>
          tx.createTask(
            ScheduledReminder,
            {
              id: "sched:cold",
              conversationId: root.id,
              instruction: "Call the dentist",
              zone: "UTC",
              first: dueAt,
              destination: { kind: "web", conversationId: root.id },
            },
            { ownership: { kind: "conversation" }, conversationId: root.id, background: true },
          ),
        ctx,
      );
      harness.resume();
      await harness.waitForIdle(ctx);
      await harness.close(ctx);
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);
    return { stub, dueAt };
  }

  it("records a cold-start incident once, re-arms the alarm, and strips the marker on export", async () => {
    const { stub, dueAt } = await coldObject("heartbeat-lost");
    const status = await stub.adminStatus();
    expect(status.heartbeat).toMatchObject({
      activeSchedules: 1,
      nextDueAt: dueAt,
      overdue: [],
      alarmLost: { at: Number(status.meta.alarm_lost_at) },
    });
    expect(Number(status.meta.alarm_lost_at)).toBeGreaterThan(0);
    await runInDurableObject(stub, async (instance, state) => {
      const alarm = await state.storage.getAlarm();
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(dueAt);
      state.storage.sql.exec("CREATE TABLE alarm_writes (at TEXT NOT NULL)");
      state.storage.sql.exec(
        "CREATE TRIGGER trace_alarm_update AFTER UPDATE ON app_meta WHEN new.key = 'alarm_lost_at' " +
          "BEGIN INSERT INTO alarm_writes VALUES (new.value); END",
      );
      expect((await instance.adminStatus()).heartbeat?.alarmLost).toEqual(
        status.heartbeat?.alarmLost,
      );
      expect(state.storage.sql.exec("SELECT * FROM alarm_writes").toArray()).toEqual([]);
    });
    expect((await stub.exportBegin()).meta.alarm_lost_at).toBeUndefined();
    await stub.exportEnd();
  });

  it("recognizes alarm delivery on a cold object while another wake is far in the future", async () => {
    const { stub, dueAt } = await coldObject("heartbeat-delivering");
    expect(dueAt - Date.now()).toBeGreaterThan(HEARTBEAT_MS);
    // The cold object's alarm is absent from storage, as when the runtime is delivering it.
    // Enter the real alarm handler first, without an admin or fetch call claiming startup.
    await runInDurableObject(stub, async (instance, state) => {
      await state.blockConcurrencyWhile(async () => {});
      await instance.alarm();
    });
    expect((await stub.adminStatus()).heartbeat).toMatchObject({ nextDueAt: dueAt });
    expect((await stub.adminStatus()).heartbeat?.alarmLost).toBeUndefined();
  });

  it("skips the alarm deleted by export, restore, and stale export recovery", async () => {
    const { stub } = await coldObject("heartbeat-maintenance");
    await runInDurableObject(stub, async (instance, state) => {
      await state.blockConcurrencyWhile(async () => {});
      // Simulate the intentional alarm deletion on an already open object before reopening it.
      await instance.alarm();
      const header = await instance.exportBegin();
      const rows = instance.exportPage(undefined).rows;
      const counts = rowCounts(state.storage.sql);
      expect((await instance.exportEnd()).consistent).toBe(true);
      expect((await instance.adminStatus()).heartbeat?.alarmLost).toBeUndefined();
      await instance.restoreBegin(header, header.meta.app_version!);
      instance.restoreRows(rows);
      expect((await instance.restoreEnd(counts)).heartbeat?.alarmLost).toBeUndefined();
      await instance.exportBegin();
      writeMeta(state.storage.sql, {
        maintenance_started_at: String(Date.now() - STALE_EXPORT_MS),
      });
    });
    await evictDurableObject(stub);
    const status = await stub.adminStatus();
    expect(status.heartbeat?.activeSchedules).toBe(1);
    expect(status.heartbeat?.alarmLost).toBeUndefined();
  });
});

describe("heartbeat status", () => {
  it("reads both schedule formats, the latest run, and effective holds without writing", async () => {
    await runInDurableObject(env.AGENT.getByName("heartbeat-reader"), async (_instance, state) => {
      const composition = composeMipi();
      const harness = await Harness.open(new MemoryStorage(), composition.options, ctx);
      const sql = state.storage.sql;
      const now = Date.now() + 4 * HOUR;
      const before = rowCounts(sql);
      const readers = composition.extensions.active.flatMap(({ schedules }) => schedules ?? []);
      try {
        const root = await harness.root(ctx);
        const ownership = { ownership: { kind: "conversation" }, conversationId: root.id } as const;
        await harness.commit(async (tx) => {
          await tx.createTask(
            ScheduledReminder,
            {
              id: "modern",
              conversationId: root.id,
              instruction: "Reminder",
              zone: "UTC",
              first: now - OVERDUE_MS - 1,
              every: { minutes: 20 },
              destination: { kind: "web", conversationId: root.id },
            },
            ownership,
          );
          await tx.createTask(
            DeliverScheduledInstruction,
            {
              id: "legacy",
              conversationId: root.id,
              instruction: "Reminder",
              runAt: now - 3 * HOUR,
            },
            ownership,
          );
          (await tx.doc(Proactive)).lastRun = { at: now - 4 * HOUR, outcome: "quiet" };
          (await tx.doc(Proactive)).limit = 0;
        }, ctx);
        const read = () => readHeartbeat(harness, sql, readers, now);
        const midnight = afterNextChicagoMidnight(now);
        expect(await read()).toMatchObject({
          lastProactiveRun: { at: now - 4 * HOUR, outcome: "quiet" },
          activeSchedules: 2,
          nextDueAt: now - 3 * HOUR,
          overdue: [
            { id: "legacy", dueAt: now - 3 * HOUR, overdueMs: 3 * HOUR, repeating: false },
            {
              id: "modern",
              dueAt: now - OVERDUE_MS - 1,
              overdueMs: OVERDUE_MS + 1,
              repeating: true,
            },
          ],
          held: "run-cap",
          heldUntil: midnight,
        });
        expect(await harness.snapshot(Spend, ctx)).toBeUndefined();
        expect(await harness.snapshot(ProviderLimits, ctx)).toBeUndefined();
        expect(rowCounts(sql)).toEqual(before);

        const resetAt = midnight + HOUR;
        await harness.commit(async (tx) => {
          (await tx.doc(ProviderLimits)).entries.go = { label: "Go", at: now, resetAt };
        }, ctx);
        expect(await read()).toMatchObject({ held: "provider-limit", heldUntil: resetAt });
        await harness.commit(async (tx) => {
          (await tx.doc(Spend)).limit = 0;
        }, ctx);
        expect(await read()).toMatchObject({ held: "spend-cap", heldUntil: resetAt });
        await harness.commit(async (tx) => {
          (await tx.doc(Spend)).paused = true;
        }, ctx);
        expect(await read()).toMatchObject({ held: "paused", heldUntil: undefined });
      } finally {
        await harness.close(ctx);
      }
    });
  });

  it("reports zero schedules with bare core", async () => {
    await runInDurableObject(env.AGENT.getByName("heartbeat-bare"), async (_instance, state) => {
      const composition = composeMipi({ extensions: [] });
      const harness = await Harness.open(new MemoryStorage(), composition.options, ctx);
      try {
        expect(await readHeartbeat(harness, state.storage.sql, [], Date.now())).toMatchObject({
          activeSchedules: 0,
          nextDueAt: undefined,
          overdue: [],
        });
      } finally {
        await harness.close(ctx);
      }
    });
  });
});
