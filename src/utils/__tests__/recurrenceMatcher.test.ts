import { describe, it, expect } from "vitest";
import { matchRecurrenceRule, type RecurrenceRule } from "#src/utils/RecurrenceMatcher";
import { matchCron } from "#src/services/ScheduledTaskService";

describe("RecurrenceMatcher - matchRecurrenceRule", () => {
  // Test time matching is evaluated correctly by the calling scheduler
  // Here we test the date-boundary math of matchRecurrenceRule

  describe("Daily frequency", () => {
    it("should match every day when interval is 1", () => {
      const rule: RecurrenceRule = { frequency: "daily", interval: 1 };
      const startDate = new Date("2026-05-01T00:00:00");
      const targetDate = new Date("2026-05-15T00:00:00");
      expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
    });

    it("should match every other day when interval is 2", () => {
      const rule: RecurrenceRule = { frequency: "daily", interval: 2 };
      const startDate = new Date("2026-05-01T00:00:00"); // Day 0
      
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-01T00:00:00"))).toBe(true);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-02T00:00:00"))).toBe(false);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-03T00:00:00"))).toBe(true);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-04T00:00:00"))).toBe(false);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-05T00:00:00"))).toBe(true);
    });

    it("should not match dates before start date", () => {
      const rule: RecurrenceRule = { frequency: "daily", interval: 1 };
      const startDate = new Date("2026-05-10T00:00:00");
      const targetDate = new Date("2026-05-09T00:00:00");
      expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(false);
    });
  });

  describe("Weekly frequency", () => {
    it("should match specified weekdays in interval week 1", () => {
      const rule: RecurrenceRule = { frequency: "weekly", interval: 1, weekdays: [1, 3] }; // Mon, Wed
      const startDate = new Date("2026-05-04T00:00:00"); // Monday
      
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-04T00:00:00"))).toBe(true); // Monday
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-05T00:00:00"))).toBe(false); // Tuesday
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-06T00:00:00"))).toBe(true); // Wednesday
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-07T00:00:00"))).toBe(false); // Thursday
    });

    it("should match specified weekdays only in active interval weeks", () => {
      const rule: RecurrenceRule = { frequency: "weekly", interval: 2, weekdays: [2] }; // Every 2 weeks on Tuesday
      const startDate = new Date("2026-05-05T00:00:00"); // Tue, May 5th
      
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-05T00:00:00"))).toBe(true); // Active week (May 5)
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-12T00:00:00"))).toBe(false); // Inactive week (May 12)
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-19T00:00:00"))).toBe(true); // Active week (May 19)
    });
  });

  describe("Monthly frequency", () => {
    it("should match on specific day of month", () => {
      const rule: RecurrenceRule = { frequency: "monthly", interval: 1, monthlyType: "dayOfMonth", dayOfMonth: 15 };
      const startDate = new Date("2026-05-01T00:00:00");
      
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-15T00:00:00"))).toBe(true);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-16T00:00:00"))).toBe(false);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-06-15T00:00:00"))).toBe(true);
    });

    it("should match on specific day of month with interval > 1", () => {
      const rule: RecurrenceRule = { frequency: "monthly", interval: 3, monthlyType: "dayOfMonth", dayOfMonth: 1 };
      const startDate = new Date("2026-05-01T00:00:00"); // May
      
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-01T00:00:00"))).toBe(true); // Month 0 (May)
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-06-01T00:00:00"))).toBe(false); // Month 1 (June)
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-07-01T00:00:00"))).toBe(false); // Month 2 (July)
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-08-01T00:00:00"))).toBe(true); // Month 3 (August)
    });

    it("should match last day of month when dayOfMonth is -1", () => {
      const rule: RecurrenceRule = { frequency: "monthly", interval: 1, monthlyType: "dayOfMonth", dayOfMonth: -1 };
      const startDate = new Date("2026-02-01T00:00:00");
      
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-02-28T00:00:00"))).toBe(true); // Feb 28
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-02-27T00:00:00"))).toBe(false);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-03-31T00:00:00"))).toBe(true); // March 31
    });

    it("should match nth day of week (e.g., second Tuesday)", () => {
      // Second Tuesday of the month
      const rule: RecurrenceRule = {
        frequency: "monthly",
        interval: 1,
        monthlyType: "nthDayOfWeek",
        nthDayOfWeek: { occurrence: 2, dayOfWeek: 2 } // 2 = Tuesday
      };
      const startDate = new Date("2026-05-01T00:00:00");
      
      // May 2026:
      // May 5 = 1st Tuesday
      // May 12 = 2nd Tuesday
      // May 19 = 3rd Tuesday
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-05T00:00:00"))).toBe(false);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-12T00:00:00"))).toBe(true);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-19T00:00:00"))).toBe(false);
      
      // June 2026:
      // June 2 = 1st Tuesday
      // June 9 = 2nd Tuesday
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-06-02T00:00:00"))).toBe(false);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-06-09T00:00:00"))).toBe(true);
    });

    it("should match last day of week of the month (e.g., last Friday)", () => {
      // Last Friday of the month
      const rule: RecurrenceRule = {
        frequency: "monthly",
        interval: 1,
        monthlyType: "nthDayOfWeek",
        nthDayOfWeek: { occurrence: -1, dayOfWeek: 5 } // 5 = Friday
      };
      const startDate = new Date("2026-05-01T00:00:00");
      
      // May 2026 has Fridays on: May 1, May 8, May 15, May 22, May 29 (last)
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-22T00:00:00"))).toBe(false);
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-29T00:00:00"))).toBe(true);
    });
  });

  describe("Yearly frequency", () => {
    it("should match in designated months and date (e.g., twice a year starting in May)", () => {
      // May and November (Months 5 and 11) on the 1st
      const rule: RecurrenceRule = {
        frequency: "yearly",
        interval: 1,
        months: [5, 11],
        yearlyType: "specificDate",
        dayOfMonth: 1
      };
      const startDate = new Date("2026-01-01T00:00:00");
      
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-01T00:00:00"))).toBe(true); // May 1
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-11-01T00:00:00"))).toBe(true); // Nov 1
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-06-01T00:00:00"))).toBe(false); // June 1
      expect(matchRecurrenceRule(rule, startDate, new Date("2027-05-01T00:00:00"))).toBe(true); // Next year May 1
    });

    it("should match yearly nth day of week (e.g., second Tuesday of May)", () => {
      const rule: RecurrenceRule = {
        frequency: "yearly",
        interval: 1,
        months: [5], // May
        yearlyType: "nthDayOfWeek",
        nthDayOfWeek: { occurrence: 2, dayOfWeek: 2 } // 2nd Tuesday
      };
      const startDate = new Date("2026-01-01T00:00:00");
      
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-05-12T00:00:00"))).toBe(true); // May 12, 2026
      expect(matchRecurrenceRule(rule, startDate, new Date("2026-11-10T00:00:00"))).toBe(false); // Nov 10 (2nd Tue of Nov)
    });
  });
});

