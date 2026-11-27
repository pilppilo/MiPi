import { Markdown } from "./Markdown.tsx";
import type { Stamp, ToolDiagnostic } from "../protocol.ts";
import { isNoSend } from "../lib/proactive-text.ts";
import type {
  TranscriptEntry,
  TranscriptGap,
  TranscriptToolCall,
  ToolProgress,
} from "./session/session-state.ts";

interface TranscriptListProps {
  readonly entries: readonly TranscriptEntry[];
  /** Missing ranges, each shown after the entry it follows. */
  readonly gaps?: readonly TranscriptGap[];
  readonly tools: readonly ToolProgress[];
  readonly runActive: boolean;
  readonly onFork?: (entryId: number) => void;
  readonly onFillGap?: (gap: TranscriptGap) => void;
  /** Leave out system entries (prompt sections, tool changes): they are the agent's setup, not the chat. */
  readonly hideSystem?: boolean;
}

export function TranscriptList({
  entries: allEntries,
  gaps = [],
  tools,
  runActive,
  onFork,
  onFillGap,
  hideSystem = false,
}: TranscriptListProps) {
  const entries = hideSystem ? allEntries.filter((entry) => entry.role !== "system") : allEntries;
  const { resultsByRequest, groupedResultIds } = correlateToolResults(entries);
  const progress = new Map(tools.map((tool) => [tool.callId, tool]));
  const gapsAfter = new Map<number, TranscriptGap>(gaps.map((gap) => [gap.after, gap]));
  const quiet = quietAnswers(entries);

  return (
    <ol className="transcript-list">
      {entries.flatMap((entry) => {
        const gap = gapsAfter.get(entry.id);
        const row = transcriptRow(entry);
        return gap === undefined
          ? [row]
          : [
              row,
              <li key={`gap-${gap.after}`}>
                <button
                  className="text-button transcript-load"
                  type="button"
                  onClick={() => onFillGap?.(gap)}
                >
                  Load missing messages
                </button>
              </li>,
            ];
      })}
    </ol>
  );

  function transcriptRow(entry: TranscriptEntry) {
    if (groupedResultIds.has(entry.id)) return null;

    if (entry.toolCalls !== undefined && entry.toolCalls.length > 0) {
      const results = resultsByRequest.get(entry.id);
      return (
        <li className="transcript-turn" key={entry.id}>
          {entry.text.length > 0 ? (
            <TranscriptMessage
              entry={entry}
              showStamp={!hideSystem}
              onFork={onFork === undefined ? undefined : () => onFork(entry.id)}
            />
          ) : (
            <ToolRequest
              entry={entry}
              onFork={onFork === undefined ? undefined : () => onFork(entry.id)}
            />
          )}
          <ol className="tool-executions" aria-label="Tool calls">
            {entry.toolCalls.map((call) => (
              <li key={call.callId}>
                <ToolExecution
                  call={call}
                  progress={progress.get(call.callId)}
                  result={results?.get(call.callId)}
                  runActive={runActive}
                />
              </li>
            ))}
          </ol>
        </li>
      );
    }

    if (quiet.has(entry.id)) {
      return (
        <li key={entry.id}>
          <p className="transcript-quiet" title={`Entry (id: ${entry.id}): NO_SEND`}>
            Nothing to report
          </p>
        </li>
      );
    }

    if (entry.toolResult !== undefined) {
      return (
        <li key={entry.id}>
          <ToolExecution
            call={{
              callId: entry.toolResult.callId,
              name: entry.toolResult.name,
              args: {},
            }}
            result={entry}
            runActive={false}
            showArguments={false}
          />
        </li>
      );
    }

    return (
      <li key={entry.id}>
        <TranscriptMessage
          entry={entry}
          showStamp={!hideSystem}
          onFork={onFork === undefined ? undefined : () => onFork(entry.id)}
        />
      </li>
    );
  }
}

/**
 * Answers a scheduled check gave as `NO_SEND` (M6): shown muted, as the Telegram door sends nothing for them. Only
 * when every input since the last answer was scheduled and no tool failed; otherwise the raw answer stays visible.
 */
export function quietAnswers(entries: readonly TranscriptEntry[]): ReadonlySet<number> {
  const quiet = new Set<number>();
  let inputs: Array<TranscriptEntry["role"]> = [];
  let failed = false;
  for (const entry of entries) {
    switch (entry.role) {
      case "user":
      case "scheduled":
        inputs.push(entry.role);
        break;
      case "tool":
        if (entry.toolResult?.isError === true) failed = true;
        break;
      case "assistant":
        if (entry.toolCalls !== undefined && entry.toolCalls.length > 0) break;
        if (
          isNoSend(entry.text) &&
          !failed &&
          inputs.length > 0 &&
          inputs.every((role) => role === "scheduled")
        ) {
          quiet.add(entry.id);
        }
        inputs = [];
        failed = false;
        break;
      case "compaction":
      case "reset":
        // What came before is summarised or gone; judge only what follows.
        inputs = [];
        failed = false;
        break;
      case "system":
      case "event":
        break;
      default: {
        const _: never = entry.role;
        return _;
      }
    }
  }
  return quiet;
}

