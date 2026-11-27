import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { sanitizeDiag } from "../src/agent/diag.ts";
import { DiagnosticsView } from "../src/client/DiagnosticsSection.tsx";
import { SettingsPanel } from "../src/client/SettingsPanel.tsx";
import { type DiagState, initialDiagState } from "../src/client/diag-buffer.ts";
import {
  ALL_EVENTS,
  ASK_MIPI_EVENTS,
  askMiPi,
  askMiPiPrompt,
  bannerItems,
  countEvents,
  shownEvents,
  sourcesOf,
} from "../src/client/diagnostics.ts";
import type { ConversationSummary, DiagEvent, DiagHealth } from "../src/protocol.ts";

const NOW = Date.UTC(2026, 10, 26, 15, 0, 0);
const MINUTE = 60_000;

/** An event as the agent stores it: through the guardrail, whatever the emitter passed. */
const stored = (id: number, input: Parameters<typeof sanitizeDiag>[0]): DiagEvent => ({
  id,
  ...sanitizeDiag(input, NOW - (20 - id) * MINUTE),
});

const events: DiagEvent[] = [
  stored(1, {
    level: "info",
    source: "do",
    kind: "startup.open",
    outcome: "ok",
    summary: "Opened MiPi 0.2.0",
  }),
  stored(2, {
    level: "debug",
    source: "do",
    kind: "alarm.fired",
    outcome: "ok",
    summary: "The alarm ran 3 consumers",
    durationMs: 12,
  }),
  stored(3, {
    level: "info",
    source: "gate",
    kind: "gate.held",
    outcome: "held",
    summary: "A proactive run is held by the spend-cap gate",
    convId: 4,
    detail: { gate: "spend-cap", at: "round" },
  }),
  stored(4, {
    level: "error",
    source: "door:telegram",
    kind: "telegram.send_failed",
    outcome: "fault",
    summary:
      "A Telegram send failed: POST /bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage 403",
    reqId: "answer:12:4242",
    detail: {
      chunk: "answer:12:4242:0",
      result: "failed",
      text: "Dear owner, here is your private note",
      token: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
    },
  }),
  stored(5, {
    level: "warn",
    source: "provider",
    kind: "provider.usage_failed",
    outcome: "fault",
    summary: "OpenCode Go's usage is unavailable: Authorization: Bearer sk-live_abcdef123456",
    detail: { provider: "opencode-go" },
  }),
];

const health: DiagHealth = {
  state: "open",
  alarmAt: NOW + 5 * MINUTE,
  alarmLostAt: NOW - 2 * 60 * MINUTE,
  held: "spend-cap",
  heldUntil: NOW + 9 * 60 * MINUTE,
  overdueSchedules: 1,
  lastProactiveRun: { at: NOW - 30 * MINUTE, outcome: "stopped" },
};

const live: DiagState = { events, health, subscribed: true, error: undefined };

type ViewProps = Parameters<typeof DiagnosticsView>[0];
const viewProps = (overrides: Partial<ViewProps> = {}): ViewProps => ({
  diag: live,
  disabled: false,
  filters: ALL_EVENTS,
  frozenAt: undefined,
  expanded: new Set(),
  now: NOW,
  onFilters: () => {},
  onPause: () => {},
  onToggle: () => {},
  onRefresh: () => {},
  onAskMiPi: () => {},
  ...overrides,
});
const render = (overrides: Partial<ViewProps> = {}) =>
  renderToStaticMarkup(createElement(DiagnosticsView, viewProps(overrides)));

