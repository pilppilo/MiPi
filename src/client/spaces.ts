/**
 * Spaces (COD-249, D · Spaces): the app's navigation. The drawer, the sidebar and (on a phone) the bottom tabs list
 * the same spaces. Each space names the capabilities it needs (COD-246), and shows only when the agent advertises
 * them: an agent without them has one space fewer, never a broken screen. Chat needs nothing; it is the door itself.
 */

export type SpaceId = "chat" | "workbench" | "vault";

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
  { id: "vault", label: "Vault", summary: "Manage bot secrets", requires: ["vault"] },
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

/** `?space=<id>` on the page: a link straight into a space. Anything unknown, or nothing, is Chat. */
export function spaceFromSearch(search: string): SpaceId {
  const named = new URLSearchParams(search).get("space");
  return SPACES.find(({ id }) => id === named)?.id ?? "chat";
}

/** The link to a conversation in a space. Chat is the default, so its links stay bare. */
export const conversationHref = (conversationId: number, space: SpaceId): string =>
  space === "chat"
    ? `?conversation=${conversationId}`
    : `?conversation=${conversationId}&space=${space}`;
