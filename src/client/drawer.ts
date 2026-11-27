/**
 * The spaces drawer on narrow screens (COD-244): its open state and where focus goes as it changes. Pure, so the rules
 * are tested without a DOM; `ChatSession` applies the focus. On wide screens the drawer is the sidebar and always
 * shown, so nothing opens or closes it.
 */

export interface DrawerState {
  readonly open: boolean;
  /**
   * Where focus goes after this change: into the drawer as it opens, back to its toggle as it closes (unless the close
   * leads somewhere else, which focuses itself: a bot's conversation, Settings).
   */
  readonly focus: "drawer" | "toggle" | undefined;
}

export type DrawerAction =
  | { readonly type: "toggle" }
  /** Escape, the scrim, or the toggle while open. */
  | { readonly type: "close" }
  /** A bot or cobot picked in the drawer: its conversation takes focus. */
  | { readonly type: "picked" }
  /** Settings opened from the drawer: Settings takes focus. */
  | { readonly type: "settings" }
  /** The screen grew wide: the drawer is the sidebar now. */
  | { readonly type: "wide" };

export const DRAWER_CLOSED: DrawerState = { open: false, focus: undefined };

export function drawerReducer(state: DrawerState, action: DrawerAction): DrawerState {
  switch (action.type) {
    case "toggle":
      return state.open ? { open: false, focus: "toggle" } : { open: true, focus: "drawer" };
    case "close":
      return state.open ? { open: false, focus: "toggle" } : state;
    case "picked":
    case "settings":
    case "wide":
      return state.open ? DRAWER_CLOSED : state;
    default: {
      const _: never = action;
      return state;
    }
  }
}
