/**
 * `remember` and `forget` (M8): the model's hands on memory (`memory.ts`). Both are replay-safe: a rerun of
 * `remember` finds its lesson already kept (a duplicate changes nothing), and a rerun of `forget` finds it gone.
 *
 * In a run that called a tool with untrusted output (`web_fetch`, declared by its extension), `remember` asks the owner
 * first (COD-173): text from a page can't write itself into every later conversation unless the owner says yes to
 * that exact lesson. The check reads the run's committed entries inside `remember`'s own commit, so it holds across a
 * restart mid-run. The call waits for the answer (`awaitApproval`); on approve it saves the lesson it asked about, and
 * on deny or no answer it saves nothing. A relay or bot turn is still refused outright: nobody there can approve.
 */
import type { ToolRegistration } from "../../../agent/pi/durable.ts";
import { str, obj } from "../../../agent/pi/schema.ts";
import { connectorsOf } from "../../../agent/connectors.ts";
import { runTouched, untrustedToolNames } from "../../../agent/untrusted.ts";
import { awaitApproval } from "../../../agent/approvals.ts";
import {
  addLesson,
  FORGET_TOOL_NAME,
  forgetLesson,
  MAX_LESSON,
  MAX_LESSONS,
  MemoryDoc,
  REMEMBER_TOOL_NAME,
} from "./memory.ts";

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

/** How long the owner has to answer a lesson from a turn that read a page. */
export const REMEMBER_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const rememberTool: ToolRegistration = {
  name: REMEMBER_TOOL_NAME,
  description:
    "Save a short lesson that should hold in every later conversation: a fact about the owner, a preference, or a standing instruction. " +
    `One sentence, at most ${MAX_LESSON} characters; at most ${MAX_LESSONS} lessons are kept. ` +
    "Save only what the owner said or clearly wants kept. After a web page was read in this turn, the owner is asked to confirm first.",
  parameters: obj({
    text: str({ minLength: 1, description: "The lesson, as one self-contained sentence" }),
  }),
  replay: "safe",
  approval: {
    kind: "self",
    describe: (args) => ({
      summary: `Save memory: "${String(args["text"] ?? "")}"`,
      reason: "This turn read a web page; confirm before it goes into long-term memory.",
    }),
    ttlMs: REMEMBER_APPROVAL_TTL_MS,
  },
  execute: async (args, api, context) => {
    const { text: lesson } = args as { text: string };
    // Woken from the park below: the owner answered this call, with these arguments, or the time ran out.
    let approved = false;
    if (api.wake !== undefined) {
      const step = await awaitApproval(api, context, REMEMBER_APPROVAL_TTL_MS);
      switch (step.kind) {
        case "approved":
          approved = true;
          break;
        case "refused":
          return step.result;
        case "park":
          return step.park;
        default: {
          const _: never = step;
          throw new Error("Unknown approval step");
        }
      }
    }
    const result = await api.commit(async (tx) => {
      const { origins } = connectorsOf(api.registry);
      const inputs = await origins.runInputs(tx, api.conversationId);
      if (inputs.some(({ authority }) => authority === "external")) {
        throw new Error(
          "Memory cannot be written in a turn that includes a relay or bot message. Ask the owner to send a new message directly.",
        );
      }
      const untrusted = untrustedToolNames(api.registry);
      if (!approved && (await runTouched(tx, api.conversationId, untrusted))) {
        return { kind: "ask" as const };
      }
      const { source } = await origins.runOrigin(tx, api.conversationId);
      return addLesson(
        await tx.doc(MemoryDoc),
        lesson,
        { source, conversationId: api.conversationId },
        api.now(),
      );
    }, context);
    switch (result.kind) {
      case "saved":
        return text(`Remembered as ${result.lesson.id}: ${result.lesson.text}`);
      case "duplicate":
        return text(`Already remembered as ${result.id}. Nothing changed.`);
      case "empty":
        throw new Error("The lesson is empty.");
      case "too-long":
        throw new Error(
          `The lesson is ${result.length} characters; at most ${MAX_LESSON} are allowed. Say it shorter.`,
        );
      case "full":
        throw new Error(
          `Memory is full (${MAX_LESSONS} lessons). Forget one that no longer holds first, or ask the owner which to drop.`,
        );
      case "ask": {
        // A fresh call (no wake): this is the park that asks the owner.
        const step = await awaitApproval(api, context, REMEMBER_APPROVAL_TTL_MS);
        if (step.kind === "park") return step.park;
        throw new Error("Not saved: the owner's approval could not be asked for.");
      }
      default: {
        const _: never = result;
        throw new Error("Unknown memory result");
      }
    }
  },
};

export const forgetTool: ToolRegistration = {
  name: FORGET_TOOL_NAME,
  description: "Remove a saved lesson by its id (shown in the memory section, like m3).",
  parameters: obj({
    id: str({ minLength: 1, description: "The lesson's id, like m3" }),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const { id } = args as { id: string };
    const removed = await api.commit(
      async (tx) => forgetLesson(await tx.doc(MemoryDoc), id),
      context,
    );
    if (removed === undefined) return text(`There is no lesson ${id.trim()}; nothing changed.`);
    return text(`Forgot ${removed.id}: ${removed.text}`);
  },
};
