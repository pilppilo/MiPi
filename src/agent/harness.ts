import {
  configure,
  createRegistry,
  defineExtension,
  section,
  type HarnessOptions,
} from "./pi/durable.ts";
import { compactionSettings } from "./pi/compaction.ts";
import { STAMP_INSTRUCTIONS } from "./stamp.ts";
import {
  createGoModels,
  DEFAULT_MODEL_ID,
  goModels,
  MODEL_PROVIDER,
  type ReadEnv,
} from "./pi/models.ts";
import { ConversationMeta } from "./conversations.ts";
import { DEFAULT_PROFILE, type ProfileName, profileTools, toolsFor } from "./profiles.ts";
import { ScheduledReminder } from "../tools/reminder-task.ts";
import { DeliverScheduledInstruction } from "../tools/schedule-task.ts";
import { conversationSearchExtension } from "../tools/search.ts";
import { proactiveExtension, RecordRun, RoundBudget } from "./proactive.ts";

/** MiPi's own durable task definitions, for the startup guard's version check. */
export const APP_TASKS = [
  DeliverScheduledInstruction,
  ScheduledReminder,
  RecordRun,
  RoundBudget,
] as const;

export interface HarnessConfig {
  /** OpenCode Go model id for new conversations (`MIPI_MODEL`). */
  readonly modelId?: string;
  /** Reads Worker bindings, for model API keys (`OPENCODE_API_KEY`). Default: none, so models are unauthenticated. */
  readonly readEnv?: ReadEnv;
  /** The tool profile new top-level conversations start on (`MIPI_PROFILE`). Default: `default`. */
  readonly profile?: ProfileName;
  /** Tests only: other model access and default model. */
  readonly models?: HarnessOptions["models"];
  readonly model?: { readonly provider: string; readonly modelId: string };
}

/**
 * The one cache policy, for every conversation and every door. `long` asks for the longest retention a model's
 * provider supports (Anthropic-format: 1h `cache_control`; OpenAI-format: `prompt_cache_retention: 24h`), and is
 * ignored where it isn't (DeepSeek on Go caches identical prefixes on its own). Compaction requests use `none`.
 */
// pi-ledger L6: "long" is a 5-minute TTL for Go's Anthropic-format models until pi-ai adds the flag.
export const CACHE_RETENTION = "long" as const;

/** MiPi's agent composition: platform-independent, so tests can open it beside the Durable Object. */
export function createHarnessOptions(config: HarnessConfig = {}): HarnessOptions {
  const chatExtension = defineExtension({
    name: "chat",
    // The legacy delivery task stays for schedules stored before reminders (M6).
    tasks: [DeliverScheduledInstruction, ScheduledReminder],
    // Registration only: what a conversation is offered comes from its profile (`toolsFor`).
    tools: profileTools(),
    sections: [
      // pi-ledger L3. Static: the system prompt never changes between requests, so the provider's prompt cache keeps the prefix.
      // The time comes with each message instead (`stamp.ts`).
      section(
        "preamble",
        () => `You are MiPi, a concise personal assistant. ${STAMP_INSTRUCTIONS}`,
        {
          tag: false,
        },
      ),
    ],
  });
  const profile = config.profile ?? DEFAULT_PROFILE;
  const registry = createRegistry();
  registry.install(chatExtension);
  registry.install(conversationSearchExtension);
  registry.install(proactiveExtension);
  const defaultAgent = {
    model: config.model ?? {
      provider: MODEL_PROVIDER,
      modelId: config.modelId || DEFAULT_MODEL_ID,
    },
    // The default model has no `off` level; `low` is its lightest.
    thinkingLevel: "low" as const,
    tools: toolsFor(profile),
  };

  return {
    models: config.models ?? createGoModels(config.readEnv ?? (() => undefined)),
    registry,
    settings: {
      // `proactive` hooks every run; its tasks act only on runs that answer a reminder.
      extensions: [chatExtension, proactiveExtension],
      compaction: compactionSettings(goModels()),
      stream: { cacheRetention: CACHE_RETENTION },
      // Every input queued behind a running turn joins the next turn together, whichever door it came through, so a
      // burst gets one answer instead of one turn per message.
      followUpMode: "all",
    },
    // New top-level conversations start on the configured profile; a channel binding may switch it in the same commit.
    // Forks keep their parent's agent and profile, and subagents are configured by the tool that creates them.
    conversationCreated: async (tx, conversation) => {
      if (conversation.owner !== undefined || conversation.parent !== undefined) return;
      await configure(tx, conversation.id, defaultAgent);
      (await tx.doc(ConversationMeta, conversation.id)).profile = profile;
    },
  };
}
