import {
  configure,
  createRegistry,
  defineExtension,
  section,
  type HarnessOptions,
} from "./pi/durable.ts";
import { compactionSettings } from "./pi/compaction.ts";
import {
  createGoModels,
  DEFAULT_MODEL_ID,
  goModels,
  MODEL_PROVIDER,
  type ReadEnv,
} from "./pi/models.ts";
import { DeliverScheduledInstruction } from "../tools/schedule-task.ts";
import { conversationSearchExtension, searchHistoryTool } from "../tools/search.ts";
import { scheduleTool } from "../tools/schedule.ts";

/** MiPi's own durable task definitions, for the startup guard's version check. */
export const APP_TASKS = [DeliverScheduledInstruction] as const;

export interface HarnessConfig {
  /** OpenCode Go model id for new conversations (`MIPI_MODEL`). */
  readonly modelId?: string;
  /** Reads Worker bindings, for model API keys (`OPENCODE_API_KEY`). Default: none, so models are unauthenticated. */
  readonly readEnv?: ReadEnv;
}

/** MiPi's agent composition: platform-independent, so tests can open it beside the Durable Object. */
export function createHarnessOptions(config: HarnessConfig = {}): HarnessOptions {
  const chatExtension = defineExtension({
    name: "chat",
    tasks: [DeliverScheduledInstruction],
    tools: [scheduleTool, searchHistoryTool],
    sections: [
      section(
        "preamble",
        () =>
          "You are MiPi, a concise personal assistant. User messages may begin with a display name in brackets; treat it as speaker attribution.",
        { tag: false },
      ),
      section(
        "clock",
        // Minute precision: finer values would append a system-prompt delta on every request.
        () => `Current time: ${new Date().toISOString().slice(0, 16)}Z.`,
        { tag: false },
      ),
    ],
  });
  const registry = createRegistry();
  registry.install(chatExtension);
  registry.install(conversationSearchExtension);
  const defaultAgent = {
    model: { provider: MODEL_PROVIDER, modelId: config.modelId || DEFAULT_MODEL_ID },
    // The default model has no `off` level; `low` is its lightest.
    thinkingLevel: "low" as const,
    tools: [scheduleTool, searchHistoryTool],
  };

  return {
    models: createGoModels(config.readEnv ?? (() => undefined)),
    registry,
    settings: { extensions: [chatExtension], compaction: compactionSettings(goModels()) },
    conversationCreated: (tx, conversation) =>
      conversation.owner === undefined && conversation.parent === undefined
        ? configure(tx, conversation.id, defaultAgent)
        : undefined,
  };
}
