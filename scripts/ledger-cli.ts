/**
 * Reads the Pi Durable ledger and the `pi-ledger L<n>` comments in `src/`, `scripts/` and `test/`.
 *
 *   pnpm ledger           prints the open entries and where each lives in the code
 *   pnpm ledger --check   fails if comments and entries disagree (part of `pnpm check`)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findMarkers,
  LEDGER_PATH,
  type LedgerEntry,
  type LedgerMarker,
  ledgerProblems,
  openEntriesReport,
  parseLedger,
} from "./ledger.ts";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css|jsonc)$/.test(entry.name) ? [path] : [];
  });
}

/** The ledger's entries and the markers in `src/`, `scripts/` and `test/`, read from disk. */
function readLedger(): { entries: LedgerEntry[]; markers: LedgerMarker[] } {
  const entries = parseLedger(readFileSync(LEDGER_PATH, "utf8"));
  const markers = ["src", "scripts", "test"]
    .flatMap(sourceFiles)
    .filter(
      (file) =>
        !file.startsWith(join("scripts", "ledger")) && file !== join("test", "ledger.test.ts"),
    )
    .flatMap((file) => findMarkers(file, readFileSync(file, "utf8")));
  return { entries, markers };
}

if (process.argv.includes("--check")) {
  const { entries, markers } = readLedger();
  const problems = ledgerProblems(entries, markers);
  if (problems.length > 0) {
    console.error(
      `${LEDGER_PATH} and the code disagree:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    process.exit(1);
  }
} else {
  const { entries, markers } = readLedger();
  console.log(openEntriesReport(entries, markers));
}
