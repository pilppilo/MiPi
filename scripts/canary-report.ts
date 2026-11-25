import { isPiVersion } from "./pi-version.ts";

export const CANARY_STAGES = ["upgrade", "check", "test"] as const;

type CanaryFailure = {
  readonly current: string;
  readonly target: string;
  readonly stage: (typeof CANARY_STAGES)[number];
  readonly runUrl: string;
};

type CanaryRegistry = {
  /** `npm view <package> version`: the latest tag. */
  readonly latest: () => string;
  /** `npm view <package> versions --json`: every published version. */
  readonly published: () => string;
};

/** Read npm's published versions. npm prints a bare string when only one version exists. */
export function parsePublishedVersions(json: string): readonly string[] {
  const parsed: unknown = JSON.parse(json);
  const versions = typeof parsed === "string" ? [parsed] : parsed;
  if (!Array.isArray(versions) || !versions.every((v) => typeof v === "string")) {
    throw new Error("npm returned an invalid list of Pi Durable versions.");
  }
  return versions;
}

/**
 * Use the dispatcher's version if given, otherwise npm's latest tag. A manual version must
 * already be published, so a typo stops here instead of failing the upgrade and opening an issue.
 */
export function resolveCanaryTarget(
  override: string | undefined,
  registry: CanaryRegistry,
): string {
  const manual = override?.trim();
  const version = manual || registry.latest().trim();
  if (!isPiVersion(version)) throw new Error("Expected a Pi Durable SemVer version.");
  if (manual && !parsePublishedVersions(registry.published()).includes(version)) {
    throw new Error(`Pi Durable ${version} is not published on npm.`);
  }
  return version;
}

type Report =
  | { readonly kind: "create"; readonly title: string; readonly body: string }
  | { readonly kind: "comment"; readonly issueNumber: number; readonly body: string };

/** Plan one write from every page of GitHub's open issues response. GitHub lists PRs there too. */
export function planCanaryReport(pages: unknown, failure: CanaryFailure): Report {
  if (!Array.isArray(pages)) throw new Error("Expected pages of open GitHub issues.");
  const { current, target, stage, runUrl } = failure;
  const title = `Pi Durable canary failed: ${target}`;
  const run = `The \`${stage}\` stage failed while checking Pi Durable \`${current}\` → \`${target}\`. [Workflow run](${runUrl}).`;

  for (const page of pages as readonly unknown[]) {
    if (!Array.isArray(page)) throw new Error("Expected a page of open GitHub issues.");
    for (const issue of page as readonly unknown[]) {
      if (
        issue === null ||
        typeof issue !== "object" ||
        !("title" in issue) ||
        typeof issue.title !== "string" ||
        !("number" in issue) ||
        typeof issue.number !== "number" ||
        !Number.isSafeInteger(issue.number) ||
        issue.number <= 0
      ) {
        throw new Error("GitHub returned an invalid issue.");
      }
      if (issue.title === title && !Object.hasOwn(issue, "pull_request")) {
        return { kind: "comment", issueNumber: issue.number, body: run };
      }
    }
  }

  return {
    kind: "create",
    title,
    body: [
      run,
      `Run \`pnpm upgrade:pi ${target}\` on a branch from \`main\` to reproduce the upgrade.`,
      "Use `test/contract.test.ts` to find changed Pi exports and review `docs/pi-durable-ledger.md` before changing any workarounds.",
    ].join("\n\n"),
  };
}
