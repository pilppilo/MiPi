/**
 * What the web door calls things (COD-244): plain names for the agent's tools, profiles and models, in place of their
 * ids (`web_fetch`, `default`, `opencode-go/…`). Presentation only: the ids stay what the agent and the wire use, and
 * an id this list doesn't know is shown readably (`search_history` → "Search history"), never hidden. When the agent
 * sends names of its own (COD-247), they replace these.
 */
import type { Options } from "../protocol.ts";

/** A tool's name for the owner, and a line on what it lets the bot do. */
interface Named {
  readonly label: string;
  readonly summary: string;
}

const TOOLS: Readonly<Record<string, Named>> = {
  schedule: { label: "Reminders", summary: "Set reminders and repeating tasks" },
  search_history: { label: "Past chats", summary: "Look back through earlier conversations" },
  remember: { label: "Remember", summary: "Keep a fact or a preference for later" },
  forget: { label: "Forget", summary: "Drop something it was asked to remember" },
  web_fetch: { label: "Web pages", summary: "Open and read a web page" },
  create_bot: { label: "Make bots", summary: "Start a new bot with its own purpose" },
  bind_door: { label: "Connect channels", summary: "Point Telegram or the relay at a bot" },
  message_bot: { label: "Message bots", summary: "Hand work to another bot" },
  list_bots: { label: "See bots", summary: "Check which bots exist and what they do" },
  stop_bot: { label: "Stop bots", summary: "Stop a bot's running work" },
  list_cobots: { label: "See side chats", summary: "List its own side chats" },
  archive_cobot: { label: "Archive side chats", summary: "Put one of its side chats away" },
};

const PROFILES: Readonly<Record<string, string>> = {
  default: "Everyday",
  empty: "Just chat",
  main: "MiPi's toolkit",
  pidu: "PiDu relay (earlier)",
};

/** `search_history` → "Search history": a readable name for an id this list doesn't know. */
export const readable = (id: string): string => {
  const words = id
    .replace(/[_.-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words.length === 0 ? id : words[0]!.toUpperCase() + words.slice(1);
};

export const toolName = (id: string): string => TOOLS[id]?.label ?? readable(id);

export const toolSummary = (id: string): string | undefined => TOOLS[id]?.summary;

export const profileName = (id: string): string => PROFILES[id] ?? readable(id);

/** What a profile offers, as the agent describes it (`options.list`), if it does. */
export const profileSummary = (id: string, options: Options | undefined): string | undefined => {
  const description = options?.profiles.find((choice) => choice.id === id)?.name.trim();
  return description === undefined || description.length === 0 ? undefined : description;
};

/** A model as the picker names it (its catalog name), else its id without the provider. */
export const modelName = (modelId: string, options: Options | undefined): string =>
  options?.models.find(({ id }) => id === modelId)?.name ?? modelId.split("/").at(-1) ?? modelId;

const THINKING: Readonly<Record<string, string>> = {
  off: "Off",
  minimal: "Minimal",
  low: "Light",
  medium: "Medium",
  high: "Deep",
  xhigh: "Deepest",
};

export const thinkingName = (level: string): string => THINKING[level] ?? readable(level);

const TASKS: Readonly<Record<string, string>> = {
  "pi.generation": "Answering",
  "pi.tool": "Using a tool",
  "pi.compaction": "Summarising the chat so far",
  "app.reminder": "Reminder",
  "app.deliver-scheduled-instruction": "Scheduled task",
  "app.proactive-record-run": "Wrapping up a scheduled run",
  "app.proactive-round-budget": "Checking today's budget",
  "app.approval": "Waiting for your answer",
};

/** A durable task's plain name (Workbench, COD-249): `pi.generation` → "Answering". */
export const taskName = (kind: string): string =>
  TASKS[kind] ?? readable(kind.replace(/^(pi|app)\./, ""));
