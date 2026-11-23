/** The one alarm (`alarm.ts`): the earliest of every part's needs, deleted when none, and isolated consumers. */
import { describe, expect, it } from "vitest";
import { AlarmScheduler, alarmTime, HEARTBEAT_MS, runAlarmConsumers } from "../src/agent/alarm.ts";

const fakeStorage = () => {
  const writes: Array<number | "deleted"> = [];
  return {
    writes,
    storage: {
      setAlarm: async (at: number) => {
        writes.push(at);
      },
      deleteAlarm: async () => {
        writes.push("deleted");
      },
    },
  };
};

describe("alarmTime", () => {
  it("takes the earliest of Pi Durable's wake, the Telegram door and the heartbeat", () => {
    expect(alarmTime({ active: false }, undefined, 0)).toBeUndefined();
    expect(alarmTime({ active: false }, { active: false }, 0)).toBeUndefined();
    expect(alarmTime({ active: true }, undefined, 0)).toBe(HEARTBEAT_MS);
    expect(alarmTime({ active: false }, { active: true }, 0)).toBe(HEARTBEAT_MS);
    expect(alarmTime({ active: true, at: 5_000 }, { active: false, at: 9_000 }, 0)).toBe(5_000);
    expect(alarmTime({ active: false, at: 90_000 }, { active: false, at: 2_000 }, 0)).toBe(2_000);
  });
});

describe("AlarmScheduler", () => {
  it("deletes the alarm when nothing needs it, and writes in the order asked", async () => {
    const { storage, writes } = fakeStorage();
    let telegram = { active: false, at: 7_000 } as { active: boolean; at?: number };
    const scheduler = new AlarmScheduler(
      storage,
      () => telegram,
      () => 0,
    );
    await scheduler.schedule({ active: false, at: 9_000 });
    telegram = { active: false };
    await scheduler.schedule({ active: false });
    void scheduler.schedule({ active: false, at: 3_000 });
    void scheduler.schedule({ active: false, at: 4_000 });
    await scheduler.settled();
    expect(writes).toEqual([7_000, "deleted", 3_000, 4_000]);
  });
});

describe("runAlarmConsumers", () => {
  it("runs every consumer though one throws, reports it, and always reschedules", async () => {
    const ran: string[] = [];
    const reports: string[] = [];
    await runAlarmConsumers(
      [
        ["Pi Durable resume", () => ran.push("resume")],
        [
          "Telegram door",
          async () => {
            throw new Error("Bot API down");
          },
        ],
        ["later", () => ran.push("later")],
      ],
      (message) => reports.push(message),
      async () => {
        ran.push("rescheduled");
      },
    );
    expect(ran).toEqual(["resume", "later", "rescheduled"]);
    expect(reports).toEqual(["The alarm's Telegram door failed"]);
  });
});
