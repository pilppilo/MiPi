import { expect, it, vi } from "vitest";
import { DiagnosticsSection } from "../src/client/DiagnosticsSection.tsx";
import { SettingsPanel } from "../src/client/SettingsPanel.tsx";
import { initialDiagState } from "../src/client/session/diag-buffer.ts";

const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
}));

// Components run as plain functions: state keeps its initial value, effects are collected to run by hand.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T,>(initial: T | (() => T)) => [
    typeof initial === "function" ? (initial as () => T)() : initial,
    vi.fn(),
  ],
  useEffect: (effect: () => void | (() => void)) => {
    hooks.effects.push(effect);
  },
}));

it("subscribes when Diagnostics mounts and unsubscribes when it unmounts", () => {
  hooks.effects.length = 0;
  const onSubscribe = vi.fn();
  const onUnsubscribe = vi.fn();
  DiagnosticsSection({
    diag: initialDiagState,
    disabled: false,
    onSubscribe,
    onUnsubscribe,
    onAskMiPi: () => {},
  });
  expect(hooks.effects).toHaveLength(1);
  const cleanup = hooks.effects[0]!();
  expect(onSubscribe).toHaveBeenCalledTimes(1);
  expect(onSubscribe).toHaveBeenCalledWith();
  expect(onUnsubscribe).not.toHaveBeenCalled();
  // Settings closing, or the section switching to Archived, unmounts it.
  (cleanup as () => void)();
  expect(onUnsubscribe).toHaveBeenCalledTimes(1);
});

it("mounts Diagnostics only while it is the section shown", () => {
  const props = {
    conversations: [],
    disabled: false,
    onOpen: () => {},
    onRestore: () => {},
    onClose: () => {},
    diagnostics: {
      diag: initialDiagState,
      onSubscribe: () => {},
      onUnsubscribe: () => {},
      onAskMiPi: () => {},
    },
  };
  const mounted = (tree: unknown): boolean =>
    JSON.stringify(tree, (_key, value: unknown) =>
      value === DiagnosticsSection ? "__DiagnosticsSection__" : value,
    ).includes("__DiagnosticsSection__");
  expect(mounted(SettingsPanel({ ...props, initialSection: "diagnostics" }))).toBe(true);
  expect(mounted(SettingsPanel({ ...props, initialSection: "archived" }))).toBe(false);
});
