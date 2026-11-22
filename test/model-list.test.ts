import { describe, expect, it } from "vitest";
import {
  fetchLiveGoModelIds,
  GO_MODELS_URL,
  ModelList,
  pickableModels,
} from "../src/agent/model-list.ts";
import { DEFAULT_MODEL_ID } from "../src/agent/pi/models.ts";

describe("model list", () => {
  it("offers only models in both the live Go list and pi-ai's catalog", () => {
    const models = pickableModels([DEFAULT_MODEL_ID, "only-live-model"]);
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

  it("refuses ids outside the list and caches successful loads", async () => {
    let loads = 0;
    const list = new ModelList(async () => {
      loads += 1;
      return [DEFAULT_MODEL_ID];
    });
    await expect(list.require(DEFAULT_MODEL_ID)).resolves.toEqual({
      provider: "opencode-go",
      modelId: DEFAULT_MODEL_ID,
    });
    await expect(list.require("gpt-oss-imaginary")).rejects.toThrow("is not available");
    expect(loads).toBe(1);
  });

  it("does not cache a failed load", async () => {
    let fail = true;
    const list = new ModelList(async () => {
      if (fail) throw new Error("offline");
      return [DEFAULT_MODEL_ID];
    });
    await expect(list.models()).rejects.toThrow("offline");
    fail = false;
    await expect(list.models()).resolves.toHaveLength(1);
  });
});
