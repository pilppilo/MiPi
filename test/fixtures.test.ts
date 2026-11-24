/// <reference types="vite/client" />
/**
 * Every committed fixture database (`test/fixtures/db/*.json`, one per release from 0.1.0-beta.1) restored into a
 * fresh agent through the admin API, as a real restore would be: it must open on this build, and what it holds must
 * still work. From beta on, stored data survives upgrades; this is the test that says so.
 *
 * Each fixture was written by `test/fixture-capture.test.ts` (`node scripts/fixture-capture.ts`), which seeds the same
 * story every time: a web conversation that remembered a lesson, a Telegram chat with a sent reply and a sleeping
 * reminder, a relay exchange, and a background memory pass.
 */
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness } from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { describe, expect, it } from "vitest";
import { UNKNOWN_ORIGIN } from "../src/agent/origin.ts";
import { composeMipi } from "../src/agent/composition.ts";
import type { AdminStatus, MipiAgent } from "../src/agent/agent-do.ts";
import { ChannelBindings } from "../src/agent/conversations.ts";
import { createHarnessOptions } from "../src/agent/composition.ts";
import { MemoryDoc } from "../src/extensions/builtin/memory/memory.ts";
import { ScheduledReminder } from "../src/extensions/builtin/reminders/reminder-task.ts";
import worker from "../src/worker/index.ts";
import type { Fixture } from "./fixture-capture.test.ts";
import { clock, openAgent, said } from "./reminder-agent.ts";
import { withSpikeToken } from "./spike.ts";

const ctx = BACKGROUND_CONTEXT;

const fixtures = import.meta.glob<Fixture>("./fixtures/db/*.json", {
  eager: true,
  import: "default",
});

const countsOf = (rows: Fixture["rows"]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const { table } of rows) counts[table] = (counts[table] ?? 0) + 1;
  return counts;
};

