/**
 * Spaces (COD-249, D · Spaces): the app's navigation. The drawer, the sidebar and (on a phone) the bottom tabs list
 * the same spaces. Each space names the capabilities it needs (COD-246), and shows only when the agent advertises
 * them: an agent without them has one space fewer, never a broken screen. Chat needs nothing; it is the door itself.
 */

export type SpaceId = "chat" | "workbench";

export interface Space {
  readonly id: SpaceId;
  readonly label: string;
  /** One line on what it shows, for the drawer and screen readers. */
  readonly summary: string;
}

const SPACES: readonly (Space & { readonly requires: readonly string[] })[] = [
  { id: "chat", label: "Chat", summary: "Talk to the bot", requires: [] },
  {
    id: "workbench",
    label: "Workbench",
    summary: "What the bot is doing, waiting on, and the other bots",
    requires: ["activity"],
  },
];

/** The spaces this agent can back, in their order. Chat always. */
export function availableSpaces(capabilities: ReadonlySet<string>): readonly Space[] {
  return SPACES.filter(({ requires }) => requires.every((id) => capabilities.has(id))).map(
    ({ id, label, summary }) => ({ id, label, summary }),
  );
}

/** The space to show: the one chosen if this agent still backs it, otherwise Chat. */
export const shownSpace = (chosen: SpaceId, spaces: readonly Space[]): SpaceId =>
  spaces.some(({ id }) => id === chosen) ? chosen : "chat";

/** `?space=workbench` on the page: a link straight into a space. Anything else is Chat. */
export const spaceFromSearch = (search: string): SpaceId =>
  new URLSearchParams(search).get("space") === "workbench" ? "workbench" : "chat";
