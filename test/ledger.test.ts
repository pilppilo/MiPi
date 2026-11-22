import { describe, expect, it } from "vitest";
import { findMarkers, ledgerProblems, parseLedger } from "../scripts/ledger.ts";

const ledger = `# Pi Durable ledger

Intro.

## Open

### L1 · Keys from bindings

- **Kind:** workaround
- **Upstream:** reads process.env.

### L2 · Waiting on compaction

- **Kind:** watch

## Closed

### L3 · Old thing

- **Kind:** workaround
`;

describe("Pi Durable ledger", () => {
  const entries = parseLedger(ledger);

  it("reads entries, their kind, and whether they are open", () => {
    expect(entries.map(({ id, title, kind, open }) => ({ id, title, kind, open }))).toEqual([
      { id: "L1", title: "Keys from bindings", kind: "workaround", open: true },
      { id: "L2", title: "Waiting on compaction", kind: "watch", open: true },
      { id: "L3", title: "Old thing", kind: "workaround", open: false },
    ]);
  });

  it("finds marker comments with their line", () => {
    expect(findMarkers("a.ts", "x\n// pi-ledger L1: why\n")).toEqual([
      { id: "L1", file: "a.ts", line: 2 },
    ]);
  });

  it("agrees when every coded entry has a comment; watch entries need none", () => {
    expect(ledgerProblems(entries, [{ id: "L1", file: "a.ts", line: 2 }])).toEqual([]);
  });

  it("flags unknown ids, closed ids, missing comments, and bad kinds", () => {
    const problems = ledgerProblems(
      [...entries, { id: "L4", title: "x", kind: "hack", open: true, text: "" }],
      [
        { id: "L9", file: "a.ts", line: 1 },
        { id: "L3", file: "b.ts", line: 5 },
        { id: "L4", file: "c.ts", line: 1 },
      ],
    );
    expect(problems).toEqual([
      'L4 has kind "hack"; use one of workaround, internals, choice, watch',
      "a.ts:1 names L9, which is not in the ledger",
      "b.ts:5 names L3, which is closed: remove the code or reopen it",
      'L1 (workaround) has no "pi-ledger L1" comment in the code',
    ]);
  });
});
