/**
 * The Spaces shell's small marks (COD-244, D · Spaces): a bot's mark, a rounded square in its own colour that glows
 * while the bot works and fades while it sleeps, and the shell's line icons.
 */
import type { SpaceId } from "./spaces.ts";
import type { CSSProperties } from "react";
import type { ConversationSummary } from "../protocol.ts";
import type { BotActivity } from "./session/bots-list.ts";

/** Wide enough for the sidebar beside the chat: below it, the drawer slides in from the left. */
export const WIDE_LAYOUT = "(width >= 44rem)";

/** MiPi's own hue, the indigo of the mock; any other bot's comes from its id, so it stays the same everywhere. */
const MAIN_HUE = 246;

export const botHue = (summary: ConversationSummary): number =>
  summary.kind === "main" ? MAIN_HUE : (summary.id * 97 + 20) % 360;

/** What a bot is doing, in words: it works, waits on something, or sleeps until it's needed. */
export const botStatusLabel = (activity: BotActivity | undefined): string =>
  activity === "running" ? "Working" : activity === "waiting" ? "Waiting" : "Asleep";

export function BotMark({
  summary,
  activity,
  size = "small",
}: {
  readonly summary: ConversationSummary;
  readonly activity: BotActivity | undefined;
  readonly size?: "small" | "large";
}) {
  const state = activity === "running" ? "awake" : activity === "waiting" ? "waiting" : "asleep";
  return (
    <span
      className={`bot-mark bot-mark--${size} bot-mark--${state}`}
      style={{ "--bot-hue": botHue(summary) } as CSSProperties}
      aria-hidden="true"
    />
  );
}

const icon = {
  width: 20,
  height: 20,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export const MenuIcon = () => (
  <svg {...icon}>
    <path d="M6 9h12M6 15h12" />
  </svg>
);

export const SettingsIcon = () => (
  <svg {...icon}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" />
  </svg>
);

export const SendIcon = () => (
  <svg {...icon}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </svg>
);

export const CloseIcon = () => (
  <svg {...icon}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const ChatIcon = () => (
  <svg {...icon}>
    <path d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V16h0a2.5 2.5 0 0 1-2-2.45z" />
  </svg>
);

export const WorkbenchIcon = () => (
  <svg {...icon}>
    <rect x="4" y="4" width="7" height="7" rx="2" />
    <rect x="13" y="4" width="7" height="7" rx="2" />
    <rect x="4" y="13" width="7" height="7" rx="2" />
    <path d="M13 16.5h7M16.5 13v7" />
  </svg>
);

export const VaultIcon = () => (
  <svg {...icon}>
    <rect x="4" y="10" width="16" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v2" />
  </svg>
);

/** A space's icon by id (`spaces.ts`). */
export function SpaceIcon({ id }: { readonly id: SpaceId }) {
  switch (id) {
    case "chat":
      return <ChatIcon />;
    case "workbench":
      return <WorkbenchIcon />;
    case "vault":
      return <VaultIcon />;
    default: {
      const _: never = id;
      return null;
    }
  }
}
