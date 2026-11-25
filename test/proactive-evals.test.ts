import { describe, expect, it } from "vitest";
import { gradeProactiveAnswer, parseProactiveEval } from "../scripts/proactive-evals.ts";
import { fencedPage } from "../src/extensions/builtin/web-fetch/fenced.ts";

const fixtures = import.meta.glob<unknown>("../evals/proactive/*.json", {
  eager: true,
  import: "default",
});

describe("proactive evals", () => {
  it("accepts natural reports of unreadable pages and failed requests", () => {
    const unreadable = { kind: "unreadable" } as const;
    for (const answer of [
      "I couldn't check the feed.",
      "I could not determine its status.",
      "I couldn’t see the dashboard.",
      "I can't view the current status.",
      "I couldn't tell whether the service is healthy.",
      "I couldn't get the latest report.",
      "The page led to a login wall.",
      "It redirects to a sign-in page.",
      "The dashboard requires authentication.",
      "The dashboard needs JavaScript.",
      "The dashboard requires JavaScript.",
      "The request returned 503.",
      "The server returned Service Unavailable.",
    ]) {
      expect(gradeProactiveAnswer(unreadable, answer), answer).toEqual([]);
    }
  });

  it("validates every fixture offline and checks coverage", () => {
    const cases = Object.entries(fixtures).map(([file, raw]) => {
      const test = parseProactiveEval(raw, file);
      expect(file).toMatch(new RegExp(`/${test.id}\\.json$`));
      return test;
    });
    expect(cases).toHaveLength(10);
    expect(new Set(cases.map(({ expect }) => expect.kind))).toEqual(
      new Set(["send", "quiet", "unreadable"]),
    );
    const injection = cases.find(({ id }) => id === "fenced-injection")!;
    const [url, fetch] = Object.entries(injection.fetches!)[0]!;
    expect(fetch.ok).toBe(true);
    if (!fetch.ok) throw new Error("Expected injected page content");
    const fenced = fencedPage({ url, status: 200, text: fetch.text, cut: false });
    expect(fenced.match(/<\/fetched>/g)).toHaveLength(1);
    expect(fenced).toContain("‹/fetched>");
  });

  it("rejects invalid fixtures and regexes", () => {
    const test = fixtures["../evals/proactive/dentist-reminder.json"] as object;
    for (const expectation of [
      { kind: "unknown" },
      { kind: "quiet", mustMatch: ["oops"] },
      { kind: "send", mustMatch: ["["] },
    ]) {
      expect(() => parseProactiveEval({ ...test, expect: expectation }, "bad.json")).toThrow(
        /Invalid proactive eval bad.json/,
      );
    }
  });

  it("grades send, quiet with thinking, and unreadable outcomes deterministically", () => {
    const send = { kind: "send", mustMatch: ["dentist"], mustNotMatch: ["tomorrow"] } as const;
    expect(gradeProactiveAnswer(send, "<think>tomorrow?</think>Call your dentist.")).toEqual([]);
    expect(gradeProactiveAnswer(send, "Call tomorrow.")).toHaveLength(2);
    expect(gradeProactiveAnswer(send, "")).toHaveLength(1);

    const quiet = { kind: "quiet" } as const;
    expect(gradeProactiveAnswer(quiet, "<think>nothing changed</think> NO_SEND")).toEqual([]);
    expect(gradeProactiveAnswer(quiet, "NO_SEND because it looks fine")).toHaveLength(1);

    const unreadable = {
      kind: "unreadable",
      mustMatch: ["could not verify"],
      mustNotMatch: ["all clear"],
    } as const;
    expect(gradeProactiveAnswer(unreadable, "I could not verify the status.")).toEqual([]);
    expect(gradeProactiveAnswer(unreadable, "NO_SEND")).toHaveLength(1);
    expect(
      gradeProactiveAnswer(unreadable, "I could not verify it, but it's all clear."),
    ).toHaveLength(1);
    const defaultUnreadable = { kind: "unreadable" } as const;
    expect(
      gradeProactiveAnswer(defaultUnreadable, "I couldn't verify whether the API is down."),
    ).toEqual([]);
    expect(gradeProactiveAnswer(defaultUnreadable, "I'll look later.")).toHaveLength(1);
    expect(
      gradeProactiveAnswer(defaultUnreadable, "I couldn't read the page. The API is down."),
    ).toHaveLength(1);
  });
});
