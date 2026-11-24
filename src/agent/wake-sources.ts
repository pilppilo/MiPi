/**
 * The parts of the agent that need the Durable Object's one alarm (`alarm.ts`), besides Pi Durable itself: a door's
 * deadlines, a background job's next run. Each registers once, as a `WakeSource`, when the harness opens; the alarm,
 * the commit observer and shutdown loop over the list and name none of them. Core code: no door or extension imports.
 */

/** When a source next needs the alarm (`at`), and whether it has work that can run now, which keeps a heartbeat. */
export type SourceWake = { readonly at?: number; readonly active: boolean };

/** The part of a stored commit a source looks at to decide whether to look again (Pi Durable's `CommitPublication`). */
export type CommitChanges = {
  readonly changes: readonly {
    readonly type: string;
    readonly record?: { readonly kind: string };
  }[];
};

/**
 * One part that needs the alarm. Its own startup stays with it, outside this interface: the order differs between
 * parts (the memory pass's first look is awaited before the alarm is first set; the Telegram door starts after
 * `resume()`, not awaited).
 */
export interface WakeSource {
  /** Names the source in reports, e.g. "The alarm's Telegram door failed". */
  readonly name: string;
  /** What the source has waiting, as of its last look. */
  wake(): SourceWake;
  /** What the alarm calls: everything of this source that may be due. */
  run(): unknown;
  /** Whether a stored commit should make the source look again; `refresh()` is called when it does. */
  observes?(publication: CommitChanges): boolean;
  /** Looks again in the background, e.g. after another part recorded work for it. */
  refresh?(): void;
  /** Stops background work when the agent shuts down; what is pending stays stored. */
  close?(): void;
}

/** Reports a source's failure with the source named, without stopping the others (`reportError` in the agent). */
export type ReportSourceError = (message: string, error: unknown) => void;

/**
 * The registered sources, in registration order. Registered while the harness opens and cleared when it closes, so a
 * reopen after an export or restore starts from an empty list instead of adding every source twice. One source that
 * throws never stops the others: each call is isolated and reported.
 */
export class WakeSources {
  readonly #report: ReportSourceError;
  #sources: WakeSource[] = [];

  constructor(report: ReportSourceError) {
    this.#report = report;
  }

  /** Adds a source. A second source with the same name is a wiring mistake, so it throws. */
  register(source: WakeSource): void {
    if (this.#sources.some(({ name }) => name === source.name)) {
      throw new Error(`Wake source "${source.name}" is already registered`);
    }
    this.#sources.push(source);
  }

  /** The registered sources' names, in order. */
  names(): readonly string[] {
    return this.#sources.map(({ name }) => name);
  }

  /** The earliest time any source needs the alarm, active when any is. */
  wake(): SourceWake {
    return earliestWake(...this.#sources.map((source) => source.wake()));
  }

  /** Refreshes every source that observes the commit. */
  observe(publication: CommitChanges): void {
    for (const source of this.#sources) {
      try {
        if (source.observes?.(publication) === true) source.refresh?.();
      } catch (error) {
        this.#report(`Refreshing the ${source.name} after a commit failed`, error);
      }
    }
  }

  /**
   * The alarm's consumers for the sources, in registration order (`runAlarmConsumers`). Each looks the source up when
   * its turn comes, so a source closed while an earlier consumer ran (maintenance taking the object) doesn't run.
   */
  consumers(): readonly (readonly [name: string, run: () => unknown])[] {
    return this.#sources.map(
      (source) =>
        [source.name, () => (this.#sources.includes(source) ? source.run() : undefined)] as const,
    );
  }

  /** Closes every source and empties the list. One that throws is reported, and the rest still close. */
  close(): void {
    const sources = this.#sources;
    this.#sources = [];
    for (const source of sources) {
      try {
        source.close?.();
      } catch (error) {
        this.#report(`Closing the ${source.name} failed`, error);
      }
    }
  }
}

/** The earliest of several wakes, active when any is. */
export function earliestWake(...wakes: readonly (SourceWake | undefined)[]): SourceWake {
  const times = wakes.flatMap((wake) => (wake?.at === undefined ? [] : [wake.at]));
  const active = wakes.some((wake) => wake?.active === true);
  return times.length === 0 ? { active } : { at: Math.min(...times), active };
}
