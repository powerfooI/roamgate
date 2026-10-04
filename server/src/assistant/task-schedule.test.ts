import { describe, expect, test } from "bun:test";
import { nextTaskTime, validateTaskSchedule } from "./task-schedule";

describe("task schedule validation", () => {
  test("accepts exact shapes and normalizes UTC precision", () => {
    expect(
      validateTaskSchedule({ type: "once", at: "2028-02-29T12:34:56Z" }),
    ).toEqual({ type: "once", at: "2028-02-29T12:34:56.000Z" });
    expect(
      validateTaskSchedule({ type: "once", at: "2026-01-01T00:00:00.1Z" }),
    ).toEqual({ type: "once", at: "2026-01-01T00:00:00.100Z" });
    for (const minutes of [1, 525_600])
      expect(validateTaskSchedule({ type: "interval", minutes })).toEqual({
        type: "interval",
        minutes,
      });
    for (const timezone of ["UTC", "Asia/Shanghai", "America/New_York"])
      expect(
        validateTaskSchedule({ type: "daily", time: "00:00", timezone }),
      ).toEqual({ type: "daily", time: "00:00", timezone });
  });

  const invalid = [
    null,
    [],
    {},
    { type: "weekly" },
    { type: "interval" },
    { type: "interval", minutes: "1" },
    ...[0, -1, 1.5, 525_601, NaN, Infinity].map((minutes) => ({
      type: "interval",
      minutes,
    })),
    { type: "interval", minutes: 1, extra: true },
    { type: "once", at: "2026-01-01T00:00:00Z", extra: true },
    ...[
      "2026-02-29T00:00:00Z",
      "2028-02-30T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:60:00Z",
      "2026-01-01T00:00:60Z",
      "2026-01-01T00:00:00+00:00",
      "2026-01-01T00:00:00",
      "2026-01-01",
      "not a date",
    ].map((at) => ({ type: "once", at })),
    ...["24:00", "09:60", "9:00", "00:00:00", " 00:00"].map((time) => ({
      type: "daily",
      time,
      timezone: "UTC",
    })),
    ...["", "Mars/Olympus", "+08:00", "-0500"].map((timezone) => ({
      type: "daily",
      time: "09:00",
      timezone,
    })),
    { type: "daily", time: "09:00", timezone: "UTC", at: "ignored" },
  ];
  test.each(invalid.map((value) => ({ value })))(
    "rejects invalid or extra schedule fields: %j",
    ({ value }) => {
      expect(() => validateTaskSchedule(value)).toThrow();
    },
  );
});

describe("next task time", () => {
  const daily = (timezone: string, time: string, after: string) => {
    const next = nextTaskTime(
      { type: "daily", timezone, time },
      Date.parse(after),
    );
    return next === null ? null : new Date(next).toISOString();
  };

  test("once runs strictly after the reference time and interval preserves milliseconds", () => {
    const at = "2026-01-01T12:00:00.000Z";
    const instant = Date.parse(at);
    expect(nextTaskTime({ type: "once", at }, instant - 1)).toBe(instant);
    expect(nextTaskTime({ type: "once", at }, instant)).toBeNull();
    expect(nextTaskTime({ type: "once", at }, instant + 1)).toBeNull();
    expect(nextTaskTime({ type: "interval", minutes: 90 }, instant + 123)).toBe(
      instant + 90 * 60_000 + 123,
    );
  });

  test.each([
    ["UTC", "00:00", "2026-01-31T23:59:59.999Z", "2026-02-01T00:00:00.000Z"],
    ["UTC", "00:00", "2026-12-31T23:59:59.999Z", "2027-01-01T00:00:00.000Z"],
    ["UTC", "00:00", "2028-02-28T23:59:59.999Z", "2028-02-29T00:00:00.000Z"],
    ["UTC", "00:00", "2028-02-29T00:00:00.000Z", "2028-03-01T00:00:00.000Z"],
    ["UTC", "00:00", "2100-02-28T23:59:59.999Z", "2100-03-01T00:00:00.000Z"],
    [
      "Asia/Shanghai",
      "09:00",
      "2026-10-04T00:59:59.999Z",
      "2026-10-04T01:00:00.000Z",
    ],
    [
      "Asia/Shanghai",
      "09:00",
      "2026-10-04T01:00:00.000Z",
      "2026-10-05T01:00:00.000Z",
    ],
    [
      "Asia/Shanghai",
      "00:00",
      "2026-12-31T15:59:59.999Z",
      "2026-12-31T16:00:00.000Z",
    ],
    [
      "America/New_York",
      "09:00",
      "2026-01-15T00:00:00.000Z",
      "2026-01-15T14:00:00.000Z",
    ],
    [
      "America/New_York",
      "09:00",
      "2026-07-15T00:00:00.000Z",
      "2026-07-15T13:00:00.000Z",
    ],
    [
      "Asia/Kathmandu",
      "09:00",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T03:15:00.000Z",
    ],
  ])("%s %s after %s", (timezone, time, after, expected) => {
    expect(daily(timezone!, time!, after!)).toBe(expected!);
  });

  test("skips a nonexistent New York spring-forward wall time", () => {
    expect(daily("America/New_York", "02:30", "2026-03-08T00:00:00Z")).toBe(
      "2026-03-09T06:30:00.000Z",
    );
  });

  test("a New York repeated wall time fires only at its first occurrence", () => {
    expect(daily("America/New_York", "01:30", "2026-11-01T04:00:00Z")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    for (const after of [
      "2026-11-01T05:30:00Z",
      "2026-11-01T05:45:00Z",
      "2026-11-01T06:15:00Z",
    ])
      expect(daily("America/New_York", "01:30", after)).toBe(
        "2026-11-02T06:30:00.000Z",
      );
  });

  test("handles half-hour DST transitions and a skipped calendar date", () => {
    expect(daily("Australia/Lord_Howe", "02:15", "2026-10-03T13:00:00Z")).toBe(
      "2026-10-04T15:15:00.000Z",
    );
    expect(daily("Australia/Lord_Howe", "01:45", "2026-04-04T14:45:00Z")).toBe(
      "2026-04-05T15:15:00.000Z",
    );
    expect(daily("Pacific/Apia", "09:00", "2011-12-29T19:00:00Z")).toBe(
      "2011-12-30T19:00:00.000Z",
    );
  });

  test("calendar calculations do not remap years below 100 to the twentieth century", () => {
    expect(daily("UTC", "00:00", "0099-12-31T23:59:59.999Z")).toBe(
      "0100-01-01T00:00:00.000Z",
    );
  });

  test("rejects invalid reference instants", () => {
    for (const after of [NaN, Infinity, 8.64e15 + 1])
      expect(() =>
        nextTaskTime({ type: "interval", minutes: 1 }, after),
      ).toThrow();
  });
});
