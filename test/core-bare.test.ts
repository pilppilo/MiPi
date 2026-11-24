/**
 * Bare core (COD-209): the agent opens and works with no extensions installed, which proves core depends on none of
 * them (Pi's SDK sessions load no built-ins either).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { AlarmScheduler, alarmTime, runAlarmConsumers } from "../src/agent/alarm.ts";
import { composeMipi } from "../src/agent/composition.ts";
import { boundConversation, syncProfileTools } from "../src/agent/conversations.ts";
import { WakeSources } from "../src/agent/wake-sources.ts";

const ctx = BACKGROUND_CONTEXT;

describe("bare core", () => {
  it("opens with no extensions, answers a turn with no tools and no memory section, and runs its alarm", async () => {
    const requests: Message[][] = [];
    const faux = fauxProvider();
    faux.setResponses([
      (context) => {
        requests.push(structuredClone(context.messages));
        return fauxAssistantMessage([fauxText("Hello.")]);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    // The default profile still names five tools; none is installed, so none is offered.
    const composition = composeMipi({
      extensions: [],
      models,
      model: { provider: "faux", modelId: "faux-1" },
    });
    expect(composition.extensions.selection.map(({ name }) => name)).toEqual(["chat", "proactive"]);
    expect(composition.profiles.toolsFor("default")).toEqual([]);
    expect(composition.tasks.map(({ definition }) => definition.name).sort()).toEqual([
      "app.proactive-record-run",
      "app.proactive-round-budget",
    ]);

    const harness = await Harness.open(new MemoryStorage(), composition.options, ctx);
    try {
      expect(await syncProfileTools(harness, composition.profiles)).toEqual([]);
      const id = await harness.commit(
        (tx) => boundConversation(tx, "web", "default", composition.profiles),
        ctx,
      );
      const conversation = (await harness.conversation(id, ctx))!;
      const result = await (
        await conversation.submit({ type: "input", content: "hi", requestId: "web:1" }, ctx)
      ).wait(ctx);
      expect(result.status).toBe("done");
      expect((await conversation.agent(ctx)).tools).toEqual([]);

      const system = requests[0]!.filter((message) => message.role === "system");
      const sections = Object.assign({}, ...system.map((message) => message.sections ?? {}));
      expect(Object.keys(sections)).toContain("preamble");
      expect(Object.keys(sections)).not.toContain("memory");
      expect(system.flatMap((message) => message.toolsAdded ?? [])).toEqual([]);

      // The alarm with no wake source: set from Pi Durable's own wake alone.
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
      await harness.waitForIdle(ctx);
      expect(sources.wake()).toEqual({ active: false });
      const wake = harness.wake();
      await scheduler.schedule(wake);
      expect(writes).toEqual([alarmTime(wake, undefined, 0) ?? "deleted"]);
      // An alarm runs Pi Durable's resume and no source, then sets the alarm again.
      const ran: string[] = [];
      await runAlarmConsumers(
        [["Pi Durable resume", () => harness.resume()], ...sources.consumers()],
        (message) => ran.push(message),
        async () => {
          ran.push("rescheduled");
          await scheduler.schedule(harness.wake());
        },
      );
      expect(ran).toEqual(["rescheduled"]);
    } finally {
      await harness.close(ctx);
    }
  });
});
