/**
 * The Pi Durable ledger (`docs/pi-durable-ledger.md`): where MiPi departs from, works around, or depends on the inside
 * of Pi Durable, and what upstream is doing about it. Code that belongs to an entry carries a `pi-ledger L<n>` comment.
 * Parsing and checks only; `scripts/ledger-cli.ts` reads the files.
 */
export const LEDGER_PATH = "docs/pi-durable-ledger.md";
export const KINDS = ["workaround", "internals", "choice", "watch"] as const;
export type Kind = (typeof KINDS)[number];

export interface LedgerEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly open: boolean;
  /** The entry's text, heading included. */
  readonly text: string;
}

/** A `pi-ledger L<n>` comment in the code. */
export interface LedgerMarker {
  readonly id: string;
  readonly file: string;
  readonly line: number;
}

const MARKER = /pi-ledger (L\d+)/g;

/** Entries under `## Open` and `## Closed`, in order. */
export function parseLedger(markdown: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let open = false;
  for (const part of markdown.split(/^(?=## |### )/m)) {
    if (part.startsWith("## ")) {
      open = /^## Open\b/.test(part);
      continue;
    }
    const heading = /^### (L\d+) · (.+)$/m.exec(part);
    if (heading === null) continue;
    const kind = /^- \*\*Kind:\*\* (\S+)/m.exec(part)?.[1] ?? "";
    entries.push({ id: heading[1]!, title: heading[2]!.trim(), kind, open, text: part.trimEnd() });
  }
  return entries;
}

/** Every `pi-ledger L<n>` comment in one file's text. */
export function findMarkers(file: string, text: string): LedgerMarker[] {
  const markers: LedgerMarker[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(MARKER)) {
      markers.push({ id: match[1]!, file, line: index + 1 });
    }
  });
  return markers;
}

/** What is wrong between the ledger and the code's comments; empty when they agree. */
export function ledgerProblems(
  entries: readonly LedgerEntry[],
  markers: readonly LedgerMarker[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) problems.push(`${entry.id} appears twice in the ledger`);
    seen.add(entry.id);
    if (!(KINDS as readonly string[]).includes(entry.kind)) {
      problems.push(`${entry.id} has kind "${entry.kind}"; use one of ${KINDS.join(", ")}`);
    }
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const marker of markers) {
    const entry = byId.get(marker.id);
    const where = `${marker.file}:${marker.line}`;
    if (entry === undefined)
      problems.push(`${where} names ${marker.id}, which is not in the ledger`);
    else if (!entry.open)
      problems.push(`${where} names ${marker.id}, which is closed: remove the code or reopen it`);
  }
  for (const entry of entries) {
    if (entry.open && entry.kind !== "watch" && !markers.some((marker) => marker.id === entry.id)) {
      problems.push(
        `${entry.id} (${entry.kind}) has no "pi-ledger ${entry.id}" comment in the code`,
      );
    }
  }
  return problems;
}

/** The open entries as text, with where each one lives in the code. */
export function openEntriesReport(
  entries: readonly LedgerEntry[],
  markers: readonly LedgerMarker[],
): string {
  return entries
    .filter((entry) => entry.open)
    .map((entry) => {
      const places = markers
        .filter((marker) => marker.id === entry.id)
        .map((marker) => `${marker.file}:${marker.line}`);
      return places.length > 0 ? `${entry.text}\n- **Code:** ${places.join(", ")}` : entry.text;
    })
    .join("\n\n");
}
