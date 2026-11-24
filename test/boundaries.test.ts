/** The extension boundary (`scripts/boundaries.ts`): no extension imports another, or the lists above them. */
import { describe, expect, it } from "vitest";
import { boundaryProblems, extensionOf, importSpecifiers } from "../scripts/boundaries.ts";

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
