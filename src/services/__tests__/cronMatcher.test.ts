/**
 * Cron matcher — table tests of next-run times.
 *
 * `matchCron` is a per-minute predicate: `ScheduledTaskService.tick()` (and
 * `ConversationTimerService`) evaluate it once a minute against `new Date()`,
 * in the PROCESS's local time — tasks store no timezone of their own. The
 * configured timezone is the container's `TZ=America/Los_Angeles`
 * (docker-compose.yml), so this file runs in it.
 *
 * `nextRuns` replays that tick: one evaluation per minute of absolute time,
 * and a task claimed at most once per local minute key (`lastRunMinute`),
 * which is what makes a fixed time inside the repeated fall-back hour run
 * once. Every expected run below is hand-computed wall-clock time with its
 * UTC offset.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchCron, minuteKeyFor } from "#src/services/ScheduledTaskService";

const CONFIGURED_TIMEZONE = "America/Los_Angeles";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

let previousTimezone: string | undefined;

beforeAll(() => {
  previousTimezone = process.env.TZ;
  process.env.TZ = CONFIGURED_TIMEZONE;
});

afterAll(() => {
  if (previousTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimezone;
});

/** Local wall-clock time with its UTC offset, e.g. "2026-06-01T10:01-07:00". */
function formatLocal(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
  return `${minuteKeyFor(date)}${offset}`;
}

