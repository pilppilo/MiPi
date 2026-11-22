/**
 * Builds and dry-run deploys every lane, production last so `dist/` ends as the default build. The Vite plugin picks
 * the lane from `CLOUDFLARE_ENV` and ignores `wrangler --env`, so each lane is built on its own.
 *
 *   node scripts/dry-run.ts
 */
import { execFileSync } from "node:child_process";

const LANES = [
  { name: "staging", env: "staging" },
  { name: "production", env: undefined },
] as const;

// On Windows, pnpm is a .cmd shim, which only runs through a shell.
const run = (args: readonly string[], env: NodeJS.ProcessEnv): void => {
  execFileSync("pnpm", args, { stdio: "inherit", env, shell: process.platform === "win32" });
};

for (const lane of LANES) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (lane.env === undefined) delete env.CLOUDFLARE_ENV;
  else env.CLOUDFLARE_ENV = lane.env;
  console.log(`\n== ${lane.name}: build and dry-run deploy`);
  run(["build"], env);
  run(
    ["exec", "wrangler", "deploy", "--dry-run", "--outdir", `.wrangler/dry-run/${lane.name}`],
    env,
  );
}
