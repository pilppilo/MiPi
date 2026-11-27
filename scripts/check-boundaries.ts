/**
 * Fails when one extension imports another, or when a script a workflow runs without `pnpm install` loads anything
 * outside `scripts/` (`scripts/boundaries.ts`). Part of `pnpm check`.
 *
 *   node scripts/check-boundaries.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { boundaryProblems, type SourceFile, standaloneProblems } from "./boundaries.ts";

/** Scripts a workflow runs with Node alone (`heartbeat.yml` has no `pnpm install` step). */
const STANDALONE_SCRIPTS = ["scripts/heartbeat.ts"];

function sourceFiles(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const files: SourceFile[] = sourceFiles(join("src", "extensions")).map((path) => ({
  path: relative(".", path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));
const problems = boundaryProblems(files);
for (const { file, specifier, reason } of problems) {
  console.error(`${file}: "${specifier}": ${reason}`);
}
if (problems.length > 0) {
  console.error(`${problems.length} extension boundary problem(s).`);
  process.exit(1);
}
console.log(`Extension boundaries hold (${files.length} files).`);

const standalone = standaloneProblems(STANDALONE_SCRIPTS, (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
});
for (const { file, specifier, reason } of standalone) {
  console.error(`${file}: "${specifier}": ${reason}`);
}
if (standalone.length > 0) {
  console.error(`${standalone.length} standalone script problem(s).`);
  process.exit(1);
}
console.log(
  `Standalone scripts load only node: modules and scripts/ (${STANDALONE_SCRIPTS.join(", ")}).`,
);
