import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { BotSecretInfo, ConversationSummary } from "../src/protocol.ts";
import { makeLaneKey, VaultSpace } from "../src/client/VaultSpace.tsx";
import { VaultSecretForm } from "../src/client/VaultSecretForm.tsx";

const conversations: readonly ConversationSummary[] = [
  { id: 1, kind: "main", name: "MiPi" },
  { id: 2, kind: "bot", name: "Planner" },
  { id: 3, kind: "bot", name: "Reader", archivedAt: 20 },
  { id: 4, kind: "cobot", name: "Side chat" },
];
const names = {
  conversations,
  label: (conversation: ConversationSummary) => conversation.name ?? "",
};
const form = {
  ...names,
  providers: [{ id: "mipi", label: "MiPi" }],
  create: async () => {},
  update: async () => {},
  close: () => {},
};
const secret: BotSecretInfo = {
  id: "sec_1234567890abcdef12345678",
  name: "Deploy key",
  category: "token",
  provider: "mipi",
  createdAt: 1,
  updatedAt: 2,
  policy: {
    botAccess: "approve",
    bots: [3],
    hosts: ["api.example.com"],
    port: 8080,
    methods: ["GET", "POST"],
    paths: ["/projects"],
    inject: { header: "Authorization", template: "Bearer {}" },
    expiresAt: 60_000,
  },
};

describe("Vault space", () => {
  it("renders a dedicated loading view", () => {
    const html = renderToStaticMarkup(<VaultSpace {...names} />);
    expect(html).toContain('aria-label="Vault"');
    expect(html).toContain("Loading Vault");
  });

  it("creates with masked value entry, the full policy, and no bots selected", () => {
    const html = renderToStaticMarkup(<VaultSecretForm {...form} locked={false} />);
    const value = html.match(/<input(?=[^>]*name="value")[^>]*>/)?.[0]?.toLowerCase();
    expect(value).toContain('type="password"');
    expect(value).toContain('autocomplete="off"');
    expect(value).toContain('spellcheck="false"');
    expect(value).toContain('minlength="8"');
    for (const field of [
      "botAccess",
      "hosts",
      "port",
      "methods",
      "paths",
      "header",
      "template",
      "expiresAt",
    ]) {
      expect(html).toContain(`name="${field}"`);
    }
    expect(html).toContain("MiPi");
    expect(html).toContain("Planner");
    expect(html).not.toContain("Reader");
    expect(html).not.toContain("Side chat");
    expect(html.match(/<input[^>]*name="bots"[^>]*>/g)).toHaveLength(2);
    expect(html).not.toMatch(/<input[^>]*name="bots"[^>]*checked/);
  });

  it("keeps archived grants editable while locked and leaves the value field absent", () => {
    const html = renderToStaticMarkup(<VaultSecretForm {...form} item={secret} locked />);
    expect(html).toContain("Reader (archived)");
    expect(html).toMatch(/<input[^>]*name="bots"[^>]*checked=""[^>]*value="3"/);
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*>Replace value/);
    expect(html).not.toContain('type="password"');
    expect(html).toMatch(/<button[^>]*type="submit">Save secret/);
  });

  it("makes a fresh 32-byte base64 lane key without fetching", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const first = makeLaneKey();
      expect(atob(first)).toHaveLength(32);
      expect(makeLaneKey()).not.toBe(first);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
