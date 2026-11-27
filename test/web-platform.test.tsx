/** The browser's `Platform` (COD-245): storage that fails or is switched off is just empty, never a throw. */
import { afterEach, expect, it, vi } from "vitest";
import { webPlatform } from "../src/client/platform/web.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("keeps values in localStorage", () => {
  const items = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
  });
  expect(webPlatform.storage.get("a")).toBeUndefined();
  webPlatform.storage.set("a", "1");
  expect(webPlatform.storage.get("a")).toBe("1");
  webPlatform.storage.remove("a");
  expect(webPlatform.storage.get("a")).toBeUndefined();
});

it("never throws when storage refuses or is blocked", () => {
  const refuse = () => {
    throw new Error("full");
  };
  vi.stubGlobal("window", {
    localStorage: { getItem: refuse, setItem: refuse, removeItem: refuse },
  });
  expect(webPlatform.storage.get("a")).toBeUndefined();
  expect(() => webPlatform.storage.set("a", "1")).not.toThrow();
  expect(() => webPlatform.storage.remove("a")).not.toThrow();
  // Reading `localStorage` itself throws where cookies are blocked.
  vi.stubGlobal(
    "window",
    Object.defineProperty({}, "localStorage", {
      get: () => {
        throw new Error("SecurityError");
      },
    }),
  );
  expect(webPlatform.storage.get("a")).toBeUndefined();
  expect(() => webPlatform.storage.set("a", "1")).not.toThrow();
});

it("reports no share sheet or notifications where the browser has none", async () => {
  vi.stubGlobal("navigator", {});
  await expect(webPlatform.share({ url: "https://example.com" })).resolves.toBe(false);
  vi.stubGlobal("Notification", undefined);
  await expect(webPlatform.notify!({ title: "x" })).resolves.toBe(false);
});
