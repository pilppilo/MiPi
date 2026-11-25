import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { CANARY_STAGES, planCanaryReport, resolveCanaryTarget } from "./canary-report.ts";
import { isPiVersion, PI_DURABLE_PACKAGE } from "./pi-version.ts";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const mode = process.argv[2];
switch (mode) {
  case "target": {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    const current = manifest.dependencies[PI_DURABLE_PACKAGE];
    if (current === undefined || !isPiVersion(current)) {
      throw new Error("Expected an exact Pi Durable version in package.json.");
    }
    const target = resolveCanaryTarget(process.env.VERSION_OVERRIDE, () =>
      execFileSync("npm", ["view", PI_DURABLE_PACKAGE, "version"], {
        encoding: "utf8",
        shell: process.platform === "win32",
      }),
    );
    appendFileSync(requiredEnv("GITHUB_OUTPUT"), `current=${current}\ntarget=${target}\n`);
    break;
  }
  case "report": {
    const repo = requiredEnv("GITHUB_REPOSITORY");
    const current = requiredEnv("CURRENT");
    const target = requiredEnv("TARGET");
    const stage = CANARY_STAGES.find(
      (name) => process.env[`CANARY_${name.toUpperCase()}_OUTCOME`] === "failure",
    );
    if (stage === undefined) throw new Error("No failed canary stage to report.");
    const runUrl = `${requiredEnv("GITHUB_SERVER_URL")}/${repo}/actions/runs/${requiredEnv("GITHUB_RUN_ID")}`;
    const endpoint = `repos/${repo}/issues`;
    const list = execFileSync(
      "gh",
      ["api", "--paginate", "--slurp", `${endpoint}?state=open&per_page=100`],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    const report = planCanaryReport(JSON.parse(list), { current, target, stage, runUrl });
    switch (report.kind) {
      case "create":
        execFileSync("gh", ["api", "--method", "POST", endpoint, "--input", "-", "--silent"], {
          input: JSON.stringify({ title: report.title, body: report.body }),
        });
        break;
      case "comment":
        execFileSync(
          "gh",
          [
            "api",
            "--method",
            "POST",
            `${endpoint}/${report.issueNumber}/comments`,
            "--input",
            "-",
            "--silent",
          ],
          { input: JSON.stringify({ body: report.body }) },
        );
        break;
      default: {
        const _: never = report;
        throw new Error("Unknown canary report.");
      }
    }
    break;
  }
  default:
    throw new Error("Usage: node scripts/canary.ts <target|report>");
}
