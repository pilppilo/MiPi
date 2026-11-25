import { describe, expect, it, vi } from "vitest";
import { planCanaryReport, resolveCanaryTarget } from "../scripts/canary-report.ts";
import { isPiVersion } from "../scripts/pi-version.ts";

describe("Pi Durable canary target", () => {
  it("uses an override without reading the registry", () => {
    const latest = vi.fn(() => "1.7.0");
    expect(resolveCanaryTarget(" 1.8.0-beta.2 ", latest)).toBe("1.8.0-beta.2");
    expect(latest).not.toHaveBeenCalled();
  });

  it("trims the registry result for absent or blank overrides", () => {
    expect(resolveCanaryTarget(undefined, () => "1.7.0\n")).toBe("1.7.0");
    expect(resolveCanaryTarget("  ", () => "1.7.0\n")).toBe("1.7.0");
    expect(() => resolveCanaryTarget(undefined, () => "latest")).toThrow(/SemVer/);
    expect(() => resolveCanaryTarget("^1.7.0", () => "1.7.0")).toThrow(/SemVer/);
  });

  it("accepts exact SemVer and rejects ranges, tags, and invalid identifiers", () => {
    for (const version of ["0.0.0", "1.6.0", "1.7.0-rc.1", "1.7.0-rc.1+build.07"]) {
      expect(isPiVersion(version), version).toBe(true);
    }
    for (const version of [
      "latest",
      "v1.6.0",
      "1.6",
      "^1.6.0",
      "01.6.0",
      "1.6.0-01",
      "1.6.0-a..b",
      "1.6.0+",
    ]) {
      expect(isPiVersion(version), version).toBe(false);
    }
  });
});

describe("Pi Durable canary issue report", () => {
  const failure = {
    current: "1.6.0",
    target: "1.7.0",
    stage: "check",
    runUrl: "https://github.com/pilppilo/MiPi/actions/runs/42",
  } as const;
  const title = "Pi Durable canary failed: 1.7.0";

  it("finds an exact open issue on a later page and skips PRs with the same title", () => {
    const report = planCanaryReport(
      [
        [
          { number: 110, title, pull_request: {} },
          { number: 109, title: `${title}-beta.1` },
        ],
        [
          { number: 108, title: `${title} (follow-up)` },
          { number: 107, title },
        ],
      ],
      failure,
    );
    expect(report).toEqual({
      kind: "comment",
      issueNumber: 107,
      body: "The `check` stage failed while checking Pi Durable `1.6.0` → `1.7.0`. [Workflow run](https://github.com/pilppilo/MiPi/actions/runs/42).",
    });
  });

  it("creates an issue when there is no exact match, even if a PR uses the title", () => {
    const report = planCanaryReport(
      [[{ number: 110, title, pull_request: {} }], [{ number: 109, title: `${title}0` }]],
      { ...failure, stage: "upgrade" },
    );
    expect(report).toMatchObject({ kind: "create", title });
    expect(report.body).toContain("`upgrade` stage failed");
    expect(report.body).toContain("`1.6.0` → `1.7.0`");
    expect(report.body).toContain(failure.runUrl);
    expect(report.body).toContain("pnpm upgrade:pi 1.7.0");
    expect(report.body).toContain("test/contract.test.ts");
    expect(report.body).toContain("docs/pi-durable-ledger.md");
  });

  it("rejects malformed pages before creating an issue", () => {
    expect(() => planCanaryReport([[{ title }]], failure)).toThrow(/invalid issue/);
    expect(() => planCanaryReport({ message: "forbidden" }, failure)).toThrow(/pages/);
  });
});
