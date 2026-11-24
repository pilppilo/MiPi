/** The wake sources (`wake-sources.ts`): one registration per part, and the alarm, commits and shutdown loop over them. */
import { describe, expect, it } from "vitest";
import { AlarmScheduler, runAlarmConsumers } from "../src/agent/alarm.ts";
import {
  type CommitChanges,
  type SourceWake,
  type WakeSource,
  WakeSources,
} from "../src/agent/wake-sources.ts";

/** A source whose wake the test sets, recording what the agent calls on it. */
const fakeSource = (name: string, kind?: string) => {
  const calls: string[] = [];
  let wake: SourceWake = { active: false };
  const source: WakeSource = {
    name,
    wake: () => wake,
    run: () => {
      calls.push("run");
    },
    ...(kind === undefined
      ? {}
      : {
          observes: (publication: CommitChanges) =>
            publication.changes.some((change) => change.record?.kind === kind),
          refresh: () => {
            calls.push("refresh");
          },
        }),
    close: () => {
      calls.push("close");
    },
  };
  return {
    source,
    calls,
    setWake: (next: SourceWake) => {
      wake = next;
    },
  };
};

const commitOf = (kind: string): CommitChanges => ({
  changes: [{ type: "document", record: { kind } }],
});

describe("WakeSources", () => {
  it("takes the earliest wake, active when any source is", () => {
    const sources = new WakeSources(() => {});
    expect(sources.wake()).toEqual({ active: false });
    const first = fakeSource("first");
    const second = fakeSource("second");
    sources.register(first.source);
    sources.register(second.source);
    first.setWake({ active: false, at: 9_000 });
    second.setWake({ active: true, at: 4_000 });
    expect(sources.wake()).toEqual({ active: true, at: 4_000 });
  });

  it("refuses a second source with the same name", () => {
    const sources = new WakeSources(() => {});
    sources.register(fakeSource("Telegram door").source);
    expect(() => sources.register(fakeSource("Telegram door").source)).toThrow(
      /already registered/,
    );
  });

  it("refreshes only the sources that observe a commit", () => {
    const sources = new WakeSources(() => {});
    const memory = fakeSource("memory pass", "app.memory");
    const telegram = fakeSource("Telegram door", "app.telegram");
    const quiet = fakeSource("quiet");
    for (const { source } of [memory, telegram, quiet]) sources.register(source);
    sources.observe(commitOf("app.memory"));
    expect(memory.calls).toEqual(["refresh"]);
    expect(telegram.calls).toEqual([]);
    expect(quiet.calls).toEqual([]);
  });

  it("closes every source and empties the list, so a reopen registers each once", () => {
    const sources = new WakeSources(() => {});
    const first = fakeSource("first");
    sources.register(first.source);
    sources.close();
    expect(first.calls).toEqual(["close"]);
    expect(sources.names()).toEqual([]);
    // A reopen (after an export or restore) registers the same names again without a clash.
    sources.register(fakeSource("first").source);
    expect(sources.names()).toEqual(["first"]);
  });

  it("adds a part to the alarm with one registration: its wake sets it, a commit refreshes it, the alarm runs it", async () => {
    const writes: Array<number | "deleted"> = [];
    const sources = new WakeSources(() => {});
    const scheduler = new AlarmScheduler(
      {
        setAlarm: async (at) => {
          writes.push(at);
        },
        deleteAlarm: async () => {
          writes.push("deleted");
        },
      },
      () => sources.wake(),
      () => 0,
    );
    const heartbeat = fakeSource("heartbeat", "app.heartbeat");
    sources.register(heartbeat.source);

    heartbeat.setWake({ active: false, at: 30_000 });
    await scheduler.schedule({ active: false });
    expect(writes).toEqual([30_000]);

    sources.observe(commitOf("app.heartbeat"));
    sources.observe(commitOf("app.other"));
    expect(heartbeat.calls).toEqual(["refresh"]);

    const ran: string[] = [];
    await runAlarmConsumers(
      [["Pi Durable resume", () => ran.push("resume")], ...sources.consumers()],
      () => {},
      async () => {
        ran.push("rescheduled");
      },
    );
    expect(ran).toEqual(["resume", "rescheduled"]);
    expect(heartbeat.calls).toEqual(["refresh", "run"]);
  });

  it("skips a source closed while an earlier consumer ran, as when maintenance takes the object", async () => {
    const sources = new WakeSources(() => {});
    const later = fakeSource("later");
    sources.register(later.source);
    await runAlarmConsumers(
      [["Pi Durable resume", () => sources.close()], ...sources.consumers()],
      () => {},
      async () => {},
    );
    expect(later.calls).toEqual(["close"]);
  });

  it("keeps closing and observing the other sources when one throws, and reports it", () => {
    const reports: string[] = [];
    const sources = new WakeSources((message) => reports.push(message));
    sources.register({
      name: "broken",
      wake: () => ({ active: false }),
      run: () => {},
      observes: () => {
        throw new Error("bad check");
      },
      close: () => {
        throw new Error("bad close");
      },
    });
    const healthy = fakeSource("healthy", "app.memory");
    sources.register(healthy.source);
    sources.observe(commitOf("app.memory"));
    sources.close();
    expect(healthy.calls).toEqual(["refresh", "close"]);
    expect(reports).toEqual([
      "Refreshing the broken after a commit failed",
      "Closing the broken failed",
    ]);
  });

  it("runs the sources in registration order, after Pi Durable", async () => {
    const order: string[] = [];
    const sources = new WakeSources(() => {});
    for (const name of ["Telegram door", "memory pass"]) {
      sources.register({ name, wake: () => ({ active: false }), run: () => order.push(name) });
    }
    await runAlarmConsumers(
      [["Pi Durable resume", () => order.push("Pi Durable resume")], ...sources.consumers()],
      () => {},
      async () => {},
    );
    expect(order).toEqual(["Pi Durable resume", "Telegram door", "memory pass"]);
  });
});
