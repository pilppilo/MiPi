/**
 * Reads CHANGELOG.md for the deploy and upgrade scripts. No Node imports, so tests can run it in workerd.
 *
 * One-way releases: a release whose data an older build can't read (a Pi Durable storage or task-version bump) says
 * so in its changeset with a line containing `**One-way:**`, ideally as a GitHub alert:
 *
 *   > [!WARNING]
 *   > **One-way:** Pi Durable 1.7 migrates storage; builds before this one can't open it.
 */

export interface Release {
  readonly version: string;
  readonly oneWay: boolean;
  readonly body: string;
}

/** Releases in the order the changelog lists them (newest first). */
export function parseChangelog(changelog: string): readonly Release[] {
  const releases: Release[] = [];
  const sections = changelog.split(/^## /m).slice(1);
  for (const section of sections) {
    const newline = section.indexOf("\n");
    const version = (newline === -1 ? section : section.slice(0, newline)).trim();
    const body = newline === -1 ? "" : section.slice(newline + 1);
    releases.push({ version, oneWay: body.includes("**One-way:**"), body });
  }
  return releases;
}

/**
 * The one-way releases a rollback from `from` to `to` would cross: those newer than `to`, up to and including
 * `from`. Throws if either version isn't in the changelog.
 */
export function oneWayReleasesCrossed(
  releases: readonly Release[],
  from: string,
  to: string,
): readonly Release[] {
  const fromIndex = releases.findIndex(({ version }) => version === from);
  const toIndex = releases.findIndex(({ version }) => version === to);
  if (fromIndex === -1) throw new Error(`${from} is not in CHANGELOG.md`);
  if (toIndex === -1) throw new Error(`${to} is not in CHANGELOG.md`);
  if (toIndex < fromIndex)
    throw new Error(`${to} is newer than ${from}: that's an upgrade, not a rollback`);
  return releases.slice(fromIndex, toIndex).filter(({ oneWay }) => oneWay);
}

/** The text of Pi Durable's changelog for versions after `from` up to and including `to`. */
export function upstreamChanges(changelog: string, from: string, to: string): string {
  const out: string[] = [];
  for (const section of changelog.split(/^## /m).slice(1)) {
    const match = /^\[?([0-9][^\]\s]*)\]?/.exec(section);
    if (match === null) continue;
    const version = match[1]!;
    if (compareVersions(version, from) > 0 && compareVersions(version, to) <= 0) {
      out.push(`## ${section.trimEnd()}`);
    }
  }
  return out.join("\n\n");
}

/** Compares `major.minor.patch` (pre-release parts sort before the release). */
export function compareVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const [core, pre] = version.split("-", 2) as [string, string | undefined];
    return { parts: core.split(".").map(Number), pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return a.pre.localeCompare(b.pre, "en", { numeric: true });
}
