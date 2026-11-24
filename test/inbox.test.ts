import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, InboxDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { createHarnessOptions } from "../src/agent/composition.ts";
import { queuedInputs } from "../src/protocol.ts";

const context = BACKGROUND_CONTEXT;

describe("queued prompts", () => {
  it("queues input submitted during a running turn and answers it afterwards", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const slowFirst: FauxResponseStep = async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return fauxAssistantMessage([fauxText("First answer.")]);
    };
    const faux = fauxProvider();
    faux.setResponses([slowFirst, fauxAssistantMessage([fauxText("Second answer.")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      context,
    );

    try {
      const root = await harness.root(context);
      await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
      const first = await root.submit(
        { type: "input", content: "First question", whenBusy: "followUp" },
        context,
      );
      await firstStarted.promise;

      const second = await root.submit(
        { type: "input", content: "Second question", whenBusy: "followUp" },
        context,
      );
      expect(queuedInputs(await harness.snapshot(InboxDoc, root.id, context))).toEqual([
        { submissionId: second.id, mode: "followUp", text: "Second question" },
      ]);

      releaseFirst.resolve();
      await expect(first.wait(context)).resolves.toMatchObject({ status: "done" });
      await expect(second.wait(context)).resolves.toMatchObject({ status: "done" });
      expect(queuedInputs(await harness.snapshot(InboxDoc, root.id, context))).toEqual([]);
    } finally {
      releaseFirst.resolve();
      await harness.close(context);
    }
  });

  it("answers every input queued during a turn in one next turn, for any door (followUpMode: all)", async () => {
    const releaseFirst = Promise.withResolvers<void>();
    const requests: number[] = [];
    const faux = fauxProvider();
    faux.setResponses([
      async (request) => {
        requests.push(request.messages.length);
        await releaseFirst.promise;
        return fauxAssistantMessage([fauxText("First answer.")]);
      },
      (request) => {
        requests.push(request.messages.length);
        return fauxAssistantMessage([fauxText("One answer for three.")]);
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(
      new MemoryStorage(),
      createHarnessOptions({ models, model: { provider: "faux", modelId: "faux-1" } }),
      context,
    );
    try {
      const root = await harness.root(context);
      // A web message on an idle conversation starts its turn at once.
      const first = await root.submit({ type: "input", content: "First" }, context);
      const queued = [];
      for (const content of ["Two", "Three", "Four"]) {
        queued.push(await root.submit({ type: "input", content, whenBusy: "followUp" }, context));
      }
      releaseFirst.resolve();
      await first.wait(context);
      const settled = await Promise.all(queued.map((submission) => submission.wait(context)));
      await harness.waitForIdle(context);
      // Two requests in all: the three queued inputs were placed together and got one answer.
      expect(requests).toHaveLength(2);
      const answers = new Set(
        settled.map((record) => (record.status === "done" ? record.answer : undefined)),
      );
      expect(answers.size).toBe(1);
    } finally {
      releaseFirst.resolve();
      await harness.close(context);
    }
  });
});
