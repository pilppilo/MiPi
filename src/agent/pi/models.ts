import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";

/** pi-ai's built-in OpenCode Go provider. It reads `OPENCODE_API_KEY` and sends OpenCode's session header. */
export const MODEL_PROVIDER = "opencode-go";

/** The default model when `MIPI_MODEL` is not set: in pi-ai 1.6.0's Go catalog as "DeepSeek V4.1 Flash 1017". */
export const DEFAULT_MODEL_ID = "deepseek-v4.1-flash";

const provider = opencodeGoProvider();

/** The model access Pi Durable uses for generation, compaction, hooks, and tools. */
export const models = createModels();
models.setProvider(provider);

/** The OpenCode Go models pi-ai knows (with their compat flags and prices). */
export function goModels() {
  return provider.getModels();
}
