import { createModels, type MutableModels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";

/** pi-ai's built-in OpenCode Go provider. It reads `OPENCODE_API_KEY` and sends OpenCode's session header. */
export const MODEL_PROVIDER = "opencode-go";

/** The default model when `MIPI_MODEL` is not set: in pi-ai 1.6.0's Go catalog as "DeepSeek V4.1 Flash 1017". */
export const DEFAULT_MODEL_ID = "deepseek-v4.1-flash";

/** Reads one Worker binding (var or secret) by name. */
export type ReadEnv = (name: string) => string | undefined;

/** The OpenCode Go models pi-ai knows (with their compat flags and prices). */
export function goModels() {
  return opencodeGoProvider().getModels();
}

/**
 * The model access Pi Durable uses for generation, compaction, hooks, and tools. pi-ai's default auth context reads
 * `globalThis.process.env`, which a Worker only has with Node compatibility turned on; here keys come straight from the
 * Worker's own bindings instead, so `OPENCODE_API_KEY` resolves without `nodejs_compat`.
 */
// pi-ledger L1: keys from Worker bindings, not process.env.
export function createGoModels(readEnv: ReadEnv): MutableModels {
  const models = createModels({
    authContext: {
      env: async (name) => {
        const value = readEnv(name);
        return typeof value === "string" && value.trim().length > 0 ? value : undefined;
      },
      // No files in a Worker.
      fileExists: async () => false,
    },
  });
  models.setProvider(opencodeGoProvider());
  return models;
}
