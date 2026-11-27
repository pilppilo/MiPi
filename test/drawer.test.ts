/** The spaces drawer's rules (COD-244): what opens and closes it, and where focus goes. */
import { describe, expect, it } from "vitest";
import { DRAWER_CLOSED, type DrawerAction, drawerReducer } from "../src/client/drawer.ts";

const run = (...actions: DrawerAction[]) => actions.reduce(drawerReducer, DRAWER_CLOSED);

describe("the spaces drawer", () => {
  it("opens with focus inside, and closes with focus back on its toggle", () => {
    expect(run({ type: "toggle" })).toEqual({ open: true, focus: "drawer" });
    expect(run({ type: "toggle" }, { type: "toggle" })).toEqual({ open: false, focus: "toggle" });
    // Escape or the scrim.
    expect(run({ type: "toggle" }, { type: "close" })).toEqual({ open: false, focus: "toggle" });
  });

  it("closes by itself when a bot or cobot is picked, or Settings opens, leaving focus to them", () => {
    expect(run({ type: "toggle" }, { type: "picked" })).toEqual(DRAWER_CLOSED);
    expect(run({ type: "toggle" }, { type: "settings" })).toEqual(DRAWER_CLOSED);
  });

  it("closes, without moving focus, when the screen grows wide enough for the sidebar", () => {
    expect(run({ type: "toggle" }, { type: "wide" })).toEqual(DRAWER_CLOSED);
  });

  it("changes nothing when closed already, so focus isn't pulled to the toggle", () => {
    for (const type of ["close", "picked", "settings", "wide"] as const) {
      expect(drawerReducer(DRAWER_CLOSED, { type })).toBe(DRAWER_CLOSED);
    }
  });
});
