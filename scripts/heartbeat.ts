import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type AdminCall, adminClientFromEnv } from "./admin-client.ts";
import { evaluateHeartbeat } from "./heartbeat-check.ts";
import { recentFaultLines } from "./heartbeat-events.ts";

let result: ReturnType<typeof evaluateHeartbeat>;
let workerOrigin: string | undefined;
let call: AdminCall | undefined;
try {
  const { values } = parseArgs({ options: { url: { type: "string" } } });
  const url = values.url ?? process.env.WORKER_URL;
  if (!url) throw new Error("Set WORKER_URL or pass --url.");
  workerOrigin = new URL(url).origin;
  call = adminClientFromEnv(url, process.env);
  const status = await call<unknown>("GET", "/api/admin/status");
  result = evaluateHeartbeat(status, Date.now());
} catch (error) {
  result = { ok: false, message: error instanceof Error ? error.message : String(error) };
}
const line = `${result.ok ? "Pass" : "Fail"}: ${result.message.replaceAll(/\s+/g, " ")}`;
console.log(line);
// On a failure, the agent's own latest warnings and errors, when it can be reached at all.
const recent = !result.ok && call !== undefined ? await recentFaultLines(call) : [];
if (recent.length > 0) console.log(["Recent warnings and errors:", ...recent].join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  const target = process.env.TARGET;
  const lane = target === "production" || target === "staging" ? ` (${target})` : "";
  const worker = workerOrigin === undefined ? "" : `\n\nWorker: ${workerOrigin}`;
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### MiPi heartbeat${lane}${worker}\n\n${line}\n` +
      (recent.length === 0
        ? ""
        : `\n#### Recent warnings and errors\n\n${recent.map((entry) => `- ${entry.replaceAll("`", "'")}`).join("\n")}\n`),
  );
}
if (!result.ok) process.exitCode = 1;
