import { describe, it, expect } from "vitest";
import { matchRecurrenceRule, RecurrenceRule } from "../src/utils/RecurrenceMatcher.ts";

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