function correlateToolResults(entries: readonly TranscriptEntry[]): {
  readonly resultsByRequest: ReadonlyMap<number, ReadonlyMap<string, TranscriptEntry>>;
  readonly groupedResultIds: ReadonlySet<number>;
} {
  const pending = new Map<string, number[]>();
  const resultsByRequest = new Map<number, Map<string, TranscriptEntry>>();
  const groupedResultIds = new Set<number>();

  for (const entry of entries) {
    for (const call of entry.toolCalls ?? []) {
      const requests = pending.get(call.callId) ?? [];
      requests.push(entry.id);
      pending.set(call.callId, requests);
    }
    if (entry.toolResult === undefined) continue;

    const requests = pending.get(entry.toolResult.callId);
    const requestId = requests?.shift();
    if (requestId === undefined) continue;
    const results = resultsByRequest.get(requestId) ?? new Map<string, TranscriptEntry>();
    results.set(entry.toolResult.callId, entry);
    resultsByRequest.set(requestId, results);
    groupedResultIds.add(entry.id);
    if (requests?.length === 0) pending.delete(entry.toolResult.callId);
  }

  return { resultsByRequest, groupedResultIds };
}

interface ToolExecutionProps {
  readonly call: TranscriptToolCall;
  readonly progress?: ToolProgress;
  readonly result?: TranscriptEntry;
  readonly runActive: boolean;
  readonly showArguments?: boolean;
}

type ToolDisplayStatus = "waiting" | "running" | "completed" | "failed" | "missing";

function ToolExecution({
  call,
  progress,
  result,
  runActive,
  showArguments = true,
}: ToolExecutionProps) {
  const committed = result?.toolResult;
  const status: ToolDisplayStatus =
    committed !== undefined
      ? committed.isError
        ? "failed"
        : "completed"
      : progress?.status === "running" ||
          progress?.status === "waiting" ||
          progress?.status === "sleeping"
        ? "running"
        : progress?.status === "done"
          ? "completed"
          : runActive
            ? "waiting"
            : "missing";
  const output = result?.text ?? progress?.output;
  const details = committed?.details ?? progress?.details;
  const diagnostics = result?.diagnostics ?? progress?.diagnostics;
  const timestamp = result?.timestamp === undefined ? undefined : new Date(result.timestamp);

  return (
    <article
      className={`tool-execution tool-execution--${status}`}
      aria-busy={status === "waiting" || status === "running"}
    >
      <header>
        <strong>{call.name}</strong>
        <span className="tool-status">{toolStatusLabel[status]}</span>
        {timestamp === undefined ? null : <MessageTime timestamp={timestamp} />}
      </header>
      {showArguments ? (
        <details>
          <summary>Arguments</summary>
          <pre>{JSON.stringify(call.args, null, 2)}</pre>
        </details>
      ) : null}
      {output === undefined || output.length === 0 ? null : (
        <ToolOutput text={output} details={details} open={status === "failed"} />
      )}
      {details === undefined ? null : (
        <details>
          <summary>Details</summary>
          <pre>{JSON.stringify(details, null, 2)}</pre>
        </details>
      )}
      {committed?.nestedCalls === undefined ? null : (
        <details>
          <summary>Nested tool calls</summary>
          <pre>{JSON.stringify(committed.nestedCalls, null, 2)}</pre>
        </details>
      )}
      {diagnostics === undefined || diagnostics.length === 0 ? null : (
        <Diagnostics diagnostics={diagnostics} />
      )}
    </article>
  );
}

const toolStatusLabel: Record<ToolDisplayStatus, string> = {
  waiting: "Waiting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  missing: "No result",
};

/** Roles whose text is the model's own markdown, shown formatted; everything else is shown as written. */
const formattedRoles: ReadonlySet<TranscriptEntry["role"]> = new Set(["assistant", "compaction"]);

/** Past these, a tool's output starts collapsed: a fetched page can be 50,000 characters. */
export const TOOL_OUTPUT_OPEN_CHARS = 600;
export const TOOL_OUTPUT_OPEN_LINES = 12;

/**
 * A tool's output: shown as written, and collapsed behind a one-line summary when it is long, unless `open` (a
 * failure, so it shows at once). The summary names what the output is about (a fetched page's URL from the tool's
 * details) and how long it is.
 */
