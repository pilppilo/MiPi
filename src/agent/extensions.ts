/**
 * The MiPi extension contract (COD-208, COD-209). A MiPi extension is a Pi Durable extension (`pi`: tools, sections,
 * hooks, wraps, tasks) plus what Pi Durable doesn't model: its tier, whether a later extension may replace it, its
 * prompt slot, the tools whose output is untrusted, the request-id prefixes it builds (origin), the wake sources it
 * runs in the background, and the provider pieces it adds (usage, model list). There is no second registry: tools and
 * sections reach the model only through Pi Durable. An extension with only agent-wide pieces (a provider's) has no
 * Pi Durable part (COD-212): it is never in a conversation's selection and can't be switched off.
 *
 * Every extension is always installed, so the tasks and documents it stored keep resolving. What a conversation uses
 * is its selection: one default list core builds here (core's own extensions first, then the rest by slot and name),
 * which a conversation edits only with `{ remove }` (`selectExtensions`), so the prompt prefix never depends on order.
 *
 * Core code: it names no extension and no door.
 */
import type { MutableModels } from "./pi/ai.ts";
import type { Extension, Harness, ToolRegistration, Tx } from "./pi/durable.ts";
import type { OriginRegistration, Origins } from "./origin.ts";
import type { ProviderRegistration } from "./providers.ts";
import type { ReportSourceError, WakeSource } from "./wake-sources.ts";
import type { DiagSink } from "./diag.ts";

/** `builtin` ships on by default; `optional` is added at build time (an npm extension is one too, on Workers). */
export type ExtensionTier = "builtin" | "optional";

/** Where an extension's prompt sections go, after core's: static text, then memory, then what changes most. */
export type SectionSlot = "static" | "memory" | "dynamic";

const SLOT_ORDER: readonly SectionSlot[] = ["static", "memory", "dynamic"];

/** What an extension's background work gets when the agent opens. */
export interface BackgroundContext {
  readonly harness: Harness;
  readonly origins: Origins;
  readonly models: MutableModels;
  /** Tools whose output is untrusted (`ResolvedExtensions.untrustedTools`). */
  readonly untrustedTools: ReadonlySet<string>;
  /** The source's wake changed: the alarm is set again. */
  readonly onWakeChange: () => void;
  readonly report: (message: string, error: unknown, details?: Record<string, unknown>) => void;
  /** The agent's diagnostic log: the extension tags its events `source: "ext:<name>"`. */
  readonly diag: DiagSink;
}

/**
 * A wake source an extension runs. `prepare` is awaited while the agent opens, before the alarm is first set, so the
 * source's first wake is in that write (the memory pass's first look).
 */
export interface ExtensionSource extends WakeSource {
  prepare?(): Promise<void>;
}

export interface ScheduledWork {
  readonly id: string;
  readonly dueAt: number;
  readonly repeating: boolean;
  /** A known hold, not an overdue alarm: its bot is archived (COD-198), so it skips or parks when due. */
  readonly held?: "archived";
}

export type ScheduleReader = (tx: Tx) => Promise<readonly ScheduledWork[]>;

export interface MipiExtension {
  /** Unique among installed extensions; also the name of `pi`, when it has one. */
  readonly name: string;
  readonly tier: ExtensionTier;
  /**
   * Pi-style (`omitReplacedExtensions`): dropped from the default selection when a non-replaceable extension registers
   * one of its tool names. It stays installed, so its sleeping tasks and documents still resolve.
   */
  readonly replaceable?: boolean;
  /** Where its sections go. Default: `static`. */
  readonly slot?: SectionSlot;
  /** The Pi Durable extension: selected by default. None for an extension with only agent-wide pieces. */
  readonly pi?: Extension;
  /** Installed but never selected by default: Pi Durable extensions for its own subagents. */
  readonly helpers?: readonly Extension[];
  /** Tools whose results are untrusted (a fetched page): a run that called one can't write memory. */
  readonly untrustedTools?: readonly string[];
  /**
   * The request-id prefixes its inputs use (the reminders' `sched`). Registered even when the extension is replaced:
   * the ids it stored still mean the same.
   */
  readonly origins?: readonly OriginRegistration[];
  /** Background work that needs the alarm. Not started for an extension that was replaced. */
  readonly wakeSources?: (context: BackgroundContext) => readonly ExtensionSource[];
  /** Read-only schedule health for an active extension. */
  readonly schedules?: ScheduleReader;
  /** A provider's usage reader and model list (`providers.ts`). Not registered for an extension that was replaced. */
  readonly providers?: readonly ProviderRegistration[];
}

/** One replacement, for the startup report and the admin status. */
export type Replacement = {
  readonly replaced: string;
  readonly by: string;
  /** The tool name both register. */
  readonly tool: string;
};

/** The extensions as the agent runs them. */
export interface ResolvedExtensions {
  /** In use: installed and not replaced, in default order. */
  readonly active: readonly MipiExtension[];
  readonly replacements: readonly Replacement[];
  /** Every Pi Durable extension to install: core's, every extension's (replaced ones too) and their helpers. */
  readonly installed: readonly Extension[];
  /** The default selection: core's own first, then the active extensions by slot and name, then core's gates. */
  readonly selection: readonly Extension[];
  /** Names a conversation may switch off: the active extensions with a Pi Durable part, never core's own. */
  readonly switchable: readonly string[];
  /** Every tool any installed extension registers, by name: the first registration wins, core's first. */
  readonly tools: ReadonlyMap<string, ToolRegistration>;
  /**
   * Every extension's untrusted tools, a replaced one's too: what it fetched is still in the stored entries, and a
   * replacement doesn't make an old page trusted. A replacement that registers the same name and doesn't declare it
   * untrusted therefore still has its results kept out of memory.
   */
  readonly untrustedTools: ReadonlySet<string>;
}

