import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Harness } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { describe, expect, it } from "vitest";
import { CACHE_RETENTION, createHarnessOptions } from "../src/agent/harness.ts";
import { localTime, ownerTimeZone, stampInput } from "../src/agent/stamp.ts";
import { formatScheduledInstruction, parseScheduledInstruction } from "../src/protocol.ts";

const ctx = BACKGROUND_CONTEXT;
const CHICAGO = "America/Chicago";

interface Request {
  readonly messages: readonly Message[];
  readonly cacheRetention: unknown;
}

/** A harness built from MiPi's real options, with a faux model that records every request it gets. */
async function recordingHarness(replies: number) {
  const requests: Request[] = [];
  const faux = fauxProvider();
  faux.setResponses(
    Array.from({ length: replies }, (_, index) => (context, options) => {
      requests.push({
        messages: structuredClone(context.messages),
        cacheRetention: (options as { cacheRetention?: unknown } | undefined)?.cacheRetention,
      });
      return fauxAssistantMessage([fauxText(`Reply ${index + 1}`)]);
    }),
  );
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    createHarnessOptions({
      models,
      model: { provider: "faux", modelId: "faux-1" },
    }),
    ctx,
  );
  return { harness, requests };
}

async function ask(harness: Harness, content: string): Promise<void> {
  const root = await harness.root(ctx);
  await (await root.submit({ type: "input", content }, ctx)).wait(ctx);
  await harness.waitForIdle(ctx);
}

const systemMessages = (messages: readonly Message[]) =>
  messages.filter(
    (message) => (message.role as string) === "system" || (message.role as string) === "developer",
  );

describe("cache-stable prompts", () => {
  it("sends each turn as the previous request plus new messages, with one cache policy", async () => {
    const { harness, requests } = await recordingHarness(3);
    try {
      // Hours apart: the prompt must not depend on the time.
      await ask(harness, stampInput("Jerome", "Hello", CHICAGO, Date.UTC(2026, 10, 22, 18, 40)));
      await ask(
        harness,
        stampInput("Jerome", "Still there?", CHICAGO, Date.UTC(2026, 10, 22, 21, 5)),
      );
      await ask(harness, stampInput("Scheduled", "Stretch", CHICAGO, Date.UTC(2026, 10, 23, 9, 0)));
    } finally {
      await harness.close(ctx);
    }

    expect(requests).toHaveLength(3);
    for (let index = 1; index < requests.length; index += 1) {
      const previous = requests[index - 1]!.messages;
      const current = requests[index]!.messages;
      // The whole earlier request is an exact prefix of the next one: nothing in it was rewritten or reordered.
      expect(current.slice(0, previous.length)).toEqual(previous);
      // And nothing new arrived as a system message between turns.
      expect(systemMessages(current)).toEqual(systemMessages(previous));
    }
    for (const { cacheRetention } of requests) expect(cacheRetention).toBe(CACHE_RETENTION);
  });

  it("keeps the time out of the system prompt", () => {
    const options = createHarnessOptions();
    const settings = typeof options.settings === "function" ? options.settings() : options.settings;
    expect(settings?.stream).toEqual({ cacheRetention: "long" });
    const preamble = settings?.extensions?.[0]?.sections?.find(({ key }) => key === "preamble");
    expect(preamble).toBeDefined();
    expect(settings?.extensions?.[0]?.sections?.some(({ key }) => key === "clock")).toBe(false);
  });
});

describe("message stamps", () => {
  it("stamp the speaker and the owner's local time", () => {
    const at = Date.UTC(2026, 10, 22, 18, 40);
    expect(localTime(at, CHICAGO)).toBe("Sun, Nov 22, 2026, 12:40 CST");
    expect(stampInput("Jerome", "Hi", CHICAGO, at)).toBe(
      "[Jerome · Sun, Nov 22, 2026, 12:40 CST]\nHi",
    );
    // Daylight saving time is the zone's, not a fixed offset.
    expect(localTime(Date.UTC(2026, 6, 4, 17, 0), CHICAGO)).toBe("Sat, Jul 4, 2026, 12:00 CDT");
    expect(localTime(at, "Europe/Helsinki")).toBe("Sun, Nov 22, 2026, 20:40 GMT+2");
    // An invalid or missing zone falls back to the default (America/Chicago).
    expect(localTime(at, "Not/AZone")).toBe("Sun, Nov 22, 2026, 12:40 CST");
    expect(localTime(at, undefined)).toBe("Sun, Nov 22, 2026, 12:40 CST");
    expect(ownerTimeZone("Europe/Helsinki")).toBe("Europe/Helsinki");
    expect(ownerTimeZone("Not/AZone")).toBe("America/Chicago");
  });

  it("stamp scheduled deliveries in a form the client still recognizes", () => {
    const scheduled = { id: "schedule:1", instruction: "Stretch" };
    const stamped = formatScheduledInstruction(scheduled, "Sun, Nov 22, 2026, 12:40 CST");
    expect(stamped).toBe("Scheduled instruction due now (Sun, Nov 22, 2026, 12:40 CST): Stretch");
    expect(parseScheduledInstruction(stamped)).toBe("Stretch");
    // Messages stored before stamps still parse.
    expect(parseScheduledInstruction(formatScheduledInstruction(scheduled))).toBe("Stretch");
    expect(parseScheduledInstruction("Scheduled instruction due now: Stretch")).toBe("Stretch");
    expect(parseScheduledInstruction("Something else")).toBeUndefined();
  });
});
