/**
 * Every message that enters a conversation carries who sent it and when, in the owner's local time. This replaces a
 * "current time" system-prompt section: a section that changes every minute appends a new system entry each turn
 * and keeps the prompt prefix from staying identical, which is what provider prompt caches key on. The system
 * prompt is now static; time travels with the messages. Every door (web, Telegram, relay, scheduled deliveries)
 * stamps input through here, so caching never depends on which door a message came through.
 */

export const DEFAULT_TIME_ZONE = "America/Chicago";

let agentTimeZone = DEFAULT_TIME_ZONE;

/** Sets the owner's time zone (`MIPI_TIMEZONE`) for stamps made without one. Invalid zones are ignored. */
export function setAgentTimeZone(timeZone: string | undefined): void {
  if (timeZone !== undefined && isTimeZone(timeZone)) agentTimeZone = timeZone;
}

export function agentTimeZoneName(): string {
  return agentTimeZone;
}

function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `Sun, Nov 22, 2026, 12:40 CST`: minute precision, with the zone, in the owner's time zone by default. */
export function localTime(at: number, timeZone: string = agentTimeZone): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: isTimeZone(timeZone) ? timeZone : agentTimeZone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(at);
}

/** A user message as the model sees it: `[speaker · local time]` on the first line, then the text. */
export function stampInput(speaker: string, content: string, at: number = Date.now()): string {
  return `[${speaker} · ${localTime(at)}]\n${content}`;
}

/** The system-prompt line that tells the model how to read stamps. Static, so the prompt prefix never changes. */
export const STAMP_INSTRUCTIONS =
  "Each user message begins with [speaker · local time]: who sent it and when, in the owner's time zone. Treat it as speaker attribution and as the current time when that message arrived.";
