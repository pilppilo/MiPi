/** The extension boundary (`scripts/boundaries.ts`): no extension imports another, or the lists above them. */
import { describe, expect, it } from "vitest";
import {
  boundaryProblems,
  extensionOf,
  importSpecifiers,
  runtimeSpecifiers,
  standaloneProblems,
} from "../scripts/boundaries.ts";

describe("extension boundaries", () => {
  it("knows which extension a file belongs to", () => {
    expect(extensionOf("src/extensions/builtin/memory/tools.ts")).toBe(
      "src/extensions/builtin/memory",
    );
    expect(extensionOf("src/extensions/optional/opencode-go/index.ts")).toBe(
      "src/extensions/optional/opencode-go",
    );
    expect(extensionOf("src/extensions/builtin/memory")).toBe("src/extensions/builtin/memory");
    expect(extensionOf("src/extensions/builtins.ts")).toBeUndefined();
    expect(extensionOf("src/agent/harness.ts")).toBeUndefined();
  });

  it("reads static imports and re-exports, type-only ones too", () => {
    expect(
      importSpecifiers(
        'import type { A } from "./a.ts";\nimport { b } from "../b.ts";\nexport { c } from "./c.ts";\nimport "./d.ts";',
      ),
    ).toEqual(["./a.ts", "../b.ts", "./c.ts", "./d.ts"]);
    // An import shown in a comment is not one.
    expect(
      importSpecifiers(
        '/** e.g. import { x } from "../other/foo.ts"; */\n// import { y } from "../y.ts";\nconst url = "https://example.com"; import { z } from "./z.ts";',
      ),
    ).toEqual(["./z.ts"]);
  });

  it("allows core, lib and an extension's own files", () => {
    expect(
      boundaryProblems([
        {
          path: "src/extensions/builtin/memory/index.ts",
          text: 'import { x } from "../../../agent/untrusted.ts";\nimport { y } from "./tools.ts";\nimport { z } from "../../../lib/fence.ts";',
        },
      ]),
    ).toEqual([]);
  });

  it("refuses an import from one extension into another, and into the lists", () => {
    const problems = boundaryProblems([
      {
        path: "src/extensions/builtin/web-fetch/index.ts",
        text: 'import { MemoryDoc } from "../memory/memory.ts";\nimport { BUILT_IN_EXTENSIONS } from "../../builtins.ts";',
      },
      {
        path: "src/extensions/optional/opencode-go/index.ts",
        text: 'import type { A } from "../../builtin/memory/index.ts";',
      },
      { path: "src/extensions/builtin/reminders/index.ts", text: 'import { m } from "../memory";' },
    ]);
    expect(problems.map(({ file, specifier }) => [file, specifier])).toEqual([
      ["src/extensions/builtin/web-fetch/index.ts", "../memory/memory.ts"],
      ["src/extensions/builtin/web-fetch/index.ts", "../../builtins.ts"],
      ["src/extensions/optional/opencode-go/index.ts", "../../builtin/memory/index.ts"],
      ["src/extensions/builtin/reminders/index.ts", "../memory"],
    ]);
  });
});

describe("standalone scripts", () => {
  it("count every import but whole-statement type imports as loaded", () => {
    expect(
      runtimeSpecifiers(
        [
          'import type { A } from "../src/protocol.ts";',
          'export type { B } from "../src/b.ts";',
          'import { type C } from "../src/c.ts";',
          'import { d } from "./d.ts";',
          'import "./e.ts";',
          '// import { f } from "../src/f.ts";',
          'import { appendFile } from "node:fs/promises";',
        ].join("\n"),
      ),
    ).toEqual(["../src/c.ts", "./d.ts", "./e.ts", "node:fs/promises"]);
  });

  it("let a script run without pnpm install load only node: modules and scripts/", () => {
    const files: Record<string, string> = {
      "scripts/heartbeat.ts":
        'import { a } from "./a.ts";\nimport { readFile } from "node:fs/promises";',
      "scripts/a.ts":
        'import type { DiagEvent } from "../src/protocol.ts";\nimport { b } from "./b.ts";',
      "scripts/b.ts": "export const b = 1;",
    };
    expect(standaloneProblems(["scripts/heartbeat.ts"], (path) => files[path])).toEqual([]);

    // The bug this guards (PR #51 review): one value import from `src/` reaches `@earendil-works/*`.
    files["scripts/b.ts"] =
      'import { parseDiagSnapshot } from "../src/protocol.ts";\nimport x from "pkg";';
    expect(standaloneProblems(["scripts/heartbeat.ts"], (path) => files[path])).toEqual([
      expect.objectContaining({ file: "scripts/b.ts", specifier: "../src/protocol.ts" }),
      expect.objectContaining({ file: "scripts/b.ts", specifier: "pkg" }),
    ]);
    expect(standaloneProblems(["scripts/missing.ts"], (path) => files[path])).toEqual([
      expect.objectContaining({ file: "scripts/missing.ts", reason: "the file can't be read" }),
    ]);
  });
});
