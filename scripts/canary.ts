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
    const npmView = (...args: string[]): string =>
      execFileSync("npm", ["view", PI_DURABLE_PACKAGE, ...args], {
        encoding: "utf8",
        shell: process.platform === "win32",
      });
    const target = resolveCanaryTarget(process.env.VERSION_OVERRIDE, {
      latest: () => npmView("version"),
      published: () => npmView("versions", "--json"),
    });
    console.log(`Pi Durable canary: ${current} → ${target}`);
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
    // Print where the report went; utf8 keeps gh's stderr readable if a write fails.
    const post = (path: string, payload: object): string =>
      execFileSync("gh", ["api", "--method", "POST", path, "--input", "-", "--jq", ".html_url"], {
        encoding: "utf8",
        input: JSON.stringify(payload),
      }).trim();
    switch (report.kind) {
      case "create": {
        const url = post(endpoint, { title: report.title, body: report.body });
        console.log(`Created ${url} for the ${stage} failure.`);
        break;
      }
      case "comment": {
        const url = post(`${endpoint}/${report.issueNumber}/comments`, { body: report.body });
        console.log(`Commented on #${report.issueNumber} for the ${stage} failure: ${url}`);
        break;
      }
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
