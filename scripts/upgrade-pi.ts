/**
 * Moves MiPi to another Pi Durable release: bumps the pins of every `@earendil-works/*` package together (pi-durable
 * pins its siblings exactly, so a mismatch installs two copies), installs, prints Pi Durable's changelog for the
 * range, and re-stamps `src/version.ts`. Then fix `src/agent/pi/` until `pnpm check` and `pnpm test` pass.
 *
 *   node scripts/upgrade-pi.ts 1.7.0
 *   node scripts/upgrade-pi.ts 1.6.0   (same version: a dry run of the whole procedure)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { upstreamChanges } from "./release-notes.ts";
import { isPiVersion, PI_DURABLE_PACKAGE } from "./pi-version.ts";

const target = process.argv[2];
if (target === undefined || !isPiVersion(target)) {
  console.error("Usage: node scripts/upgrade-pi.ts <version>   e.g. 1.7.0");
  process.exit(2);
}

// On Windows, pnpm is a .cmd shim, which only runs through a shell.
const run = (command: string, args: string[]) =>
  execFileSync(command, args, { stdio: "inherit", shell: process.platform === "win32" });

const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  dependencies: Record<string, string>;
};
const pinned = Object.keys(packageJson.dependencies).filter((name) =>
  name.startsWith("@earendil-works/"),
);
const current = packageJson.dependencies[PI_DURABLE_PACKAGE];
if (current === undefined) throw new Error("@earendil-works/pi-durable is not a dependency");
console.log(`Pi Durable ${current} → ${target} (${pinned.join(", ")})`);

for (const name of pinned) packageJson.dependencies[name] = target;
writeFileSync("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

// New releases are younger than pnpm's minimum release age: allow exactly these versions (siblings included).
const workspace = readFileSync("pnpm-workspace.yaml", "utf8").replace(
  /"(@earendil-works\/[\w-]+)@[^"]+"/g,
  (_match, name: string) => `"${name}@${target}"`,
);
writeFileSync("pnpm-workspace.yaml", workspace);

// The manifest changed on purpose, including when the caller is running in CI.
run("pnpm", ["install", "--no-frozen-lockfile"]);
run("node", ["scripts/stamp-version.ts"]);

const changelog = readFileSync("node_modules/@earendil-works/pi-durable/CHANGELOG.md", "utf8");
const changes = upstreamChanges(changelog, current, target);
console.log(
  changes.length > 0
    ? `\n===== Pi Durable changes ${current} → ${target} =====\n\n${changes}\n`
    : `\nNo Pi Durable changelog entries between ${current} and ${target}.\n`,
);
console.log(`\n===== Pi Durable ledger: recheck each open entry against the changes above =====\n`);
run("node", ["scripts/ledger-cli.ts"]);
console.log(`\nNext:
  1. Fix src/agent/pi/ until \`pnpm check\` and \`pnpm test\` pass (test/contract.test.ts names what moved).
  2. Update docs/pi-durable-ledger.md: close entries this release fixed (and delete their code), add new ones.
  3. \`pnpm changeset\`: a **Pi Durable** note (naming ledger entries added or closed), and a **Migration** note. If storage or task versions changed,
     add a "> [!WARNING]" line with **One-way:** so rollbacks past it are refused.
  4. Merge: it deploys to staging. Use it there for a day, then run the deploy workflow for production.`);