const toolNames = (extension: Extension | undefined): string[] =>
  (extension?.tools ?? []).map(({ name }) => name);

/** An extension's Pi Durable part, as a list: empty when it has none. */
const piOf = (extension: MipiExtension): Extension[] =>
  extension.pi === undefined ? [] : [extension.pi];

/**
 * Applies the contract to `core` (core's own Pi Durable extensions, never replaced or switched off) and `extensions`:
 * replacement by Pi's rule, then the default order. A name used twice, or a tool two non-replaceable extensions both
 * register, is a wiring mistake and throws, so the agent refuses to open rather than run half of it.
 *
 * `coreLast` are core's own extensions that go after every other in the selection, so their hooks run last: the
 * approval gate, which must see the arguments a call will run with, after any extension's `beforeTool` rewrote them.
 * They register no tools and no sections, so their place never moves the prompt prefix.
 */
export function resolveExtensions(
  core: readonly Extension[],
  extensions: readonly MipiExtension[],
  coreLast: readonly Extension[] = [],
): ResolvedExtensions {
  for (const extension of coreLast) {
    if ((extension.tools ?? []).length > 0 || (extension.sections ?? []).length > 0) {
      throw new Error(
        `Core extension "${extension.name}" goes last, so it can't add tools or sections`,
      );
    }
  }
  const names = new Set<string>();
  for (const name of [
    ...[...core, ...coreLast].map(({ name }) => name),
    ...extensions.flatMap(({ name, helpers }) => [name, ...(helpers ?? []).map((h) => h.name)]),
  ]) {
    if (names.has(name)) throw new Error(`Extension name "${name}" is used twice`);
    names.add(name);
  }
  for (const extension of extensions) {
    if (extension.pi !== undefined && extension.pi.name !== extension.name) {
      throw new Error(
        `Extension "${extension.name}" wraps a Pi Durable extension named "${extension.pi.name}"`,
      );
    }
  }

  // Who keeps each tool name: core and non-replaceable extensions. Two of them on one name is a conflict.
  const keepers = new Map<string, string>();
  const keep = (owner: string, tool: string) => {
    const other = keepers.get(tool);
    if (other !== undefined) {
      throw new Error(`Tool "${tool}" is registered by both "${other}" and "${owner}"`);
    }
    keepers.set(tool, owner);
  };
  for (const extension of core) for (const tool of toolNames(extension)) keep(extension.name, tool);
  for (const extension of extensions) {
    if (extension.replaceable !== true) {
      for (const tool of toolNames(extension.pi)) keep(extension.name, tool);
    }
  }

  // A replaceable extension sharing a tool name with a keeper is dropped whole, whatever the load order.
  const replacements: Replacement[] = [];
  const kept: MipiExtension[] = [];
  for (const extension of extensions) {
    if (extension.replaceable !== true) {
      kept.push(extension);
      continue;
    }
    const tool = toolNames(extension.pi).find((name) => keepers.has(name));
    if (tool === undefined) kept.push(extension);
    else replacements.push({ replaced: extension.name, by: keepers.get(tool)!, tool });
  }
  // Two replaceable extensions left on one tool name: neither replaces the other, so it's a conflict.
  const replaceableTools = new Map<string, string>();
  for (const extension of kept) {
    if (extension.replaceable !== true) continue;
    for (const tool of toolNames(extension.pi)) {
      const other = replaceableTools.get(tool);
      if (other !== undefined) {
        throw new Error(`Tool "${tool}" is registered by both "${other}" and "${extension.name}"`);
      }
      replaceableTools.set(tool, extension.name);
    }
  }

  const slotOf = (extension: MipiExtension) => SLOT_ORDER.indexOf(extension.slot ?? "static");
  const active = [...kept].sort(
    (a, b) => slotOf(a) - slotOf(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  const installed = [
    ...core,
    ...extensions.flatMap((extension) => [...piOf(extension), ...(extension.helpers ?? [])]),
    ...coreLast,
  ];
  const tools = new Map<string, ToolRegistration>();
  const selection = [...core, ...active.flatMap(piOf), ...coreLast];
  for (const extension of selection) {
    for (const tool of extension.tools ?? []) if (!tools.has(tool.name)) tools.set(tool.name, tool);
  }
  const untrustedTools = new Set<string>();
  for (const extension of extensions) {
    const registered = new Set(
      [...piOf(extension), ...(extension.helpers ?? [])].flatMap((pi) => toolNames(pi)),
    );
    for (const tool of extension.untrustedTools ?? []) {
      // A misspelt name would switch the guard off without a word, so it refuses to compose.
      if (!registered.has(tool)) {
        throw new Error(
          `Extension "${extension.name}" declares "${tool}" untrusted but registers no such tool`,
        );
      }
      untrustedTools.add(tool);
    }
  }
  return {
    active,
    replacements,
    installed,
    selection,
    switchable: active.flatMap((extension) => (extension.pi === undefined ? [] : [extension.name])),
    tools,
    untrustedTools,
  };
}

/** Every durable task of the installed extensions: what the startup guard checks stored tasks against. */
export function collectTasks(installed: readonly Extension[]): NonNullable<Extension["tasks"]> {
  return installed.flatMap((extension) => extension.tasks ?? []);
}

export type { ReportSourceError };
