/**
 * Captures this build's fixture database into `test/fixtures/db/<version>.json` (COD-185): runs
 * `test/fixture-capture.test.ts` with `MIPI_CAPTURE_FIXTURE=1`, which seeds an agent with every kind of data this build
 * writes and saves its export there. Run it once per release that changes stored data, and commit the file:
 * `test/fixtures.test.ts` replays every committed fixture into a fresh agent on every test run.
 *
 * Usage: node scripts/fixture-capture.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
const target = `test/fixtures/db/${version}.json`;
if (existsSync(target)) {
  console.error(
    `${target} exists already. A fixture is never rewritten: delete it first if you mean to.`,
  );
  process.exit(1);
}
const result = spawnSync("pnpm", ["exec", "vitest", "run", "test/fixture-capture.test.ts"], {
  stdio: "inherit",
  // pnpm is a .cmd on Windows, which only a shell runs.
  shell: process.platform === "win32",
  env: { ...process.env, MIPI_CAPTURE_FIXTURE: "1" },
});
if (result.status !== 0 || !existsSync(target)) {
  console.error(`Capture failed; ${target} was not written.`);
  process.exit(result.status ?? 1);
}
console.log(`Wrote ${target}. Commit it.`);
