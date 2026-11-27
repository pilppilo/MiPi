/**
 * Workbench (COD-249, D · Spaces): the deep view of one bot. What it is doing now, step by step; what it waits on;
 * and how the other bots are. Plain names throughout (`names.ts`). Built from what the session already has: the
 * activity graph, the open conversation's live tools, the bots list. Stopping and steering a run are COD-250, and
 * the approvals waiting on the owner come with COD-238.
 */
import type { MouseEvent } from "react";
import type { ConversationSummary, TaskGraph, TaskGraphNode } from "../protocol.ts";
import { type BotActivity, tasksOfBot } from "./session/bots-list.ts";
import type { ToolProgress } from "./session/session-state.ts";
import { BotMark, botStatusLabel } from "./marks.tsx";
import { taskName, toolName } from "./names.ts";

export interface WorkbenchProps {
  readonly bot: ConversationSummary;
  readonly label: (summary: ConversationSummary) => string;
  /** The bots the drawer lists (MiPi first), for "Other bots". */
  readonly bots: readonly ConversationSummary[];
  readonly conversations: readonly ConversationSummary[];
  readonly graph: TaskGraph | undefined;
  /** The open conversation's tool calls in its current run: the running task's steps. */
  readonly tools: readonly ToolProgress[];
  readonly activity: ReadonlyMap<number, BotActivity>;
  readonly unread: ReadonlySet<number>;
  readonly onOpenBot: (conversationId: number) => void;
}

type Group = "running" | "waiting";

const groupOf = (task: TaskGraphNode): Group =>
  task.state.status === "sleeping" || task.state.status === "waiting" ? "waiting" : "running";

/** When a waiting task carries on, in words. */
function wakeText(task: TaskGraphNode): string {
  const state = task.state;
  switch (state.status) {
    case "sleeping":
      return state.until === undefined
        ? "Sleeps until something wakes it"
        : `Wakes ${new Date(state.until).toLocaleString(undefined, {
            weekday: "short",
            hour: "numeric",
            minute: "2-digit",
          })}`;
    case "waiting":
      return state.on.length === 1
        ? "Waiting on another task"
        : `Waiting on ${state.on.length} tasks`;
    case "pending":
      return "About to start";
    case "running":
      return "Working";
    case "completing":
      return "Finishing";
    default: {
      const _: never = state;
      return "";
    }
  }
}

const stepMark: Record<ToolProgress["status"], string> = {
  pending: "Queued",
  running: "Running",
  waiting: "Running",
  sleeping: "Running",
  done: "Done",
};

export function Workbench({
  bot,
  label,
  bots,
  conversations,
  graph,
  tools,
  activity,
  unread,
  onOpenBot,
}: WorkbenchProps) {
  const tasks = tasksOfBot(conversations, graph, bot.id);
  const running = tasks.filter((task) => groupOf(task) === "running");
  const waiting = tasks.filter((task) => groupOf(task) === "waiting");
  // The steps are the open conversation's own tool calls: they belong to its answering task, not to a subagent's.
  const stepsFor = (task: TaskGraphNode): readonly ToolProgress[] =>
    task.kind === "pi.generation" && task.conversationId === bot.id ? tools : [];
  const others = bots.filter(({ id }) => id !== bot.id);
  const name = label(bot);

  const open = (event: MouseEvent<HTMLAnchorElement>, conversationId: number): void => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    onOpenBot(conversationId);
  };

  return (
    <section className="workbench" aria-labelledby="workbench-heading">
      <h2 id="workbench-heading" className="visually-hidden">
        {name}'s workbench
      </h2>

      <section className="workbench-group" aria-labelledby="workbench-running">
        <h3 id="workbench-running" className="section-label">
          Running now
        </h3>
        {running.length === 0 ? (
          <p className="workbench-empty">
            Nothing running. {name} is {botStatusLabel(activity.get(bot.id)).toLowerCase()}.
          </p>
        ) : (
          <ul className="workbench-cards">
            {running.map((task) => {
              const steps = stepsFor(task);
              return (
                <li key={task.id} className="workbench-card workbench-card--running">
                  <p className="workbench-card-title">
                    <span className="workbench-pulse" aria-hidden="true" />
                    {taskName(task.kind)}
                    {task.conversationId === bot.id ? null : (
                      <span className="workbench-card-note">for a side chat</span>
                    )}
                  </p>
                  {steps.length === 0 ? null : (
                    <ol className="workbench-steps" aria-label="Steps">
                      {steps.map((step) => (
                        <li
                          key={step.callId}
                          className={`workbench-step workbench-step--${step.status}`}
                        >
                          <span className="workbench-step-mark" aria-hidden="true" />
                          {toolName(step.name)}
                          <span className="visually-hidden"> · {stepMark[step.status]}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {waiting.length === 0 ? null : (
        <section className="workbench-group" aria-labelledby="workbench-waiting">
          <h3 id="workbench-waiting" className="section-label">
            Waiting
          </h3>
          <ul className="workbench-cards">
            {waiting.map((task) => (
              <li key={task.id} className="workbench-card">
                <p className="workbench-card-title">{taskName(task.kind)}</p>
                <p className="workbench-card-note">{wakeText(task)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {others.length === 0 ? null : (
        <section className="workbench-group" aria-labelledby="workbench-others">
          <h3 id="workbench-others" className="section-label">
            Other bots
          </h3>
          <ul className="workbench-bots">
            {others.map((other) => (
              <li key={other.id}>
                <a
                  className="workbench-bot"
                  href={`?conversation=${other.id}&space=workbench`}
                  onClick={(event) => open(event, other.id)}
                >
                  <BotMark summary={other} activity={activity.get(other.id)} />
                  <span className="workbench-bot-text">
                    <strong>{label(other)}</strong>
                    <span>
                      {botStatusLabel(activity.get(other.id))}
                      {unread.has(other.id) ? " · new messages" : ""}
                    </span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
