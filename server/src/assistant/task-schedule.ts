import type { AssistantTaskSchedule } from "../../../shared/assistant";
import { isRecord } from "../agent/session-utils";
import { AssistantUserError } from "./errors";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function formatter(timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export function validateTaskSchedule(value: unknown): AssistantTaskSchedule {
  if (!isRecord(value)) throw new AssistantUserError("Invalid task schedule");
  const keys =
    value.type === "once"
      ? ["type", "at"]
      : value.type === "interval"
        ? ["type", "minutes"]
        : value.type === "daily"
          ? ["type", "time", "timezone"]
          : [];
  if (
    !keys.length ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw new AssistantUserError("Invalid task schedule fields");
  if (value.type === "once") {
    const match =
      typeof value.at === "string" &&
      /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(
        value.at,
      );
    if (match) {
      const date = new Date(value.at as string);
      const canonical = `${match[1]}T${match[2]}:${match[3]}.${(match[4] ?? "").padEnd(3, "0")}Z`;
      // Date.parse normalizes invalid dates such as February 30; reject them.
      if (Number.isFinite(date.getTime()) && date.toISOString() === canonical)
        return { type: "once", at: canonical };
    }
    throw new AssistantUserError("Task time must be a valid UTC ISO timestamp");
  }
  if (value.type === "interval") {
    if (
      typeof value.minutes !== "number" ||
      !Number.isInteger(value.minutes) ||
      value.minutes < 1 ||
      value.minutes > 525_600
    )
      throw new AssistantUserError(
        "Task interval must be 1 to 525600 whole minutes",
      );
    return { type: "interval", minutes: value.minutes };
  }
  if (
    typeof value.time !== "string" ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time) ||
    typeof value.timezone !== "string" ||
    !value.timezone ||
    /^[+-]/.test(value.timezone)
  )
    throw new AssistantUserError(
      "Daily tasks require HH:mm and an IANA timezone",
    );
  try {
    formatter(value.timezone);
  } catch {
    throw new AssistantUserError("Invalid task timezone");
  }
  return { type: "daily", time: value.time, timezone: value.timezone };
}

/** Encode zoned calendar fields as UTC for calendar arithmetic, not as an instant. */
function wallClock(format: Intl.DateTimeFormat, instant: number): Date {
  const parts = Object.fromEntries(
    format.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const date = new Date(0);
  // setUTCFullYear avoids Date.UTC's special interpretation of years 0 through 99.
  const year = Number(parts.year);
  date.setUTCFullYear(
    parts.era === "BC" ? 1 - year : year,
    Number(parts.month) - 1,
    Number(parts.day),
  );
  date.setUTCHours(
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
    0,
  );
  return date;
}

export function nextTaskTime(
  schedule: AssistantTaskSchedule,
  after: number,
): number | null {
  if (!Number.isFinite(after) || !Number.isFinite(new Date(after).getTime()))
    throw new Error("Invalid task schedule reference time");
  if (schedule.type === "once") {
    const instant = Date.parse(schedule.at);
    return instant > after ? instant : null;
  }
  if (schedule.type === "interval") return after + schedule.minutes * MINUTE;

  const format = formatter(schedule.timezone);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const date = wallClock(format, after);
  date.setUTCHours(hour!, minute!, 0, 0);
  // Probe days, not every minute. The bound also makes impossible dates terminate.
  for (let day = 0; day < 370 && Number.isFinite(date.getTime()); day++) {
    const local = date.getTime();
    const offsets = new Set<number>();
    // Include both sides of clock changes, even half-hour or date-line shifts.
    for (let hours = -36; hours <= 36; hours += 6) {
      const probe = local + hours * HOUR;
      if (Number.isFinite(new Date(probe).getTime()))
        offsets.add(wallClock(format, probe).getTime() - probe);
    }
    let earliest = Infinity;
    for (const offset of offsets) {
      const candidate = local - offset;
      if (
        Number.isFinite(new Date(candidate).getTime()) &&
        wallClock(format, candidate).getTime() === local
      )
        earliest = Math.min(earliest, candidate);
    }
    // A gap has no candidate; a fold fires only at its first occurrence, even
    // when `after` lies between the two occurrences of the same wall-clock time.
    if (Number.isFinite(earliest) && earliest > after) return earliest;
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return null;
}
