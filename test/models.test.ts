import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  createGoModels,
  DEFAULT_MODEL_ID,
  goModels,
  MODEL_PROVIDER,
} from "../src/agent/pi/models.ts";

const fromBindings = (name: string): string | undefined => {
  const value: unknown = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
};

describe("OpenCode Go key resolution in the Worker", () => {
  it("resolves OPENCODE_API_KEY from the Worker's bindings", async () => {
    const models = createGoModels(fromBindings);
    const model = goModels().find(({ id }) => id === DEFAULT_MODEL_ID)!;

    const auth = await models.getAuth(model);

    // vitest.config.ts binds this test key, the way `wrangler secret put` binds the real one.
    expect(auth?.auth).toMatchObject({ apiKey: "test-opencode-key" });
    expect(auth?.source).toBe("OPENCODE_API_KEY");
  });

  it("is unconfigured when the key is missing or blank", async () => {
    for (const readEnv of [() => undefined, () => "   "]) {
      const auth = await createGoModels(readEnv).getAuth(MODEL_PROVIDER);
      expect(auth).toBeUndefined();
    }
  });
});
