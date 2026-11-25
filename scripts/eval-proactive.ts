import { readdir, readFile } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { CORE_PREAMBLE } from "../src/agent/harness.ts";
import type { Message } from "../src/agent/pi/ai.ts";
import { createGoModels, DEFAULT_MODEL_ID, MODEL_PROVIDER } from "../src/agent/pi/models.ts";
import { renderMemory } from "../src/extensions/builtin/memory/memory.ts";
import {
  WEB_FETCH_TOOL_NAME,
  webFetchDefinition,
} from "../src/extensions/builtin/web-fetch/definition.ts";
import { fencedPage } from "../src/extensions/builtin/web-fetch/fenced.ts";
import { visibleAnswer } from "../src/lib/proactive-text.ts";
import { formatReminder } from "../src/protocol.ts";
import { gradeProactiveAnswer, parseProactiveEval, type ProactiveEval } from "./proactive-evals.ts";

const TOOL_ROUNDS = 2;

async function loadCases(): Promise<ProactiveEval[]> {
  const dir = new URL("../evals/proactive/", import.meta.url);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) throw new Error("No proactive eval fixtures found.");
  const cases = await Promise.all(
    files.map(async (file) =>
      parseProactiveEval(JSON.parse(await readFile(new URL(file, dir), "utf8")), file),
    ),
  );
  if (new Set(cases.map(({ id }) => id)).size !== cases.length) {
    throw new Error("Proactive eval IDs must be unique.");
  }
  return cases;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { model: { type: "string" }, "env-file": { type: "string" } },
  });
  if (values["env-file"]) loadEnvFile(values["env-file"]);
  if (!process.env.OPENCODE_API_KEY?.trim()) {
    throw new Error("Set OPENCODE_API_KEY or pass --env-file .dev.vars.");
  }
  const models = createGoModels((name) => process.env[name]);
  const modelId = values.model || process.env.MIPI_EVAL_MODEL || DEFAULT_MODEL_ID;
  const model = models.getModel(MODEL_PROVIDER, modelId);
  if (model === undefined) throw new Error(`Unknown ${MODEL_PROVIDER} model ${modelId}.`);

  for (const test of await loadCases()) {
    const started = Date.now();
    let tokens = 0;
    let cost = 0;
    let answer = "";
    const issues: string[] = [];
    const fetched = new Set<string>();
    const memory = renderMemory(test.memory ?? []);
    const systemPrompt =
      memory === undefined ? CORE_PREAMBLE : `${CORE_PREAMBLE}\n\n<memory>\n${memory}\n</memory>`;
    const messages: Message[] = [
      {
        role: "user",
        content: formatReminder(test, test.deliveredAt, test.repeats, test.recentSends),
        timestamp: started,
      },
    ];

    try {
      for (let round = 0; round <= TOOL_ROUNDS; round += 1) {
        const reply = await models.completeSimple(
          model,
          { systemPrompt, messages, tools: [webFetchDefinition] },
          {
            sessionId: `eval-proactive-${test.id}`,
            reasoning: "low",
            signal: AbortSignal.timeout(60_000),
          },
        );
        tokens += reply.usage.totalTokens;
        cost += reply.usage.cost.total;
        if (
          reply.stopReason === "error" ||
          reply.stopReason === "aborted" ||
          reply.stopReason === "length"
        ) {
          throw new Error(reply.errorMessage ?? `Model stopped with ${reply.stopReason}.`);
        }
        const calls = reply.content.filter((part) => part.type === "toolCall");
        if (calls.length === 0) {
          answer = reply.content
            .filter((part) => part.type === "text")
            .map(({ text }) => text)
            .join("");
          issues.push(...gradeProactiveAnswer(test.expect, answer));
          break;
        }
        if (round === TOOL_ROUNDS) {
          issues.push(`Exceeded ${TOOL_ROUNDS} tool rounds.`);
          break;
        }
        messages.push(reply);
        for (const call of calls) {
          const url = call.arguments.url;
          const fixture =
            call.name === WEB_FETCH_TOOL_NAME && typeof url === "string" && test.fetches
              ? Object.hasOwn(test.fetches, url.trim())
                ? test.fetches[url.trim()]
                : undefined
              : undefined;
          let text = "No mock response for this tool call.";
          if (fixture !== undefined && typeof url === "string") {
            const address = url.trim();
            fetched.add(address);
            text = fixture.ok
              ? fencedPage({
                  url: address,
                  status: 200,
                  text: fixture.text,
                  cut: fixture.cut ?? false,
                })
              : fixture.error;
          }
          messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text }],
            isError: fixture?.ok !== true,
            timestamp: Date.now(),
          });
        }
      }
      for (const url of Object.keys(test.fetches ?? {})) {
        if (!fetched.has(url)) issues.push(`Mock source was never fetched: ${url}.`);
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }

    const metrics = `${Date.now() - started} ms, ${tokens} tokens, $${cost.toFixed(5)} estimated`;
    const detail =
      issues.length === 0
        ? ""
        : ` ${issues.join(" ").replaceAll(/\s+/g, " ")} Answer: ${JSON.stringify(visibleAnswer(answer).slice(0, 500))}`;
    console.log(`${issues.length === 0 ? "PASS" : "FAIL"} ${test.id} (${metrics})${detail}`);
    if (issues.length !== 0) process.exitCode = 1;
  }
}

await main();
