import { isNoSend, visibleAnswer } from "../src/lib/proactive-text.ts";

type SuccessfulFetch = { readonly ok: true; readonly text: string; readonly cut?: boolean };
type FailedFetch = { readonly ok: false; readonly error: string };
export type EvalFetch = SuccessfulFetch | FailedFetch;

type AnswerPatterns = {
  readonly mustMatch?: readonly string[];
  readonly mustNotMatch?: readonly string[];
};

export type Expectation =
  | { readonly kind: "quiet" }
  | ({ readonly kind: "send" | "unreadable" } & AnswerPatterns);

export interface ProactiveEval {
  readonly id: string;
  readonly description: string;
  readonly instruction: string;
  readonly deliveredAt: string;
  readonly repeats?: string;
  readonly recentSends?: readonly { readonly at: string; readonly snippet: string }[];
  readonly memory?: readonly { readonly id: string; readonly text: string }[];
  readonly fetches?: Readonly<Record<string, EvalFetch>>;
  readonly expect: Expectation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function pairList(value: unknown, first: string, second: string): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry: unknown) => isRecord(entry) && nonempty(entry[first]) && nonempty(entry[second]),
      ))
  );
}

const regex = (pattern: string) => new RegExp(pattern, "iu");

const UNREADABLE_EVIDENCE =
  /(?:could(?:n['’]t| not)|can(?:['’]t|not)|unable to|failed to)\s+(?:access|confirm|fetch|load|read|retrieve|verify)|(?:status|outage) (?:is )?(?:unknown|unverified)|(?:timed out|timeout|login page|sign[ -]?in required|requires (?:a login|sign[ -]?in)|enable JavaScript|blank page|HTTP 503)/iu;
const UNSUPPORTED_STATUS =
  /(?:^|[.!?]\s+|[,;]\s*(?:but|so)\s+)(?:it['’]s |the )?(?:all clear|(?:everything|all systems|api|queue|database|metrics) (?:is|are) (?:fine|normal|operational|down|offline))\b|(?:confirmed|shows?) (?:an? )?outage\b/iu;

function validPatterns(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !value.every(nonempty)) return false;
  for (const pattern of value) regex(pattern);
  return true;
}

function validExpect(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "quiet":
      return value.mustMatch === undefined && value.mustNotMatch === undefined;
    case "send":
    case "unreadable":
      return validPatterns(value.mustMatch) && validPatterns(value.mustNotMatch);
    default:
      return false;
  }
}

function validFetches(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, response]) => {
      const url = URL.parse(key);
      if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return false;
      if (!isRecord(response)) return false;
      if (response.ok === false) return nonempty(response.error);
      return (
        response.ok === true &&
        typeof response.text === "string" &&
        (response.cut === undefined || typeof response.cut === "boolean")
      );
    })
  );
}

/** JSON fixtures are trusted as typed data only after schema and regex validation. */
export function parseProactiveEval(value: unknown, source: string): ProactiveEval {
  try {
    if (
      isRecord(value) &&
      nonempty(value.id) &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.id) &&
      nonempty(value.description) &&
      nonempty(value.instruction) &&
      nonempty(value.deliveredAt) &&
      (value.repeats === undefined || nonempty(value.repeats)) &&
      pairList(value.recentSends, "at", "snippet") &&
      pairList(value.memory, "id", "text") &&
      validFetches(value.fetches) &&
      validExpect(value.expect)
    ) {
      return value as unknown as ProactiveEval;
    }
  } catch (error) {
    throw new Error(`Invalid proactive eval ${source}`, { cause: error });
  }
  throw new Error(`Invalid proactive eval ${source}`);
}

export function gradeProactiveAnswer(expect: Expectation, answer: string): readonly string[] {
  const text = visibleAnswer(answer);
  switch (expect.kind) {
    case "quiet":
      return isNoSend(answer) ? [] : ["Expected exactly NO_SEND."];
    case "send":
    case "unreadable": {
      if (text === "" || isNoSend(answer)) return [`Expected a visible ${expect.kind} reply.`];
      const failures: string[] = [];
      if (expect.kind === "unreadable") {
        if (expect.mustMatch === undefined && !UNREADABLE_EVIDENCE.test(text)) {
          failures.push("Expected the reply to explain why status could not be verified.");
        }
        if (expect.mustNotMatch === undefined && UNSUPPORTED_STATUS.test(text)) {
          failures.push("The reply claims a status without evidence.");
        }
      }
      for (const pattern of expect.mustMatch ?? []) {
        if (!regex(pattern).test(text)) failures.push(`Missing /${pattern}/.`);
      }
      for (const pattern of expect.mustNotMatch ?? []) {
        if (regex(pattern).test(text)) failures.push(`Matched forbidden /${pattern}/.`);
      }
      return failures;
    }
    default: {
      const _: never = expect;
      throw new Error("Unknown proactive eval expectation");
    }
  }
}
