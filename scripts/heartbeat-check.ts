export const ALARM_LOST_WINDOW_MS = 26 * 60 * 60_000;

const HOLDS = new Set(["paused", "spend-cap", "provider-limit", "run-cap"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15;

export function evaluateHeartbeat(
  status: unknown,
  now: number,
): {
  readonly ok: boolean;
  readonly message: string;
} {
  const state = isRecord(status) && isRecord(status.state) ? status.state.kind : undefined;
  if (state !== "open") {
    return {
      ok: false,
      message: `Agent state: ${state === "maintenance" || state === "refused" ? state : "unknown"}.`,
    };
  }
  const heartbeat = isRecord(status) ? status.heartbeat : undefined;
  if (!isRecord(heartbeat)) return { ok: false, message: "Missing heartbeat status." };
  const { alarmLost, activeSchedules, overdue, held, heldUntil } = heartbeat;
  if (alarmLost !== undefined) {
    if (!isRecord(alarmLost) || !timestamp(alarmLost.at)) {
      return { ok: false, message: "Invalid alarm-loss timestamp." };
    }
    if (now - alarmLost.at < ALARM_LOST_WINDOW_MS) {
      return {
        ok: false,
        message: `Lost alarm detected at ${new Date(alarmLost.at).toISOString()}.`,
      };
    }
  }
  if (
    typeof activeSchedules !== "number" ||
    !Number.isSafeInteger(activeSchedules) ||
    activeSchedules < 0 ||
    !Array.isArray(overdue)
  ) {
    return { ok: false, message: "Invalid schedule health data." };
  }
  const hasHold = typeof held === "string" && HOLDS.has(held);
  if (overdue.length > 0 && !hasHold) {
    return { ok: false, message: `${overdue.length} overdue schedule(s) with no known hold.` };
  }
  const hold = hasHold
    ? ` Held by ${held}${timestamp(heldUntil) ? ` until ${new Date(heldUntil).toISOString()}` : ""}.`
    : "";
  return {
    ok: true,
    message: `${activeSchedules} active schedule(s), ${overdue.length} overdue.${hold}`,
  };
}
