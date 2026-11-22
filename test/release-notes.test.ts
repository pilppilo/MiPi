import { describe, expect, it } from "vitest";
import {
  compareVersions,
  oneWayReleasesCrossed,
  parseChangelog,
  upstreamChanges,
} from "../scripts/release-notes.ts";

const changelog = `# mipi

## 0.2.0-alpha.2

### Minor Changes

- abc1234: Something else.

## 0.2.0-alpha.1

### Minor Changes

- def5678: Pi Durable 1.7.0.

  > [!WARNING]
  > **One-way:** Pi Durable 1.7 migrates storage; builds before this one can't open it.

## 0.1.0

### Minor Changes

- 0123456: Ops.

## 0.1.0-beta.1

- Beta.
`;

describe("release notes", () => {
  it("finds one-way releases in the changelog", () => {
    expect(parseChangelog(changelog).map(({ version, oneWay }) => [version, oneWay])).toEqual([
      ["0.2.0-alpha.2", false],
      ["0.2.0-alpha.1", true],
      ["0.1.0", false],
      ["0.1.0-beta.1", false],
    ]);
  });

  it("refuses to cross a one-way release on rollback, and allows other rollbacks", () => {
    const releases = parseChangelog(changelog);
    expect(
      oneWayReleasesCrossed(releases, "0.2.0-alpha.2", "0.1.0").map(({ version }) => version),
    ).toEqual(["0.2.0-alpha.1"]);
    expect(oneWayReleasesCrossed(releases, "0.2.0-alpha.2", "0.2.0-alpha.1")).toEqual([]);
    expect(oneWayReleasesCrossed(releases, "0.1.0", "0.1.0-beta.1")).toEqual([]);
    expect(() => oneWayReleasesCrossed(releases, "0.1.0", "0.2.0-alpha.2")).toThrow(/upgrade/);
    expect(() => oneWayReleasesCrossed(releases, "9.9.9", "0.1.0")).toThrow(/not in CHANGELOG/);
  });

  it("compares versions, pre-releases before their release", () => {
    expect(compareVersions("1.6.0", "1.5.2")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0-alpha.10", "0.1.0-alpha.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0-beta.1", "0.1.0-alpha.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.0", "0.1.0-beta.3")).toBeGreaterThan(0);
    expect(compareVersions("1.6.0", "1.6.0")).toBe(0);
  });

  it("picks Pi Durable's changelog sections for an upgrade range", () => {
    const upstream = `# Changelog

## [Unreleased]

- Next.

## [1.6.0] - 2026-11-20

- Tool parks.

## [1.5.2] - 2026-11-10

- Fix.

## [1.5.1] - 2026-11-09

- Chord subpaths.
`;
    const range = upstreamChanges(upstream, "1.5.1", "1.6.0");
    expect(range).toContain("## [1.6.0]");
    expect(range).toContain("## [1.5.2]");
    expect(range).not.toContain("1.5.1]");
    expect(range).not.toContain("Unreleased");
  });
});
