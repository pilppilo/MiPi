import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { ScheduledReminder } from "../src/tools/reminder-task.ts";
import { DeliverScheduledInstruction } from "../src/tools/schedule-task.ts";
import { scheduleTool } from "../src/tools/schedule.ts";

describe("custom tools", () => {
  it("creates a background reminder task per schedule, once or repeating", async () => {
    const context = BACKGROUND_CONTEXT;
    const at = new Date(Date.now() + 30 * 60_000).toISOString();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("schedule", { instruction: "Check the oven", at }),
          fauxToolCall("schedule", { instruction: "Look outside", when: "every weekday 8:00" }),
          fauxToolCall("schedule", { instruction: "Stretch", delaySeconds: 5 }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Both are scheduled.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "schedule",
        tasks: [DeliverScheduledInstruction, ScheduledReminder],
        tools: [scheduleTool],
      }),
    );
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    try {
      const root = await harness.root(context);
      await root.configure(
        { model: { provider: "faux", modelId: "faux-1" }, tools: [scheduleTool] },
        context,
      );

      const before = Date.now();
      const submission = await root.submit({ type: "input", content: "Remind me" }, context);
      await submission.wait(context);

      const tasks = (await harness.inspect(context)).tasks
        .filter(({ record }) => record.kind === ScheduledReminder.definition.name)
        .map(({ record }) => record);
      const inputs = tasks.map(({ input }) => input as { instruction: string; first: number });
      // No owner time zone recorded in this harness: the default zone. Made on the web: answered there.
      const common = {
        id: expect.stringMatching(/^reminder:\d+$/),
        conversationId: root.id,
        zone: "America/Chicago",
        destination: { kind: "web", conversationId: root.id },
      };
      expect(inputs).toEqual(
        expect.arrayContaining([
          { ...common, instruction: "Check the oven", first: Date.parse(at) },
          {
            ...common,
            instruction: "Look outside",
            first: expect.any(Number),
            every: { at: "08:00", days: [1, 2, 3, 4, 5] },
          },
          { ...common, instruction: "Stretch", first: expect.any(Number) },
        ]),
      );
      const delayed = inputs.find(({ instruction }) => instruction === "Stretch")!;
      expect(delayed.first).toBeGreaterThanOrEqual(before + 5_000);
      expect(delayed.first).toBeLessThanOrEqual(Date.now() + 5_000);
      expect(tasks.map(({ owner, background }) => ({ owner, background }))).toEqual([
        { owner: undefined, background: true },
        { owner: undefined, background: true },
        { owner: undefined, background: true },
      ]);
    } finally {
      await harness.close(context);
    }
  });

  it("rejects ambiguous or unusable schedule times without creating tasks", async () => {
    const context = BACKGROUND_CONTEXT;
    const calls: Array<Parameters<typeof fauxToolCall>[1]> = [
      { instruction: "Neither" },
      { instruction: "Both", delaySeconds: 5, at: new Date(Date.now() + 60_000).toISOString() },
      { instruction: "Local time", at: "2099-01-01T09:00:00" },
      { instruction: "Unreadable", when: "soonish" },
      { instruction: "Too often", when: "every 5m" },
      { instruction: "Trailing words", when: "in 10m and then some" },
      { instruction: "Two times", delaySeconds: 5, when: "in 10m" },
      { instruction: "Past", at: new Date(Date.now() - 60_000).toISOString() },
    ];
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        calls.map((args, index) => fauxToolCall("schedule", args, { id: `call-${index}` })),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("None could be scheduled.")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "schedule",
        tasks: [DeliverScheduledInstruction, ScheduledReminder],
        tools: [scheduleTool],
      }),
    );
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
    try {
      const root = await harness.root(context);
      await root.configure(
        { model: { provider: "faux", modelId: "faux-1" }, tools: [scheduleTool] },
        context,
      );

      await (
        await root.submit({ type: "input", content: "Schedule these" }, context)
      ).wait(context);

      const results = (await root.context(context)).messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(results).toHaveLength(calls.length);
      expect(results.every((result) => result.isError)).toBe(true);
      expect(
        (await harness.inspect(context)).tasks.filter(
          ({ record }) =>
            record.kind === DeliverScheduledInstruction.definition.name ||
            record.kind === ScheduledReminder.definition.name,
        ),
      ).toEqual([]);
    } finally {
      await harness.close(context);
    }
  });
});
