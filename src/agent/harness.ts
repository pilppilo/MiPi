import {
  configure,
  createRegistry,
  defineExtension,
  type Extension,
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
import { ConversationMeta, setExtensionsOff } from "./conversations.ts";
import {
  collectTasks,
  type MipiExtension,
  type ResolvedExtensions,
  resolveExtensions,
} from "./extensions.ts";
import { DEFAULT_PROFILE, type ProfileName, Profiles, type ProfileTable } from "./profiles.ts";
import { proactiveExtension } from "./proactive.ts";

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
  /** The built-in and optional extensions, from the composition root (`composition.ts`). */
  readonly extensions: readonly MipiExtension[];
  /** Which tools each profile offers, from the composition root. */
  readonly profiles: ProfileTable;
}

/** Core's own extension: the static preamble. Always selected, first. */
export const coreExtension: Extension = defineExtension({
  name: "chat",
  sections: [
    // pi-ledger L3. Static: the system prompt never changes between requests, so the provider's prompt cache keeps the prefix.
    // The time comes with each message instead (`stamp.ts`).
    section("preamble", () => `You are MiPi, a concise personal assistant. ${STAMP_INSTRUCTIONS}`, {
      tag: false,
    }),
  ],
});

/**
 * Core's own Pi Durable extensions, in order: the preamble, then proactive runs (the run cap and answer settlement).
 * Never replaced, never switched off. `chat` keeps its name from before COD-209, when it held every tool too.
 */
export const CORE_EXTENSIONS: readonly Extension[] = [coreExtension, proactiveExtension];

/** The agent as composed: Pi Durable's options, plus what the Durable Object and the doors need from it. */
export interface AgentComposition {
  readonly options: HarnessOptions;
  readonly extensions: ResolvedExtensions;
  readonly profiles: Profiles;
  /** Every durable task of the installed extensions: the startup guard's version check (`APP_TASKS` before COD-209). */
  readonly tasks: ReturnType<typeof collectTasks>;
  /**
   * Switches extensions off for one conversation: the whole list (empty: none off). Throws for a name that isn't
   * switchable, such as core's own.
   */
  switchOff(
    tx: Parameters<typeof configure>[0],
    conversationId: Parameters<typeof configure>[1],
    names: readonly string[],
  ): Promise<void>;
}

/**
 * The one cache policy, for every conversation and every door. `long` asks for the longest retention a model's
 * provider supports (Anthropic-format: 1h `cache_control`; OpenAI-format: `prompt_cache_retention: 24h`), and is
 * ignored where it isn't (DeepSeek on Go caches identical prefixes on its own). Compaction requests use `none`.
 */
// pi-ledger L6: "long" is a 5-minute TTL for Go's Anthropic-format models until pi-ai adds the flag.
export const CACHE_RETENTION = "long" as const;

/** MiPi's agent composition: platform-independent, so tests can open it beside the Durable Object. */
export function composeAgent(config: HarnessConfig): AgentComposition {
  const extensions = resolveExtensions(CORE_EXTENSIONS, config.extensions);
  const profiles = new Profiles(config.profiles, extensions.tools);
  const profile = config.profile ?? DEFAULT_PROFILE;
  const registry = createRegistry();
  // Every extension is installed, a replaced one too, so the tasks and documents it stored keep resolving.
  for (const extension of extensions.installed) registry.install(extension);
  const defaultAgent = {
    model: config.model ?? {
      provider: MODEL_PROVIDER,
      modelId: config.modelId || DEFAULT_MODEL_ID,
    },
    // The default model has no `off` level; `low` is its lightest.
    thinkingLevel: "low" as const,
    tools: profiles.toolsFor(profile),
  };
  const switchable = new Map(
    extensions.active.map((extension) => [extension.name, extension.pi] as const),
  );

  const options: HarnessOptions = {
    models: config.models ?? createGoModels(config.readEnv ?? (() => undefined)),
    registry,
    settings: {
      // The default selection, in the order core fixes: a conversation edits it only by `{ remove }`.
      extensions: [...extensions.selection],
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
  return {
    options,
    extensions,
    profiles,
    tasks: collectTasks(extensions.installed),
    switchOff: async (tx, conversationId, names) => {
      const off = names.map((name) => {
        const extension = switchable.get(name);
        if (extension === undefined) throw new Error(`Extension "${name}" can't be switched off`);
        return extension;
      });
      await setExtensionsOff(tx, conversationId, off);
    },
  };
}