/** The host elements of a hook-free component's output whose text is `label`. */
function buttons(node: ReactNode, label: string): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  const text = (child: ReactNode): string =>
    child === null || child === undefined || typeof child === "boolean"
      ? ""
      : typeof child === "string" || typeof child === "number"
        ? String(child)
        : Array.isArray(child)
          ? child.map(text).join("")
          : typeof child === "object" && "props" in child
            ? text((child.props as { children?: ReactNode }).children)
            : "";
  const walk = (child: ReactNode): void => {
    if (Array.isArray(child)) return child.forEach(walk);
    if (child === null || typeof child !== "object" || !("props" in child)) return;
    const element = child as ReactElement<Record<string, unknown>>;
    if (element.type === "button" && text(element.props.children as ReactNode) === label) {
      found.push(element);
    }
    walk(element.props.children as ReactNode);
  };
  walk(node);
  return found;
}

describe("Settings → Diagnostics", () => {
  it("is a section of Settings beside Archived", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsPanel, {
        conversations: [],
        disabled: false,
        onOpen: () => {},
        onRestore: () => {},
        onClose: () => {},
        initialSection: "diagnostics",
        diagnostics: {
          diag: initialDiagState,
          onSubscribe: () => {},
          onUnsubscribe: () => {},
          onAskMiPi: () => {},
        },
      }),
    );
    expect(html).toMatch(/>Archived<\/button>/);
    expect(html).toMatch(/aria-current="page"[^>]*>Diagnostics</);
    expect(html).toContain(">Diagnostics</h3>");
    expect(html).toContain("No events yet.");
    // Without the session's diagnostics, there is no section to pick.
    const bare = renderToStaticMarkup(
      createElement(SettingsPanel, {
        conversations: [],
        disabled: false,
        onOpen: () => {},
        onRestore: () => {},
        onClose: () => {},
      }),
    );
    expect(bare).not.toContain("Diagnostics");
  });

  it("shows the summary strip, the banner and every event, without secrets or message text", () => {
    const html = render();
    expect(html).toContain(">5 events<");
    expect(html).toContain(">2 ok<");
    expect(html).toContain(">2 warn / held<");
    expect(html).toContain(">1 error<");
    expect(html).toContain(`Next alarm: ${new Date(health.alarmAt!).toLocaleString()}`);
    expect(html).toMatch(/class="diag-hold"[^>]*>spend-cap until /);
    expect(html).toContain(">Live<");
    const summary = html.match(/<div class="diag-summary"[^>]*>(.*?)<\/div>/)?.[1];
    expect(summary).toMatch(
      />Refresh<\/button><button[^>]*title="[^"]*without sending\."[^>]*>Ask MiPi<\/button>/,
    );
    expect(html.match(/>Ask MiPi<\/button>/g)).toHaveLength(1);

    // The banner: the lost alarm, the hold, the late schedule and the error.
    expect(html).toMatch(/role="status"/);
    expect(html).toContain("The alarm was lost at");
    expect(html).toContain("Today&#x27;s spend cap is reached until");
    expect(html).toContain("1 schedule is more than two hours late.");
    expect(html).toContain("1 error in the last hour.");

    // The table: five columns, a row per event, severity on the row for its accent.
    expect(html).toMatch(/<th scope="col">Time<\/th><th scope="col">Severity<\/th>/);
    expect(html.match(/class="diag-row /g)).toHaveLength(5);
    // Newest first: the latest is at the top.
    expect([...html.matchAll(/data-event="(\d+)"/g)].map(([, id]) => Number(id))).toEqual([
      5, 4, 3, 2, 1,
    ]);
    expect(html).toContain('class="diag-row diag-row--error" data-event="4"');
    expect(html).toContain('class="diag-row diag-row--warn" data-event="5"');

    // The guardrail held at the agent, so nothing secret or private is there to show.
    expect(html).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(html).not.toContain("sk-live_abcdef123456");
    expect(html).not.toContain("private note");
  });

  it("filters by severity and source, with a chip for each source present", () => {
    expect(sourcesOf(events)).toEqual(["do", "door:telegram", "gate", "provider"]);
    // A chosen source whose events aged out keeps its chip, pressed, so the filter can be turned off.
    expect(sourcesOf(events, "door:relay")).toContain("door:relay");
    expect(
      render({
        diag: { ...live, events: [events[0]!] },
        filters: { level: "all", source: "door:relay" },
      }),
    ).toMatch(/aria-pressed="true"[^>]*>door:relay</);
    const errors = render({ filters: { level: "error", source: undefined } });
    expect(errors.match(/class="diag-row /g)).toHaveLength(1);
    expect(errors).toMatch(/aria-pressed="true"[^>]*>Error</);
    const gate = render({ filters: { level: "all", source: "gate" } });
    expect(gate.match(/class="diag-row /g)).toHaveLength(1);
    expect(gate).toMatch(/aria-pressed="true"[^>]*>gate</);
    expect(render({ filters: { level: "debug", source: "gate" } })).toContain(
      "No events match these filters.",
    );

    const chosen: unknown[] = [];
    const view = DiagnosticsView(viewProps({ onFilters: (filters) => chosen.push(filters) }));
    (buttons(view, "Warn")[0]!.props.onClick as () => void)();
    (buttons(view, "provider")[0]!.props.onClick as () => void)();
    expect(chosen).toEqual([
      { level: "warn", source: undefined },
      { level: "all", source: "provider" },
    ]);
  });

  it("holds the rows still while paused, and counts what came meanwhile", () => {
    const more = [
      ...events,
      stored(6, { level: "info", source: "do", kind: "x", outcome: "ok", summary: "new" }),
      stored(7, { level: "error", source: "do", kind: "y", outcome: "fault", summary: "newer" }),
    ];
    expect(shownEvents(more, ALL_EVENTS, 5)).toMatchObject({ pending: 2 });
    expect(shownEvents(more, ALL_EVENTS, 5).rows.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);
    expect(shownEvents(more, { level: "error", source: undefined }, 5).pending).toBe(1);
    expect(shownEvents(more, ALL_EVENTS, undefined)).toMatchObject({ pending: 0 });

    const html = render({ diag: { ...live, events: more }, frozenAt: 5 });
    expect(html.match(/class="diag-row /g)).toHaveLength(5);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Resume</);
    expect(html).toContain(">2 new<");

    const toggled: boolean[] = [];
    (
      buttons(DiagnosticsView(viewProps({ onPause: (on) => toggled.push(on) })), "Pause scroll")[0]!
        .props.onClick as () => void
    )();
    expect(toggled).toEqual([true]);
  });

  it("expands a row to its detail and correlation fields", () => {
    const closed = render();
    expect(closed).toMatch(
      /aria-expanded="false" aria-controls="diag-detail-3">gate.held<\/button>/,
    );
    expect(closed).toMatch(/<tr id="diag-detail-3" class="diag-detail-row" hidden="">/);
    expect(closed).not.toContain("&quot;gate&quot;: &quot;spend-cap&quot;");

    const open = render({ expanded: new Set([3, 4]) });
    expect(open).toMatch(/aria-expanded="true" aria-controls="diag-detail-3"/);
    expect(open).toContain("&quot;convId&quot;: 4");
    expect(open).toContain("&quot;gate&quot;: &quot;spend-cap&quot;");
    expect(open).toContain("&quot;reqId&quot;: &quot;answer:12:4242&quot;");
    // The detail keys the guardrail dropped are not there to expand.
    expect(open).not.toContain("&quot;text&quot;");
    expect(open).not.toContain("&quot;token&quot;");
    expect(open).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    // An event with nothing to expand has no toggle.
    expect(open).toMatch(/<span class="diag-kind">startup.open<\/span>/);
  });

  it("counts and banners from the events and health alone", () => {
    expect(countEvents(events)).toEqual({ total: 5, ok: 2, warnHeld: 2, error: 1 });
    expect(bannerItems({ state: "open", overdueSchedules: 0 }, [], NOW)).toEqual([]);
    const old = { ...health, alarmLostAt: NOW - 27 * 60 * MINUTE, held: undefined };
    expect(bannerItems(old, [], NOW).map(({ kind }) => kind)).toEqual(["overdue"]);
    expect(
      bannerItems({ state: "refused", reason: "data is newer", overdueSchedules: 0 }, [], NOW),
    ).toEqual([{ kind: "state", text: "The agent is refused: data is newer." }]);
    // An error older than an hour no longer raises the banner.
    expect(
      bannerItems(
        { state: "open", overdueSchedules: 0 },
        [{ ...events[3]!, ts: NOW - 61 * MINUTE }],
        NOW,
      ),
    ).toEqual([]);
    const healthy = render({
      diag: { ...live, health: { state: "open", overdueSchedules: 0 }, events: [events[0]!] },
    });
    expect(healthy).not.toContain('role="status"');
    expect(healthy).toContain(">Ask MiPi</button>");
    expect(render({ disabled: true })).toMatch(/<button[^>]*disabled=""[^>]*>Ask MiPi<\/button>/);
  });
});

describe("Ask MiPi", () => {
  it("drafts the health and the shown events, at most fifteen, as plain text", () => {
    const prompt = askMiPiPrompt(health, events);
    expect(prompt.split("\n")[0]).toBe(
      "Here is what Settings → Diagnostics shows. What do you make of it, and is anything worth checking?",
    );
    expect(prompt).toContain("Health: state open; next alarm 2026-11-26T15:05:00.000Z");
    expect(prompt).toContain("held: spend-cap until");
    expect(prompt).toContain("overdue schedules 1");
    expect(prompt).toContain("last scheduled run stopped at");
    expect(prompt).toContain(
      "error door:telegram telegram.send_failed (fault): A Telegram send failed: POST /bot[redacted]/sendMessage 403 [req answer:12:4242]",
    );
    expect(prompt).toContain("gate gate.held (held)");
    expect(prompt).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(prompt).not.toContain("private note");

    const many = Array.from({ length: 40 }, (_, index) =>
      stored(index + 1, {
        level: "info",
        source: "do",
        kind: `k${index + 1}`,
        outcome: "ok",
        summary: "s",
      }),
    );
    const lines = askMiPiPrompt(health, many)
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(lines).toHaveLength(ASK_MIPI_EVENTS);
    expect(lines.at(-1)).toContain(" k40 ");
    expect(askMiPiPrompt(undefined, [])).toContain("No recent events.");
  });

  it("drafts what the filters show, from the summary button", () => {
    const asked: string[] = [];
    const view = DiagnosticsView(
      viewProps({
        filters: { level: "error", source: undefined },
        onAskMiPi: (prompt) => asked.push(prompt),
      }),
    );
    (buttons(view, "Ask MiPi")[0]!.props.onClick as () => void)();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("telegram.send_failed");
    expect(asked[0]).not.toContain("gate.held");
  });

  it("opens MiPi with the draft in its composer, closes Settings and sends nothing", () => {
    const conversations: ConversationSummary[] = [
      { id: 9, kind: "bot", name: "Garden" },
      { id: 4, kind: "main", name: "MiPi" },
    ];
    const calls: string[] = [];
    const target = {
      conversations,
      open: vi.fn((id: number) => calls.push(`open ${id}`)),
      setDraft: vi.fn((text: string) => calls.push(`draft ${text.length}`)),
      closeSettings: vi.fn(() => calls.push("close")),
      focusComposer: vi.fn(() => calls.push("focus")),
    };
    expect(askMiPi("the prompt", target)).toBe(true);
    expect(calls).toEqual(["open 4", "draft 10", "close", "focus"]);
    expect(target.setDraft).toHaveBeenCalledWith("the prompt");
    // No MiPi yet (no session snapshot): nothing happens.
    const none = { ...target, conversations: [], open: vi.fn() };
    expect(askMiPi("x", none)).toBe(false);
    expect(none.open).not.toHaveBeenCalled();
  });
});
