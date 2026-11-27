import type { DiagInput } from "../src/agent/diag.ts";
import { describe, expect, it } from "vitest";
import { ModelList, pickableModels } from "../src/agent/model-list.ts";
import { DEFAULT_MODEL_ID } from "../src/agent/pi/models.ts";
import type { ModelListSource } from "../src/agent/providers.ts";
import {
  fetchLiveGoModelIds,
  GO_MODELS_URL,
  goModelListSource,
} from "../src/extensions/optional/opencode-go/models.ts";

/** Go's model list with `liveIds` answered by `load`. */
const goWith = (load: () => Promise<string[]>): ModelListSource => ({
  ...goModelListSource(() => undefined),
  liveIds: load,
});

describe("model list", () => {
  it("offers only models in both the live Go list and pi-ai's catalog", () => {
    const models = pickableModels(
      goModelListSource(() => undefined),
      [DEFAULT_MODEL_ID, "only-live-model"],
    );
    expect(models.map(({ id }) => id)).toEqual([DEFAULT_MODEL_ID]);
    expect(models[0]!.name.length).toBeGreaterThan(0);
  });

  it("reads the live list with the key, and fails clearly on a bad answer", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const ids = await fetchLiveGoModelIds("key-1", async (url, init) => {
      calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
      return Response.json({ data: [{ id: "a" }, { id: "b" }, { nope: 1 }] });
    });
    expect(ids).toEqual(["a", "b"]);
    expect(calls).toEqual([{ url: GO_MODELS_URL, auth: "Bearer key-1" }]);

    await expect(
      fetchLiveGoModelIds("k", async () => new Response("", { status: 401 })),
    ).rejects.toThrow("answered 401");
    await expect(fetchLiveGoModelIds("k", async () => Response.json({}))).rejects.toThrow(
      "unexpected shape",
    );
  });

  it("reads Go's list with OPENCODE_API_KEY from the settings", async () => {
    const auth: Array<string | null> = [];
    const source = goModelListSource((name) => (name === "OPENCODE_API_KEY" ? "key-2" : undefined));
    await source.liveIds(async (_url, init) => {
      auth.push(new Headers(init?.headers).get("Authorization"));
      return Response.json({ data: [] });
    });
    expect(auth).toEqual(["Bearer key-2"]);
  });

  it("refuses ids outside the list and caches successful loads", async () => {
    let loads = 0;
    const list = new ModelList([
      goWith(async () => {
        loads += 1;
        return [DEFAULT_MODEL_ID];
      }),
    ]);
    await expect(list.require(DEFAULT_MODEL_ID)).resolves.toEqual({
      provider: "opencode-go",
      modelId: DEFAULT_MODEL_ID,
    });
    await expect(list.require("gpt-oss-imaginary")).rejects.toThrow("is not available");
    expect(loads).toBe(1);
  });

  it("does not cache a failed load", async () => {
    let fail = true;
    const diag: DiagInput[] = [];
    const list = new ModelList(
      [
        goWith(async () => {
          if (fail) throw new Error("offline");
          return [DEFAULT_MODEL_ID];
        }),
      ],
      fetch,
      { emit: (event) => diag.push(event) },
    );
    await expect(list.models()).rejects.toThrow("offline");
    fail = false;
    await expect(list.models()).resolves.toHaveLength(1);
    // The failed read is an event; the good one isn't.
    expect(diag).toEqual([
      expect.objectContaining({
        source: "provider",
        kind: "provider.models_failed",
        level: "warn",
        detail: { provider: "opencode-go" },
      }),
    ]);
    expect(diag[0]!.summary).toContain("offline");
  });

  it("lists each source's models in source order, and takes a model's provider from its source", async () => {
    const other: ModelListSource = {
      provider: "other",
      label: "Other",
      catalog: () => [{ id: "o-1", name: "Other One" }],
      liveIds: async () => ["o-1"],
    };
    const list = new ModelList([goWith(async () => [DEFAULT_MODEL_ID]), other]);
    expect((await list.models()).map(({ id }) => id)).toEqual([DEFAULT_MODEL_ID, "o-1"]);
    await expect(list.require("o-1")).resolves.toEqual({ provider: "other", modelId: "o-1" });
  });

  it("with no source, lists nothing and refuses clearly", async () => {
    const list = new ModelList([]);
    await expect(list.models()).resolves.toEqual([]);
    await expect(list.require(DEFAULT_MODEL_ID)).rejects.toThrow(
      "No provider lists models in this build.",
    );
  });
});
