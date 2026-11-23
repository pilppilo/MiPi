/**
 * The Durable Object's one alarm. A Durable Object has a single alarm, and several parts of the agent need it: Pi
 * Durable's next sleep (`onWake`), the Telegram door (a burst window's deadline, the outbox's next send), and a
 * recovery heartbeat while work can run, so an evicted instance is woken to go on. The alarm is set to the earliest of
 * them, and deleted when none needs it.
 */
import type { Wake } from "./pi/durable.ts";
import type { TelegramWake } from "./telegram.ts";

/** While work can run, the alarm stays this far ahead, so an evicted instance is woken to resume it. */
export const HEARTBEAT_MS = 60_000;

/** What the scheduler writes to: the object's storage, or a fake in tests. */
export interface AlarmStorage {
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** The earliest time anything needs the alarm, or undefined when nothing does. */
export function alarmTime(
  wake: Wake,
  telegram: TelegramWake | undefined,
  now: number,
): number | undefined {
  const heartbeat = wake.active || telegram?.active === true ? now + HEARTBEAT_MS : undefined;
  // `wake.at` is on the Harness clock, which is the default `Date.now`, as is the outbox's.
  const times = [heartbeat, wake.at, telegram?.at].filter(
    (value): value is number => value !== undefined,
  );
  return times.length === 0 ? undefined : Math.min(...times);
}

export class AlarmScheduler {
  readonly #storage: AlarmStorage;
  readonly #telegram: () => TelegramWake | undefined;
  readonly #now: () => number;
  #writes: Promise<void> = Promise.resolve();

  constructor(
    storage: AlarmStorage,
    telegram: () => TelegramWake | undefined,
    now: () => number = Date.now,
  ) {
    this.#storage = storage;
    this.#telegram = telegram;
    this.#now = now;
  }

  /**
   * Sets the alarm for `wake` and the Telegram door's wake, read when the write runs so it is the newest. Writes are
   * serialized, so an older wake can't overwrite a newer, earlier deadline.
   */
  schedule(wake: Wake): Promise<void> {
    const write = this.#writes.then(async () => {
      const at = alarmTime(wake, this.#telegram(), this.#now());
      if (at === undefined) await this.#storage.deleteAlarm();
      else await this.#storage.setAlarm(at);
    });
    this.#writes = write.catch(() => undefined);
    return write;
  }

  /** Resolves once every write asked for so far has run. */
  settled(): Promise<void> {
    return this.#writes;
  }
}

/**
 * Runs the alarm's consumers one after another, each in its own `try`, so one that throws can't stop the others, then
 * `last` whatever happened. A failure is reported with the consumer's name.
 */
export async function runAlarmConsumers(
  consumers: readonly (readonly [name: string, run: () => unknown])[],
  report: (message: string, error: unknown) => void,
  last: () => Promise<void>,
): Promise<void> {
  try {
    for (const [name, run] of consumers) {
      try {
        await run();
      } catch (error) {
        report(`The alarm's ${name} failed`, error);
      }
    }
  } finally {
    await last();
  }
}
