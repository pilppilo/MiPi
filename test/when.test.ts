// Adapted from pi-pocket test/schedules.test.ts @ 2f060f2 (its tests of when.ts only), MIT © 2026 Tanner Middleton (see LICENSES/pi-pocket.txt)
import { expect, test } from "vitest";
import { checkRepeat, describeRepeat, nextRepeat, parseWhen } from "../src/lib/when.ts";

/** `node:assert/strict`'s calls these tests use, on Vitest (workerd has no `node:assert`). */
const assert = {
  equal: (actual: unknown, expected: unknown, message?: string) =>
    expect(actual, message).toBe(expected),
  deepEqual: (actual: unknown, expected: unknown, message?: string) =>
    expect(actual, message).toEqual(expected),
  throws: (run: () => unknown, error?: RegExp | string, message?: string) =>
    error instanceof RegExp ? expect(run, message).toThrow(error) : expect(run, error).toThrow(),
};

const iso = (moment: number) => new Date(moment).toISOString();
/** Sunday, October 4, 2026, 10:00 in Chicago (15:00 UTC). */
const sunday = Date.UTC(2026, 9, 4, 15, 0);
const chicago = "America/Chicago";

test("times read the way people write them, in their time zone", () => {
  const when = (text: string) => {
    const parsed = parseWhen(text, sunday, chicago);

    return [
      iso(parsed.next),
      parsed.every === undefined ? "once" : describeRepeat(parsed.every),
      parsed.rest,
    ];
  };

  assert.deepEqual(when("in 30m check the build"), [
    "2026-10-04T15:30:00.000Z",
    "once",
    "check the build",
  ]);
  assert.deepEqual(
    when("7:00 x"),
    ["2026-10-05T12:00:00.000Z", "once", "x"],
    "7:00 has passed today: tomorrow",
  );
  assert.deepEqual(when("every weekday 8:00 x"), [
    "2026-10-05T13:00:00.000Z",
    "weekdays at 08:00",
    "x",
  ]);

  for (const [text, problem] of [
    ["every 5m x", /at most every 10 minutes/],
    ["soon x", /Say when/],
  ] as const) {
    assert.throws(() => parseWhen(text, sunday, chicago), problem, text);
  }
});

test("the shortest repeat and the furthest ahead can be set", () => {
  const minutes = (text: string, repeatMinutes?: number) =>
    parseWhen(text, sunday, chicago, repeatMinutes === undefined ? {} : { repeatMinutes });
  const day = 24 * 60 * 60_000;

  assert.deepEqual(minutes("every 2m x", 1).every, { minutes: 2 });
  assert.deepEqual(minutes("every 1m x", 1).every, { minutes: 1 });
  assert.throws(() => minutes("every 5m x", 30), /at most every 30 minutes/);
  assert.throws(() => minutes("every 5m x"), /at most every 10 minutes/, "the default");
  assert.equal(parseWhen("in 3d x", sunday, chicago, { aheadMs: 5 * day }).next, sunday + 3 * day);
  assert.throws(
    () => parseWhen("in 6d x", sunday, chicago, { aheadMs: 5 * day }),
    /up to 5 days ahead/,
  );
  assert.equal(
    parseWhen("in 400d x", sunday, chicago, { aheadMs: 500 * day }).next,
    sunday + 400 * day,
  );
  assert.throws(() => parseWhen("in 400d x", sunday, chicago), /up to a year ahead/);
  assert.throws(() => parseWhen("every 999999999999m x", sunday, chicago), /366 days/);
  assert.throws(() => checkRepeat({ minutes: 1e15 }), /366 days/, "the editor too");
});

// MiPi's own: the owner's zone, America/Chicago, across 2026's changes (March 8 forward, November 1 back).
test("wall-clock repeats in Chicago hold across daylight saving", () => {
  const runs = (text: string, after: number, count: number): string[] => {
    const every = parseWhen(`${text} x`, after, chicago).every!;
    const times: string[] = [];
    for (let at = after; times.length < count; times.push(iso(at)))
      at = nextRepeat(every, at, chicago);
    return times;
  };
  // Weekday 08:00: 14:00Z in CST, 13:00Z in CDT, and no weekend.
  expect(runs("every weekday 8:00", Date.UTC(2026, 2, 5, 15), 3)).toEqual([
    "2026-03-06T14:00:00.000Z",
    "2026-03-09T13:00:00.000Z",
    "2026-03-10T13:00:00.000Z",
  ]);
  expect(runs("every weekday 8:00", Date.UTC(2026, 9, 30, 14), 2)).toEqual([
    "2026-11-02T14:00:00.000Z",
    "2026-11-03T14:00:00.000Z",
  ]);
  // 02:30 doesn't exist on March 8: it moves forward by the gap, to 03:30 CDT.
  expect(runs("every day 2:30", Date.UTC(2026, 2, 7, 0), 3)).toEqual([
    "2026-03-07T08:30:00.000Z",
    "2026-03-08T08:30:00.000Z",
    "2026-03-09T07:30:00.000Z",
  ]);
  // 01:30 happens twice on November 1: it runs once, at the earlier instant (CDT).
  expect(runs("every day 1:30", Date.UTC(2026, 9, 31, 0), 3)).toEqual([
    "2026-10-31T06:30:00.000Z",
    "2026-11-01T06:30:00.000Z",
    "2026-11-02T07:30:00.000Z",
  ]);
});

test("a repeat more often than every 10 minutes is refused", () => {
  expect(() => parseWhen("every 5m x", sunday, chicago)).toThrow();
  expect(parseWhen("every 10m x", sunday, chicago).every).toEqual({ minutes: 10 });
});
