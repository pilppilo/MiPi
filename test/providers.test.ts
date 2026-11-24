/// <reference types="vite/client" />
/**
 * The providers connector (COD-212): extensions register a provider's usage reader and model list; core names no
 * provider. OpenCode Go's pieces come from its optional extension.
 */
import { defineExtension } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { composeMipi } from "../src/agent/composition.ts";
import { type MipiExtension, resolveExtensions } from "../src/agent/extensions.ts";
import { coreExtensions } from "../src/agent/harness.ts";
import type { ProviderRegistration } from "../src/agent/providers.ts";
import { BUILT_IN_EXTENSIONS } from "../src/extensions/builtins.ts";
import { opencodeGoExtension } from "../src/extensions/optional/opencode-go/index.ts";

const env = (values: Record<string, string>) => (name: string) => values[name];

const usageOnly = (provider: string): ProviderRegistration => ({
  provider,
  usage: () => ({
    provider,
    label: provider,
    read: async () => ({ provider, label: provider, status: "unavailable", reason: "test" }),
  }),
});

const modelsOnly = (provider: string): ProviderRegistration => ({
  provider,
  models: () => ({ provider, label: provider, catalog: () => [], liveIds: async () => [] }),
});

const providerExtension = (
  name: string,
  providers: readonly ProviderRegistration[],
  more: Partial<MipiExtension> = {},
): MipiExtension => ({ name, tier: "optional", providers, ...more });

describe("providers connector", () => {
  it("registers OpenCode Go's usage reader and model list from its optional extension", () => {
    const { providers, extensions } = composeMipi();
    expect(extensions.active.map(({ name }) => name)).toContain("opencode-go");
    expect(providers.modelSources(env({})).map(({ provider }) => provider)).toEqual([
      "opencode-go",
    ]);
    // No key: no usage reader.
    expect(providers.usageSources(env({}))).toEqual([]);
    expect(
      providers.usageSources(env({ OPENCODE_API_KEY: "k" })).map(({ label }) => label),
    ).toEqual(["OpenCode Go"]);
  });

  it("bare core has no providers", () => {
    const { providers } = composeMipi({ extensions: [] });
    expect(providers.usageSources(env({ OPENCODE_API_KEY: "k" }))).toEqual([]);
    expect(providers.modelSources(env({ OPENCODE_API_KEY: "k" }))).toEqual([]);
  });

  it("refuses to compose when one provider's usage reader or model list is registered twice, key or not", () => {
    expect(() =>
      composeMipi({
        extensions: [opencodeGoExtension, providerExtension("go-copy", [usageOnly("opencode-go")])],
      }),
    ).toThrow(
      `Provider "opencode-go"'s usage reader is registered by both "go-copy" and "opencode-go"`,
    );
    expect(() =>
      composeMipi({
        extensions: [
          opencodeGoExtension,
          providerExtension("go-copy", [modelsOnly("opencode-go")]),
        ],
      }),
    ).toThrow(
      `Provider "opencode-go"'s model list is registered by both "go-copy" and "opencode-go"`,
    );
    // Different pieces of one provider, or the same piece of two, compose.
    const { providers } = composeMipi({
      extensions: [
        providerExtension("a", [usageOnly("p")]),
        providerExtension("b", [modelsOnly("p"), usageOnly("q")]),
      ],
    });
    expect(providers.usageSources(env({})).map(({ provider }) => provider)).toEqual(["p", "q"]);
  });

  it("refuses a piece that names another provider than its registration", () => {
    const { providers } = composeMipi({
      extensions: [
        providerExtension("liar", [
          { provider: "p", models: () => ({ ...modelsOnly("q").models!(env({})) }) },
        ]),
      ],
    });
    expect(() => providers.modelSources(env({}))).toThrow(
      `A piece registered for provider "p" names "q"`,
    );
  });

  it("doesn't register a replaced extension's providers", () => {
    const keeper: MipiExtension = {
      name: "keeper",
      tier: "optional",
      pi: defineExtension({
        name: "keeper",
        tools: [
          {
            name: "shared",
            description: "test",
            parameters: { type: "object", properties: {} } as never,
            replay: "safe",
            execute: async () => ({ output: [] }),
          },
        ],
      }),
    };
    const replaced: MipiExtension = {
      ...keeper,
      name: "replaced",
      replaceable: true,
      pi: defineExtension({ name: "replaced", tools: keeper.pi!.tools }),
      providers: [modelsOnly("p")],
    };
    const { providers, extensions } = composeMipi({ extensions: [keeper, replaced] });
    expect(extensions.replacements.map(({ replaced }) => replaced)).toEqual(["replaced"]);
    expect(providers.modelSources(env({}))).toEqual([]);
  });

  it("an extension with no Pi Durable part is active but never selected, installed or switchable", () => {
    const resolved = resolveExtensions(coreExtensions(), [
      ...BUILT_IN_EXTENSIONS,
      opencodeGoExtension,
    ]);
    expect(resolved.active.map(({ name }) => name)).toContain("opencode-go");
    expect(resolved.selection.map(({ name }) => name)).not.toContain("opencode-go");
    expect(resolved.installed.map(({ name }) => name)).not.toContain("opencode-go");
    expect(resolved.switchable).not.toContain("opencode-go");
    // Its name still counts in the duplicate check.
    expect(() =>
      resolveExtensions(coreExtensions(), [opencodeGoExtension, { ...opencodeGoExtension }]),
    ).toThrow(`Extension name "opencode-go" is used twice`);
  });

  it("core names no provider: no OpenCode URL, setting or response shape outside the model seam", () => {
    // Every core source file as text, the model seam (`src/agent/pi/`) left out.
    const sources = import.meta.glob<string>(["../src/agent/**/*.ts", "!../src/agent/pi/**"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const paths = Object.keys(sources);
    expect(paths).toContain("../src/agent/model-list.ts");
    expect(paths).toContain("../src/agent/harness.ts");
    expect(paths).toContain("../src/agent/agent-do.ts");
    expect(paths.some((path) => path.startsWith("../src/agent/pi/"))).toBe(false);
    const found = Object.entries(sources).flatMap(([path, text]) =>
      [
        /opencode\.ai/i,
        /OPENCODE_/,
        /parseGoUsage|GO_USAGE_URL|GO_MODELS_URL|rate-limited/,
      ].flatMap((pattern) => (pattern.test(text) ? [`${path}: ${pattern}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