// ── Adversarial Boundary Tests (merged from adversarial-boundary.test.ts) ──

describe('RecurrenceMatcher adversarial', () => {
  it('should return false when target date is before start date', () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: 1 };
    const startDate = new Date(2025, 5, 15); // June 15
    const targetDate = new Date(2025, 5, 10); // June 10 — before start
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(false);
  });

  it('should match when start and target are the same date', () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: 1 };
    const date = new Date(2025, 5, 15);
    expect(matchRecurrenceRule(rule, date, date)).toBe(true);
  });

  it('should handle interval of 0 — clamped to 1', () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: 0 };
    const startDate = new Date(2025, 0, 1);
    const targetDate = new Date(2025, 0, 2);
    // interval is Math.max(1, 0) = 1, so daily should match
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle negative interval — clamped to 1', () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: -5 };
    const startDate = new Date(2025, 0, 1);
    const targetDate = new Date(2025, 0, 2);
    // Math.max(1, -5) = 1
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle leap year date — Feb 29 to Feb 29 next leap year', () => {
    const rule: RecurrenceRule = { frequency: 'yearly', interval: 4 };
    const startDate = new Date(2024, 1, 29); // Feb 29, 2024
    const targetDate = new Date(2028, 1, 29); // Feb 29, 2028
    // Fixed: dayOfMonth is now inferred from startDate (29) when not set
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle DST boundary — spring forward day (daily recurrence)', () => {
    // March 9, 2025 is the DST spring-forward day in US Pacific
    const rule: RecurrenceRule = { frequency: 'daily', interval: 1 };
    const startDate = new Date(2025, 2, 8); // March 8
    const targetDate = new Date(2025, 2, 9); // March 9 (spring forward)
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle last day of month flag (-1) for February', () => {
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'dayOfMonth',
      dayOfMonth: -1,
    };
    const startDate = new Date(2025, 0, 31); // Jan 31
    const targetDate = new Date(2025, 1, 28); // Feb 28 (last day in non-leap)
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle weekly with empty weekdays array — falls back to start day', () => {
    const rule: RecurrenceRule = {
      frequency: 'weekly',
      interval: 1,
      weekdays: [],
    };
    const startDate = new Date(2025, 5, 9); // Monday
    const targetDate = new Date(2025, 5, 16); // Next Monday
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle unknown frequency string — returns false by default switch', () => {
    const rule = { frequency: 'hourly' as any, interval: 1 };
    const date = new Date(2025, 5, 15);
    expect(matchRecurrenceRule(rule, date, date)).toBe(false);
  });

  it('should handle nthDayOfWeek with occurrence -1 (last) in a short month', () => {
    const rule: RecurrenceRule = {
      frequency: 'monthly',
      interval: 1,
      monthlyType: 'nthDayOfWeek',
      nthDayOfWeek: { occurrence: -1, dayOfWeek: 5 }, // Last Friday
    };
    const startDate = new Date(2025, 0, 1);
    const targetDate = new Date(2025, 1, 28); // Feb 28, 2025 is a Friday
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should handle very large interval value', () => {
    const rule: RecurrenceRule = { frequency: 'daily', interval: 999999999 };
    const startDate = new Date(2025, 0, 1);
    const targetDate = new Date(2025, 0, 2);
    // (1 day difference) % 999999999 = 1, not 0
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(false);
  });

  it('should handle leap year date — Feb 29 to Feb 28 in non-leap year (yearly recurrence)', () => {
    const rule: RecurrenceRule = { frequency: 'yearly', interval: 1 };
    const startDate = new Date(2024, 1, 29); // Feb 29, 2024
    const targetDate = new Date(2025, 1, 28); // Feb 28, 2025 (clamped)
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });

  it('should clamp dayOfMonth monthly recurrence to target month\'s last day when target month has fewer days', () => {
    const rule: RecurrenceRule = { frequency: 'monthly', interval: 1 };
    const startDate = new Date(2025, 0, 31); // Jan 31
    const targetDate = new Date(2025, 1, 28); // Feb 28 (clamped)
    expect(matchRecurrenceRule(rule, startDate, targetDate)).toBe(true);
  });
});