export function ToolOutput({
  text,
  details,
  open,
}: {
  readonly text: string;
  readonly details?: unknown;
  readonly open: boolean;
}) {
  const long =
    text.length > TOOL_OUTPUT_OPEN_CHARS || text.split("\n").length > TOOL_OUTPUT_OPEN_LINES;
  if (!long || open) return <MessageText text={text} />;
  // `in` on the tool's own `details` (unknown on the wire): `web_fetch` puts the page's URL there.
  const url =
    typeof details === "object" &&
    details !== null &&
    "url" in details &&
    typeof details.url === "string" &&
    details.url.trim().length > 0
      ? details.url.trim()
      : undefined;
  const firstLine = (text.split("\n").find((line) => line.trim().length > 0) ?? "").trim();
  const subject = url ?? (firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine);
  return (
    <details className="tool-output">
      <summary>
        {/* Blank output (all whitespace) has no line to name it by. */}
        {subject.length === 0 ? "Output" : subject} · {text.length.toLocaleString("en-US")}{" "}
        characters
      </summary>
      <MessageText text={text} />
    </details>
  );
}

const roleLabel: Record<TranscriptEntry["role"], string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
  tool: "Tool",
  scheduled: "Scheduled",
  compaction: "Context summary",
  reset: "Context reset",
  event: "Event",
};

function ToolRequest({
  entry,
  onFork,
}: {
  readonly entry: TranscriptEntry;
  readonly onFork?: () => void;
}) {
  const timestamp = entry.timestamp === undefined ? undefined : new Date(entry.timestamp);

  return (
    <article className="transcript-message transcript-message--assistant transcript-message--tool-request">
      <header>
        <EntryTitle
          entryId={entry.id}
          label="Assistant"
          detail="Tool request"
          timestamp={timestamp}
        />
        {onFork === undefined ? null : <ForkAction onFork={onFork} />}
      </header>
    </article>
  );
}

export function TranscriptMessage({
  entry,
  onFork,
  showStamp = false,
}: {
  readonly entry: TranscriptEntry;
  readonly onFork?: () => void;
  /** With the system entries shown: who sent a user message and when, as the model read it (COD-248). */
  readonly showStamp?: boolean;
}) {
  const timestamp = entry.timestamp === undefined ? undefined : new Date(entry.timestamp);

  return (
    <article className={`transcript-message transcript-message--${entry.role}`}>
      <header>
        <EntryTitle entryId={entry.id} label={roleLabel[entry.role]} timestamp={timestamp} />
        {!entry.canFork || onFork === undefined ? null : <ForkAction onFork={onFork} />}
      </header>
      {showStamp && entry.stamp !== undefined ? <MessageStamp stamp={entry.stamp} /> : null}
      {formattedRoles.has(entry.role) ? (
        <Markdown text={entry.text} />
      ) : (
        <MessageText text={entry.text} />
      )}
      {entry.diagnostics === undefined ? null : <Diagnostics diagnostics={entry.diagnostics} />}
    </article>
  );
}

function EntryTitle({
  entryId,
  label,
  detail,
  timestamp,
}: {
  readonly entryId: number;
  readonly label: string;
  readonly detail?: string;
  readonly timestamp?: Date;
}) {
  return (
    <div className="transcript-message-title" title={`Entry (id: ${entryId})`}>
      <strong>{label}</strong>
      {detail === undefined ? null : <span>{detail}</span>}
      {timestamp === undefined ? null : <MessageTime timestamp={timestamp} />}
    </div>
  );
}

function ForkAction({ onFork }: { readonly onFork: () => void }) {
  return (
    <button
      className="text-button transcript-fork"
      type="button"
      aria-label="Fork from this entry"
      onClick={onFork}
    >
      Fork
    </button>
  );
}

function MessageTime({ timestamp }: { readonly timestamp: Date }) {
  return (
    <time dateTime={timestamp.toISOString()} title={formatAbsoluteTime(timestamp)}>
      {formatMessageTime(timestamp)}
    </time>
  );
}

export function Diagnostics({ diagnostics }: { readonly diagnostics: readonly ToolDiagnostic[] }) {
  return (
    <ul className="diagnostics">
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code ?? "diagnostic"}-${index}`}>
          <strong>{capitalize(diagnostic.severity)}</strong>: {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}

/** `jerome · Fri, Nov 27, 2026, 16:32 CST`: the stamp the model read, shown as a quiet line above the message. */
export function MessageStamp({ stamp }: { readonly stamp: Stamp }) {
  return (
    <p className="message-stamp">
      {stamp.speaker} · {stamp.time}
    </p>
  );
}

export function MessageText({ text }: { readonly text: string }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </>
  );
}

const formatMessageTime = (timestamp: Date): string => {
  const now = new Date();
  const isToday =
    timestamp.getDate() === now.getDate() &&
    timestamp.getMonth() === now.getMonth() &&
    timestamp.getFullYear() === now.getFullYear();
  return timestamp.toLocaleString(undefined, {
    ...(isToday ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatAbsoluteTime = (timestamp: Date): string =>
  timestamp.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });

const capitalize = (value: string): string =>
  value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
