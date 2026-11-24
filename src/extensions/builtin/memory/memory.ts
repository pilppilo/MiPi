/**
 * Memory (M8): short lessons MiPi keeps across conversations and doors, in one session document. The model saves them
 * with `remember` and removes them with `forget` (`tools.ts`), and sees them in the `memory` prompt section
 * of every conversation that is offered `remember`. Rules adapted from pi-pocket src/server/memory.ts @ 2f060f2
 * (`MAX_LESSON`, the lesson limit, and invisible characters stripped with `INVISIBLE_CLASS`).
 *
 * The section changes only when a lesson does, so the prompt prefix stays cacheable between changes.
 */
import { defineDoc, section } from "../../../agent/pi/durable.ts";
import { defang, INVISIBLE_CLASS } from "../../../lib/fence.ts";

/** How long a lesson may be, in characters (code points). */
export const MAX_LESSON = 300;
/** How many lessons are kept. A full memory refuses more until one is forgotten. */
export const MAX_LESSONS = 20;
/** The tool names: the section shows only where `remember` is offered. */
export const REMEMBER_TOOL_NAME = "remember";
export const FORGET_TOOL_NAME = "forget";

/**
 * Where a lesson came from: the turn's input origin (`src/agent/origin.ts`: `web`, `telegram`, `relay`, `reminder`,
 * `unknown`), or `background` for the memory pass. Stored as written; memory names no door.
 */
export type LessonSource = string;

export type Lesson = {
  /** `m1`, `m2`, …: never reused, so `forget` never shifts another lesson's id. */
  id: string;
  text: string;
  at: number;
  from: { source: LessonSource; conversationId: number };
};

export type MemoryState = {
  /** The number the next lesson's id gets. */
  nextId: number;
  /** Oldest first. */
  lessons: Lesson[];
};

export const MEMORY_DOC_KIND = "app.memory";

export const MemoryDoc = defineDoc<MemoryState>({
  kind: MEMORY_DOC_KIND,
  version: 1,
  scope: "session",
  initial: () => ({ nextId: 1, lessons: [] }),
  // At most 20 short lessons: every change can be a full base.
  checkpointWhen: () => true,
});

const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "gu");

/**
 * A lesson's text as it is kept: one line with nothing hidden. Whitespace becomes a space first, since
 * `INVISIBLE_CLASS` includes the control characters (`\n`, `\t`) and would otherwise glue the words around a line break
 * together (pi-pocket's `flat()` does the same). Then invisible characters go, and runs of spaces become one.
 */
export const normalizeLesson = (text: string): string =>
  text.replace(/\s+/g, " ").replace(INVISIBLE, "").replace(/ {2,}/g, " ").trim();

/** What adding a lesson did. */
export type AddResult =
  | { readonly kind: "saved"; readonly lesson: Lesson }
  /** The same text is already kept, under this id: nothing changed. */
  | { readonly kind: "duplicate"; readonly id: string }
  | { readonly kind: "empty" }
  | { readonly kind: "too-long"; readonly length: number }
  | { readonly kind: "full" };

/** Adds a lesson by the rules, in this order: normalize, refuse empty, refuse too long, skip a duplicate, refuse a 21st. */
export function addLesson(
  state: MemoryState,
  text: string,
  from: Lesson["from"],
  now: number,
): AddResult {
  const normalized = normalizeLesson(text);
  if (normalized.length === 0) return { kind: "empty" };
  // Code points, so an emoji counts as one character, as people count it.
  const length = [...normalized].length;
  if (length > MAX_LESSON) return { kind: "too-long", length };
  const existing = state.lessons.find((lesson) => lesson.text === normalized);
  if (existing !== undefined) return { kind: "duplicate", id: existing.id };
  if (state.lessons.length >= MAX_LESSONS) return { kind: "full" };
  const lesson: Lesson = { id: `m${state.nextId}`, text: normalized, at: now, from: { ...from } };
  state.nextId += 1;
  // Assigned, not pushed: a value assigned to a draft is copied, so a push onto it could be lost.
  state.lessons = [...state.lessons.map((kept) => ({ ...kept, from: { ...kept.from } })), lesson];
  return { kind: "saved", lesson };
}

/** Removes a lesson by id. Undefined when there is none. */
export function forgetLesson(state: MemoryState, id: string): Lesson | undefined {
  const found = state.lessons.find((lesson) => lesson.id === id.trim());
  if (found === undefined) return undefined;
  const removed: Lesson = { ...found, from: { ...found.from } };
  state.lessons = state.lessons
    .filter((lesson) => lesson.id !== removed.id)
    .map((lesson) => ({ ...lesson, from: { ...lesson.from } }));
  return removed;
}

/** The section's text, or undefined when there is nothing to show. */
export function renderMemory(lessons: readonly Pick<Lesson, "id" | "text">[]): string | undefined {
  if (lessons.length === 0) return undefined;
  return [
    "Lessons you saved with remember, oldest first. They hold across conversations; forget one by its id when it no longer holds.",
    ...lessons.map((lesson) => `- [${lesson.id}] ${defang(lesson.text)}`),
  ].join("\n");
}

/**
 * The `memory` prompt section: the lessons, only where `remember` is offered. Rendered after the static preamble, so a
 * new lesson changes only the end of the system prompt.
 */
export const memorySection = section("memory", async (input, context) => {
  if (!input.agent.tools.some((tool) => tool.name === REMEMBER_TOOL_NAME)) return undefined;
  const state = await input.read.snapshot(MemoryDoc, context);
  return renderMemory(state?.lessons ?? []);
});