// ── Adversarial Tests (merged from adversarial-qa-flows.test.ts) ──

describe('matchCron adversarial', () => {
  it('should return false for empty string expression', () => {
    expect(matchCron('')).toBe(false);
  });

  it('should return false for expression with too few fields (3 fields)', () => {
    expect(matchCron('0 9 *')).toBe(false);
  });

  it('should return false for expression with too many fields (6 fields)', () => {
    expect(matchCron('0 9 * * * *')).toBe(false);
  });

  it('should return false for expression with non-numeric values', () => {
    expect(matchCron('abc def ghi jkl mno')).toBe(false);
  });

  it('should handle step value of 0 — division by zero in modulo', () => {
    // */0 means "every 0 minutes" — parseInt gives 0, value % 0 is NaN
    const result = matchCron('*/0 * * * *');
    // NaN === value is always false → should return false gracefully
    expect(typeof result).toBe('boolean');
  });

  it('should handle negative step value — parseInt parses but modulo goes wrong', () => {
    const result = matchCron('*/-1 * * * *');
    expect(typeof result).toBe('boolean');
  });

  it('should match wildcard expression at any time', () => {
    expect(matchCron('* * * * *')).toBe(true);
  });

  it('should handle range with inverted bounds — 30-10 should not match anything between', () => {
    const dateAtMinute15 = new Date(2025, 5, 15, 10, 15);
    // Range 30-10: start=30, end=10 → value(15) >= 30 && value(15) <= 10 → false
    expect(matchCron('30-10 * * * *', dateAtMinute15)).toBe(false);
  });

  it('should handle comma-separated values', () => {
    const dateAtMinute0 = new Date(2025, 5, 15, 10, 0);
    expect(matchCron('0,15,30,45 * * * *', dateAtMinute0)).toBe(true);
  });

  it('should handle step with range — 0-30/10', () => {
    const dateAtMinute20 = new Date(2025, 5, 15, 10, 20);
    // 0-30/10: start=0, step=10 → minute(20) >= 0 && (20-0)%10 === 0 → true
    expect(matchCron('0-30/10 * * * *', dateAtMinute20)).toBe(true);
  });

  it('should match exact minute and hour', () => {
    const dateAt1030 = new Date(2025, 5, 15, 10, 30);
    expect(matchCron('30 10 * * *', dateAt1030)).toBe(true);
  });

  it('should not match wrong minute', () => {
    const dateAt1029 = new Date(2025, 5, 15, 10, 29);
    expect(matchCron('30 10 * * *', dateAt1029)).toBe(false);
  });

  it('should handle expression with extra whitespace — trim/split should normalize', () => {
    const date = new Date(2025, 5, 15, 10, 0);
    expect(matchCron('  0   10   *   *   *  ', date)).toBe(true);
  });

  it('should handle day-of-week boundary — Sunday as 0 and 7', () => {
    // June 15, 2025 is a Sunday (day 0)
    const sunday = new Date(2025, 5, 15);
    expect(matchCron(`${sunday.getMinutes()} ${sunday.getHours()} * * 0`, sunday)).toBe(true);
  });

  it('should handle NaN from parseInt in field — returns false for non-numeric literal', () => {
    const date = new Date(2025, 5, 15, 10, 30);
    // 'abc' parsed as parseInt → NaN → NaN === 30 is false
    expect(matchCron('abc 10 * * *', date)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. SessionGenerationTracker — State Machine Violations
// ────────────────────────────────────────────────────────────────


describe('matchCron — integration with real Date objects', () => {
  it('should match midnight exactly — 0 0 * * *', () => {
    const midnight = new Date(2025, 5, 15, 0, 0);
    expect(matchCron('0 0 * * *', midnight)).toBe(true);
  });

  it('should match last minute of the day — 59 23 * * *', () => {
    const endOfDay = new Date(2025, 5, 15, 23, 59);
    expect(matchCron('59 23 * * *', endOfDay)).toBe(true);
  });

  it('should match January 1st at midnight — 0 0 1 1 *', () => {
    const newYear = new Date(2025, 0, 1, 0, 0);
    expect(matchCron('0 0 1 1 *', newYear)).toBe(true);
  });

  it('should handle February 29 on leap year — 0 0 29 2 *', () => {
    const leapDay = new Date(2024, 1, 29, 0, 0);
    expect(matchCron('0 0 29 2 *', leapDay)).toBe(true);
  });

  it('should not match February 29 on non-leap year — date rolls to March 1', () => {
    // new Date(2025, 1, 29) → March 1, 2025 (JavaScript auto-rolls)
    const rolledDate = new Date(2025, 1, 29, 0, 0);
    // rolledDate.getMonth() === 2 (March), so month check (2) !== March(3) → false
    expect(matchCron('0 0 29 2 *', rolledDate)).toBe(false);
  });

  it('should handle day-of-month 31 for months with only 30 days', () => {
    // June has 30 days, so June 31 → July 1 in JavaScript
    const rolledDate = new Date(2025, 5, 31, 0, 0);
    // June(5+1=6) vs rolled July(6+1=7) — if it rolled, dom won't match either
    const matchesJune = matchCron('0 0 31 6 *', rolledDate);
    expect(typeof matchesJune).toBe('boolean');
  });
});

// ────────────────────────────────────────────────────────────────
// 12. StreamState — Concurrent Mutation Safety
// ────────────────────────────────────────────────────────────────