/** The next `count` runs strictly after `from`, as the scheduler tick sees them. */
function nextRuns(
  expression: string,
  from: string,
  count: number,
  horizonDays = 45,
): string[] {
  const runs: string[] = [];
  let lastRunMinute: string | undefined;
  const start =
    Math.floor(new Date(from).getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = start + horizonDays * DAY_MS;
  for (let time = start; time < end && runs.length < count; time += MINUTE_MS) {
    const now = new Date(time);
    const minuteKey = minuteKeyFor(now);
    if (minuteKey === lastRunMinute) continue;
    if (matchCron(expression, now)) {
      runs.push(formatLocal(now));
      lastRunMinute = minuteKey;
    }
  }
  return runs;
}

interface NextRunCase {
  name: string;
  expression: string;
  from: string;
  expected: string[];
  horizonDays?: number;
}

function runTable(cases: NextRunCase[]): void {
  for (const testCase of cases) {
    it(`${testCase.expression} — ${testCase.name}`, () => {
      expect(
        nextRuns(
          testCase.expression,
          testCase.from,
          testCase.expected.length,
          testCase.horizonDays,
        ),
      ).toEqual(testCase.expected);
    });
  }
}

describe("matchCron — next-run table", () => {
  it("runs in the configured timezone", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      CONFIGURED_TIMEZONE,
    );
  });

  describe("ranges with a step honour the upper bound", () => {
    runTable([
      {
        name: "minutes 1, 4, 7, 10 — then the next hour",
        expression: "1-10/3 * * * *",
        from: "2026-06-01T10:00-07:00",
        expected: [
          "2026-06-01T10:01-07:00",
          "2026-06-01T10:04-07:00",
          "2026-06-01T10:07-07:00",
          "2026-06-01T10:10-07:00",
          "2026-06-01T11:01-07:00",
        ],
      },
      {
        name: "days 1, 4, 7, 10 — then the next month",
        expression: "0 0 1-10/3 * *",
        from: "2026-06-05T12:00-07:00",
        expected: [
          "2026-06-07T00:00-07:00",
          "2026-06-10T00:00-07:00",
          "2026-07-01T00:00-07:00",
          "2026-07-04T00:00-07:00",
        ],
      },
    ]);
  });

  describe("steps on 1-based fields start at 1", () => {
    runTable([
      {
        name: "day-of-month */2 is the odd days, so the 31st and the 1st both run",
        expression: "0 0 */2 * *",
        from: "2026-01-29T12:00-08:00",
        expected: [
          "2026-01-31T00:00-08:00",
          "2026-02-01T00:00-08:00",
          "2026-02-03T00:00-08:00",
          "2026-02-05T00:00-08:00",
        ],
      },
      {
        name: "tools-service delayToCron('3d') — days 1, 4, 7, …",
        expression: "0 0 */3 * *",
        from: "2026-06-01T12:00-07:00",
        expected: [
          "2026-06-04T00:00-07:00",
          "2026-06-07T00:00-07:00",
          "2026-06-10T00:00-07:00",
        ],
      },
      {
        name: "month */3 is January, April, July, October",
        expression: "0 0 1 */3 *",
        from: "2026-02-15T12:00-08:00",
        expected: [
          "2026-04-01T00:00-07:00",
          "2026-07-01T00:00-07:00",
          "2026-10-01T00:00-07:00",
        ],
        horizonDays: 240,
      },
    ]);
  });

  describe("day-of-month and day-of-week", () => {
    runTable([
      {
        name: "both restricted: the 1st OR a Monday",
        expression: "0 9 1 * 1",
        // Fri 26 Jun; Mon 29 Jun; Wed 1 Jul; Mon 6 Jul; Mon 13 Jul.
        from: "2026-06-26T12:00-07:00",
        expected: [
          "2026-06-29T09:00-07:00",
          "2026-07-01T09:00-07:00",
          "2026-07-06T09:00-07:00",
          "2026-07-13T09:00-07:00",
        ],
      },
      {
        name: "a star-prefixed day field is unrestricted (crontab(5)): odd days AND Mondays",
        expression: "0 9 */2 * 1",
        // Mondays 8, 15, 22, 29 Jun, 6, 13 Jul — only the odd dates run.
        from: "2026-06-01T12:00-07:00",
        expected: [
          "2026-06-15T09:00-07:00",
          "2026-06-29T09:00-07:00",
          "2026-07-13T09:00-07:00",
        ],
      },
      {
        name: "7 is Sunday",
        expression: "0 0 * * 7",
        // Mon 1 Jun; Sundays 7, 14, 21 Jun.
        from: "2026-06-01T12:00-07:00",
        expected: [
          "2026-06-07T00:00-07:00",
          "2026-06-14T00:00-07:00",
          "2026-06-21T00:00-07:00",
        ],
      },
      {
        name: "a range ending in 7 includes Sunday",
        expression: "0 0 * * 5-7",
        from: "2026-06-01T12:00-07:00",
        expected: [
          "2026-06-05T00:00-07:00",
          "2026-06-06T00:00-07:00",
          "2026-06-07T00:00-07:00",
          "2026-06-12T00:00-07:00",
        ],
      },
      {
        name: "weekday names",
        expression: "0 9 * * MON-FRI",
        // Fri 5 Jun → Mon 8, Tue 9 Jun.
        from: "2026-06-05T12:00-07:00",
        expected: ["2026-06-08T09:00-07:00", "2026-06-09T09:00-07:00"],
      },
    ]);
  });

  describe("DST in the configured timezone", () => {
    runTable([
      {
        name: "spring forward: 02:30 does not exist on 8 Mar, so that day is skipped",
        expression: "30 2 * * *",
        from: "2026-03-07T03:00-08:00",
        expected: ["2026-03-09T02:30-07:00", "2026-03-10T02:30-07:00"],
      },
      {
        name: "spring forward: */30 steps from 01:30 PST straight to 03:00 PDT",
        expression: "*/30 * * * *",
        from: "2026-03-08T01:00-08:00",
        expected: [
          "2026-03-08T01:30-08:00",
          "2026-03-08T03:00-07:00",
          "2026-03-08T03:30-07:00",
        ],
      },
      {
        name: "fall back: a fixed 01:30 runs once, at its first occurrence",
        expression: "30 1 * * *",
        from: "2026-11-01T00:00-07:00",
        expected: ["2026-11-01T01:30-07:00", "2026-11-02T01:30-08:00"],
      },
      {
        name: "fall back: Sunday as 7 runs once in the repeated hour",
        expression: "30 1 * * 7",
        from: "2026-10-31T12:00-07:00",
        expected: ["2026-11-01T01:30-07:00", "2026-11-08T01:30-08:00"],
      },
      {
        name: "fall back: */30 runs through both copies of the repeated hour",
        expression: "*/30 * * * *",
        from: "2026-11-01T00:45-07:00",
        expected: [
          "2026-11-01T01:00-07:00",
          "2026-11-01T01:30-07:00",
          "2026-11-01T01:00-08:00",
          "2026-11-01T01:30-08:00",
          "2026-11-01T02:00-08:00",
        ],
      },
    ]);
  });

  // Every expression seeded, defaulted or documented across the repos that
  // write `cronExpression` — prism-client's scheduled-tasks form, the
  // `create_cron_job` tool description, tools-service's delayToCron, and the
  // fixtures here. None of them hits a defect above, so none may move.
  describe("stored and documented expressions keep their schedule", () => {
    runTable([
      {
        name: "prism-client form default / create_cron_job example",
        expression: "0 9 * * *",
        from: "2026-06-01T08:00-07:00",
        expected: ["2026-06-01T09:00-07:00", "2026-06-02T09:00-07:00"],
      },
      {
        name: "prism-client placeholder",
        expression: "* * * * *",
        from: "2026-06-01T10:00-07:00",
        expected: ["2026-06-01T10:01-07:00", "2026-06-01T10:02-07:00"],
      },
      {
        name: "recurring timer fixture",
        expression: "*/5 * * * *",
        from: "2026-06-01T10:02-07:00",
        expected: ["2026-06-01T10:05-07:00", "2026-06-01T10:10-07:00"],
      },
      {
        name: "daily midnight",
        expression: "0 0 * * *",
        from: "2026-06-01T12:00-07:00",
        expected: ["2026-06-02T00:00-07:00", "2026-06-03T00:00-07:00"],
      },
      {
        name: "hourly",
        expression: "0 * * * *",
        from: "2026-06-01T10:30-07:00",
        expected: ["2026-06-01T11:00-07:00", "2026-06-01T12:00-07:00"],
      },
      {
        name: "delayToCron('6h')",
        expression: "0 */6 * * *",
        from: "2026-06-01T07:00-07:00",
        expected: [
          "2026-06-01T12:00-07:00",
          "2026-06-01T18:00-07:00",
          "2026-06-02T00:00-07:00",
        ],
      },
      {
        name: "delayToCron('90m') — a step past the field's end is minute 0 only",
        expression: "*/90 * * * *",
        from: "2026-06-01T10:30-07:00",
        expected: ["2026-06-01T11:00-07:00", "2026-06-01T12:00-07:00"],
      },
      {
        name: "day 1 of the month (day-of-week unrestricted)",
        expression: "0 9 1 * *",
        from: "2026-06-01T12:00-07:00",
        expected: ["2026-07-01T09:00-07:00", "2026-08-01T09:00-07:00"],
        horizonDays: 70,
      },
    ]);
  });

  describe("malformed expressions never match", () => {
    // 10:01 on Monday 1 Jun 2026 — every field below would otherwise match.
    const at = new Date("2026-06-01T10:01-07:00");
    it.each([
      "61 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "1-2-3 * * * *",
      "1/2/3 * * * *",
      "1x * * * *",
      "* * * * * *",
      "@daily",
    ])("%s is rejected", (expression) => {
      expect(matchCron(expression, at)).toBe(false);
    });
  });
});
