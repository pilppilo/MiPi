import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { adminClientFromEnv } from "./admin-client.ts";
import { evaluateHeartbeat } from "./heartbeat-check.ts";

let result: ReturnType<typeof evaluateHeartbeat>;
let workerOrigin: string | undefined;
try {
  const { values } = parseArgs({ options: { url: { type: "string" } } });
  const url = values.url ?? process.env.WORKER_URL;
  if (!url) throw new Error("Set WORKER_URL or pass --url.");
  workerOrigin = new URL(url).origin;
  const call = adminClientFromEnv(url, process.env);
  const status = await call<unknown>("GET", "/api/admin/status");
  result = evaluateHeartbeat(status, Date.now());
} catch (error) {
  result = { ok: false, message: error instanceof Error ? error.message : String(error) };
}
const line = `${result.ok ? "Pass" : "Fail"}: ${result.message.replaceAll(/\s+/g, " ")}`;
console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
  const target = process.env.TARGET;
  const lane = target === "production" || target === "staging" ? ` (${target})` : "";
  const worker = workerOrigin === undefined ? "" : `\n\nWorker: ${workerOrigin}`;
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### MiPi heartbeat${lane}${worker}\n\n${line}\n`,
  );
}
if (!result.ok) process.exitCode = 1;
