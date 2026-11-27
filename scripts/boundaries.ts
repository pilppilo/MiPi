/**
 * The extension boundary (COD-208): no extension imports another. The tier rules (core imports no extension, an
 * extension imports no door) are oxlint overrides in `.oxlintrc.json`; this covers what a static pattern can't: one
 * extension's folder reaching into a sibling's, for every extension, including ones added later.
 *
 * An extension is a folder under `src/extensions/builtin/` or `src/extensions/optional/`. Its files may import core,
 * `src/lib/` and their own folder, never another extension's folder or the lists beside them (`src/extensions/*.ts`).
 */
import { dirname, join, normalize, relative, sep } from "node:path";

/** One source file: its path from the repo root (`/` separators) and its text. */
export type SourceFile = { readonly path: string; readonly text: string };

export type BoundaryProblem = {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
};

const TIERS = ["src/extensions/builtin/", "src/extensions/optional/"];

/** `src/extensions/builtin/memory` for a path inside that extension, or the folder itself; otherwise undefined. */
export function extensionOf(path: string): string | undefined {
  for (const tier of TIERS) {
    if (!path.startsWith(tier)) continue;
    const name = path.slice(tier.length).split("/")[0];
    return name === undefined || name.length === 0 ? undefined : `${tier}${name}`;
  }
  return undefined;
}

/** The text without its comments, so an import shown in a comment isn't read as one. Strings are left as they are. */
export function withoutComments(text: string): string {
  return text.replace(
    /\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/[^\n]*/g,
    (_match, before?: string) => before ?? "",
  );
}

/** Every module specifier a file imports or re-exports statically (`import … from`, `export … from`, `import "…"`). */
export function importSpecifiers(text: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']/g;
  for (const match of withoutComments(text).matchAll(pattern)) found.push(match[1]!);
  return found;
}

const toPosix = (path: string): string => path.split(sep).join("/");

/** The problems in `files`: imports from one extension into another, or into the extension lists. */
export function boundaryProblems(files: readonly SourceFile[]): BoundaryProblem[] {
  const problems: BoundaryProblem[] = [];
  for (const file of files) {
    const own = extensionOf(file.path);
    if (own === undefined) continue;
    for (const specifier of importSpecifiers(file.text)) {
      if (!specifier.startsWith(".")) continue;
      const target = toPosix(normalize(join(dirname(file.path), specifier)));
      const other = extensionOf(target);
      if (other !== undefined && other !== own) {
        problems.push({
          file: file.path,
          specifier,
          reason: `${own} imports ${other}: an extension never imports another (go through a core connector)`,
        });
      } else if (
        other === undefined &&
        target.startsWith("src/extensions/") &&
        !toPosix(relative("src/extensions", target)).includes("/")
      ) {
        problems.push({
          file: file.path,
          specifier,
          reason: `${own} imports ${target}: the extension lists sit above the extensions, not under them`,
        });
      }
    }
  }
  return problems;
}

/**
 * The module specifiers a file loads when it runs: every static import and re-export but those that are types as a
 * whole statement (`import type …`, `export type …`), which Node's type stripping removes. An inline `{ type X }`
 * still loads its module, so it counts.
 */
export function runtimeSpecifiers(text: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[^"'`;]*?\sfrom\s+)?["']([^"']+)["']/g;
  for (const match of withoutComments(text).matchAll(pattern)) {
    if (match[1] === undefined) found.push(match[2]!);
  }
  return found;
}

/**
 * Scripts that a workflow runs with Node alone, without `pnpm install` (`heartbeat.yml`), must load only Node's own
 * modules and other files under `scripts/`: one value import from `src/` reaches `@earendil-works/*`, and the script
 * dies before its first line. Walks the runtime imports from `entries`; `read` gives a file's text, or undefined.
 */
export function standaloneProblems(
  entries: readonly string[],
  read: (path: string) => string | undefined,
): BoundaryProblem[] {
  const problems: BoundaryProblem[] = [];
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = read(file);
    if (text === undefined) {
      problems.push({ file, specifier: file, reason: "the file can't be read" });
      continue;
    }
    for (const specifier of runtimeSpecifiers(text)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith(".")) {
        problems.push({
          file,
          specifier,
          reason: "a script run without pnpm install can load no package (use node: modules)",
        });
        continue;
      }
      const target = toPosix(normalize(join(dirname(file), specifier)));
      if (!target.startsWith("scripts/")) {
        problems.push({
          file,
          specifier,
          reason: `a script run without pnpm install can load nothing outside scripts/ (${target}); import types only`,
        });
        continue;
      }
      queue.push(target);
    }
  }
  return problems;
}
