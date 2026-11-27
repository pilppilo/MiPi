/** Spaces (COD-249): which spaces show, and the one a page link or a lost capability lands on. */
import { describe, expect, it } from "vitest";
import {
  availableSpaces,
  shownSpace,
  spaceFromSearch,
  conversationHref,
} from "../src/client/spaces.ts";

describe("spaces", () => {
  it("always has Chat, and Workbench only when the agent advertises activity", () => {
    expect(availableSpaces(new Set()).map(({ id }) => id)).toEqual(["chat"]);
    expect(availableSpaces(new Set(["usage", "diagnostics"])).map(({ id }) => id)).toEqual([
      "chat",
    ]);
    expect(availableSpaces(new Set(["activity"])).map(({ id }) => id)).toEqual([
      "chat",
      "workbench",
    ]);
  });

  it("falls back to Chat when the chosen space isn't backed any more", () => {
    const both = availableSpaces(new Set(["activity"]));
    const chatOnly = availableSpaces(new Set());
    expect(shownSpace("workbench", both)).toBe("workbench");
    expect(shownSpace("workbench", chatOnly)).toBe("chat");
    expect(shownSpace("chat", both)).toBe("chat");
  });

  it("reads a space from the page's link, and anything else as Chat", () => {
    expect(spaceFromSearch("?space=workbench")).toBe("workbench");
    expect(spaceFromSearch("?conversation=4&space=workbench")).toBe("workbench");
    expect(spaceFromSearch("?space=plan")).toBe("chat");
    expect(spaceFromSearch("")).toBe("chat");
    expect(spaceFromSearch("?space=chat")).toBe("chat");
  });

  it("builds a conversation's link in a space, bare for Chat", () => {
    expect(conversationHref(6, "chat")).toBe("?conversation=6");
    expect(conversationHref(6, "workbench")).toBe("?conversation=6&space=workbench");
    expect(spaceFromSearch(conversationHref(6, "workbench"))).toBe("workbench");
  });
});
