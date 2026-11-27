/** The web door's plain names (COD-244): ids in, words the owner reads out. */
import { describe, expect, it } from "vitest";
import {
  modelName,
  profileName,
  profileSummary,
  readable,
  thinkingName,
  toolName,
  toolSummary,
} from "../src/client/names.ts";
import type { Options } from "../src/protocol.ts";

const options: Options = {
  models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }],
  profiles: [
    { id: "default", name: "Everyday tools: scheduling, history search, memory and web pages" },
    { id: "empty", name: " " },
  ],
  defaultModel: "deepseek-v4.1-flash",
};

describe("plain names", () => {
  it("names every tool the profiles offer today, with what it lets a bot do", () => {
    for (const id of [
      "schedule",
      "search_history",
      "remember",
      "forget",
      "web_fetch",
      "create_bot",
      "bind_door",
      "message_bot",
      "list_bots",
      "stop_bot",
      "list_cobots",
      "archive_cobot",
    ]) {
      expect(toolName(id)).not.toMatch(/_/);
      expect(toolSummary(id)).toBeDefined();
    }
    expect(toolName("web_fetch")).toBe("Web pages");
    expect(toolName("schedule")).toBe("Reminders");
  });

  it("shows a tool or profile it doesn't know readably, never as its raw id", () => {
    expect(toolName("search_history_v2")).toBe("Search history v2");
    expect(toolName("readCalendar")).toBe("Read calendar");
    expect(toolSummary("readCalendar")).toBeUndefined();
    expect(profileName("research-team")).toBe("Research team");
    expect(readable("")).toBe("");
  });

  it("names profiles, and takes what each offers from the agent's own description", () => {
    expect(profileName("default")).toBe("Everyday");
    expect(profileName("empty")).toBe("Just chat");
    expect(profileName("main")).toBe("MiPi's toolkit");
    expect(profileSummary("default", options)).toMatch(/^Everyday tools/);
    // A blank description, or none, says nothing rather than an empty line.
    expect(profileSummary("empty", options)).toBeUndefined();
    expect(profileSummary("main", options)).toBeUndefined();
    expect(profileSummary("default", undefined)).toBeUndefined();
  });

  it("names a model by its catalog name, else by its id without the provider", () => {
    expect(modelName("deepseek-v4.1-flash", options)).toBe("DeepSeek V4.1 Flash");
    expect(modelName("opencode-go/kimi-k3", options)).toBe("kimi-k3");
    expect(modelName("kimi-k3", undefined)).toBe("kimi-k3");
  });

  it("names thinking levels", () => {
    expect(thinkingName("low")).toBe("Light");
    expect(thinkingName("off")).toBe("Off");
    expect(thinkingName("turbo")).toBe("Turbo");
  });
});