describe("fixture databases", () => {
  it("has at least the first one", () => {
    expect(Object.keys(fixtures)).toContain("./fixtures/db/0.1.0-beta.1.json");
  });

  for (const [path, fixture] of Object.entries(fixtures)) {
    const version = fixture.header.meta.app_version ?? path;

    /** Restores the fixture into a fresh agent named `owner` through the admin API, as a real restore would. */
    const restoreInto = async (owner: string): Promise<AdminStatus> => {
      const ownerEnv = { ...env, MIPI_OWNER: owner } as unknown as Env;
      const call = async <T>(method: string, route: string, payload?: unknown): Promise<T> => {
        const response = await worker.fetch(
          new Request(`https://mipi.example${route}`, {
            method,
            headers: {
              Authorization: "Bearer test-admin-token",
              "Content-Type": "application/json",
            },
            ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
          }),
          ownerEnv,
        );
        const result = (await response.json()) as T & { error?: string };
        if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${result.error}`);
        return result;
      };
      await call("POST", "/api/admin/restore/begin", {
        header: fixture.header,
        confirm: fixture.header.meta.app_version,
      });
      for (let index = 0; index < fixture.rows.length; index += 50) {
        await call("POST", "/api/admin/restore/rows", {
          rows: fixture.rows.slice(index, index + 50),
        });
      }
      return call<AdminStatus>("POST", "/api/admin/restore/end", {
        rows: countsOf(fixture.rows),
      });
    };

    it(`opens and works after restoring ${version}`, async () => {
      const owner = `fixture-${version}`.replace(/[^\w-]/g, "-");
      const ownerEnv = { ...env, MIPI_OWNER: owner } as unknown as Env;
      const status = await restoreInto(owner);
      // The startup guard read it and Pi Durable opened it.
      expect(status.state).toEqual({ kind: "open" });

      const stub = env.AGENT.getByName(owner);
      // The relay still answers the key it answered then.
      const relay = await runInDurableObject(stub, (instance: MipiAgent) =>
        instance.relayResult("fixture-relay"),
      );
      expect(relay).toEqual({ kind: "done", answer: "Hi PiDu." });

      // The web door opens a session on it.
      const socket = await worker.fetch(
        withSpikeToken(`https://mipi.example/api/sessions/${owner}`, {
          headers: { Upgrade: "websocket" },
        }),
        ownerEnv,
      );
      expect(socket.status).toBe(101);
      socket.webSocket!.accept();
      socket.webSocket!.close(1000, "done");

      // The repeat's stored time is long past: on opening, it is skipped as late and sleeps until its next time, without
      // a turn. Until it does, it may still be running.
      let reminder: { status?: string; skippedLate?: number } = {};
      // Until it has woken: it starts out sleeping too, on its stored time, before `resume()` runs it.
      const woken = () => reminder.status === "sleeping" && (reminder.skippedLate ?? 0) >= 1;
      for (let attempt = 0; attempt < 200 && !woken(); attempt++) {
        reminder = await runInDurableObject(stub, (_instance, state) => {
          const [row] = state.storage.sql
            .exec<{ record: string }>(`SELECT record FROM tasks WHERE kind = '"app.reminder"'`)
            .toArray();
          const record = JSON.parse(row?.record ?? "{}") as {
            state?: { status?: string; checkpoint?: { skippedLate?: number; at?: number } };
          };
          return {
            ...(record.state?.status === undefined ? {} : { status: record.state.status }),
            ...(record.state?.checkpoint?.skippedLate === undefined
              ? {}
              : { skippedLate: record.state.checkpoint.skippedLate }),
          };
        });
        if (!woken()) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(reminder.status).toBe("sleeping");
      expect(reminder.skippedLate).toBeGreaterThanOrEqual(1);

      // What each door stored reads back as this build's documents and tasks.
      await runInDurableObject(stub, async (_instance, state) => {
        await state.blockConcurrencyWhile(async () => {});
        // Every stored input's origin reads from its request id, as it was stored then (COD-209), through the prefixes
        // the doors and the reminders register (COD-210).
        const { originOf } = composeMipi().connectors.origins;
        const origins = state.storage.sql
          .exec<{ record: string }>("SELECT record FROM submissions")
          .toArray()
          .map(({ record }) => (JSON.parse(record) as { requestId?: string }).requestId)
          .filter((requestId): requestId is string => requestId !== undefined)
          .map((requestId) => ({ requestId, origin: originOf(requestId) }));
        expect(origins.length).toBeGreaterThan(0);
        for (const { requestId, origin } of origins) {
          expect(origin, requestId).not.toEqual(UNKNOWN_ORIGIN);
        }
        expect(new Set(origins.map(({ origin }) => origin.source))).toEqual(
          new Set(["web", "telegram", "relay"]),
        );
        const harness = await Harness.open(
          await openDurableObjectSqliteStorage(state.storage),
          createHarnessOptions({
            models: createModels(),
            model: { provider: "faux", modelId: "faux-1" },
          }),
          ctx,
        );
        try {
          const lessons = (await harness.snapshot(MemoryDoc, ctx))?.lessons ?? [];
          expect(lessons.map(({ text }) => text)).toEqual(
            expect.arrayContaining(["The owner drinks tea, not coffee."]),
          );
          expect(lessons.some(({ from }) => from.source === "background")).toBe(true);
          // Snapshots only: this inspecting harness writes nothing beside the live agent.
          for (const key of ["tg:4242", "web", "relay:pidu"]) {
            expect(
              (await harness.snapshot(ChannelBindings, key, ctx))?.conversationId,
              key,
            ).toBeDefined();
          }
          const reminders = (await harness.inspect(ctx)).tasks.filter(
            ({ record }) => record.kind === ScheduledReminder.definition.name,
          );
          expect(reminders).toHaveLength(1);
          expect(reminders[0]!.record.input).toMatchObject({ every: expect.anything() });
        } finally {
          await harness.close(ctx);
        }
      });
      await evictDurableObject(stub);
    }, 30_000);

    it(`wakes and runs the reminder sleeping in ${version}, now a task of the reminders extension`, async () => {
      const owner = `fixture-run-${version}`.replace(/[^\w-]/g, "-");
      expect((await restoreInto(owner)).state).toEqual({ kind: "open" });
      const stub = env.AGENT.getByName(owner);
      // The restored agent closes its harness (as an export does), so a test agent with a faux model and a test
      // clock opens the same data beside nothing.
      await runInDurableObject(stub, (instance: MipiAgent) => instance.exportBegin());
      await runInDurableObject(stub, async (_instance, state) => {
        const [row] = state.storage.sql
          .exec<{ record: string }>(`SELECT record FROM tasks WHERE kind = '"app.reminder"'`)
          .toArray();
        const record = JSON.parse(row!.record) as {
          input: { instruction: string; destination: { kind: string; chatId?: number } };
          state: { status: string; checkpoint: { at: number; sent: number } };
        };
        expect(record.state.status).toBe("sleeping");
        expect(record.input.destination).toMatchObject({ kind: "telegram" });
        // A minute after its next time: due, and not late.
        clock.now = record.state.checkpoint.at + 60_000;
        const agent = await openAgent(
          () => openDurableObjectSqliteStorage(state.storage),
          said("Time to renew the passport."),
        );
        try {
          await agent.settle();
          expect(agent.sent).toEqual([
            { chatId: record.input.destination.chatId, text: "Time to renew the passport." },
          ]);
          const reminders = (await agent.harness.inspect(ctx)).tasks.filter(
            ({ record: task }) => task.kind === ScheduledReminder.definition.name,
          );
          expect(reminders).toHaveLength(1);
          expect(
            (reminders[0]!.record.state as { checkpoint?: { sent?: number } }).checkpoint?.sent,
          ).toBe(record.state.checkpoint.sent + 1);
        } finally {
          await agent.close();
        }
      });
      await evictDurableObject(stub);
    }, 30_000);
  }
});
