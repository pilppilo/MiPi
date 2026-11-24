/**
 * OpenCode Go's live model list, moved out of core in COD-212. Core's `ModelList` narrows pi-ai's Go catalog to the
 * ids this list serves.
 */
import type { FetchLike, ModelListSource } from "../../../agent/providers.ts";
import { goModels, MODEL_PROVIDER, type ReadEnv } from "../../../agent/pi/models.ts";

/** OpenCode Go's model list (OpenAI-shaped: `{ data: [{ id }] }`). */
export const GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";

/** The ids OpenCode Go serves now. Throws with a short reason when the list can't be read. */
export async function fetchLiveGoModelIds(
  apiKey: string | undefined,
  fetcher: FetchLike = fetch,
): Promise<string[]> {
  const response = await fetcher(GO_MODELS_URL, {
    headers: apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`OpenCode Go's model list answered ${response.status}`);
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data))
    throw new Error("OpenCode Go's model list has an unexpected shape");
  return body.data.flatMap((item: unknown) =>
    typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string"
      ? [(item as { id: string }).id]
      : [],
  );
}

/** Go's model list, read with the model key. */
export function goModelListSource(readEnv: ReadEnv): ModelListSource {
  return {
    provider: MODEL_PROVIDER,
    label: "OpenCode Go",
    catalog: () => goModels().map((model) => ({ id: model.id, name: model.name })),
    liveIds: (fetcher) => fetchLiveGoModelIds(readEnv("OPENCODE_API_KEY"), fetcher),
  };
}
