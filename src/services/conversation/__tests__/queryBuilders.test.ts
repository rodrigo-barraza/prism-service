import { describe, it, expect } from "vitest";
import { buildDateRangeFilter, applyDateRangeFilter, parsePaginationParams } from "../../../utils/QueryBuilders.ts";
import type { MongoFilter } from "../../../types/express.ts";

describe("QueryBuilders", () => {
  describe("buildDateRangeFilter", () => {
    it("should return both gte and lte when both from and to are provided", () => {
      const result = buildDateRangeFilter("2026-01-01", "2026-01-31");
      expect(result).toEqual({ $gte: "2026-01-01", $lte: "2026-01-31" });
    });

    it("should return only gte when only from is provided", () => {
      const result = buildDateRangeFilter("2026-01-01", null);
      expect(result).toEqual({ $gte: "2026-01-01" });
    });

    it("should return only lte when only to is provided", () => {
      const result = buildDateRangeFilter(undefined, "2026-01-31");
      expect(result).toEqual({ $lte: "2026-01-31" });
    });

    it("should return null if both from and to are empty strings, null, or undefined", () => {
      expect(buildDateRangeFilter("", "")).toBeNull();
      expect(buildDateRangeFilter(null, null)).toBeNull();
      expect(buildDateRangeFilter(undefined, undefined)).toBeNull();
    });
  });

  describe("applyDateRangeFilter", () => {
    it("should mutate the matchFilter in-place with default field", () => {
      const matchFilter: MongoFilter = { status: "active" };
      applyDateRangeFilter(matchFilter, "2026-01-01", "2026-01-31");
      expect(matchFilter).toEqual({
        status: "active",
        createdAt: { $gte: "2026-01-01", $lte: "2026-01-31" }
      });
    });

    it("should mutate with custom field name", () => {
      const matchFilter: MongoFilter = {};
      applyDateRangeFilter(matchFilter, "2026-01-01", null, "createdDate");
      expect(matchFilter).toEqual({
        createdDate: { $gte: "2026-01-01" }
      });
    });

    it("should do nothing if range is null", () => {
      const matchFilter: MongoFilter = { status: "active" };
      applyDateRangeFilter(matchFilter, null, undefined);
      expect(matchFilter).toEqual({ status: "active" });
    });
  });

  describe("parsePaginationParams", () => {
    it("should return default values when query is empty", () => {
      const result = parsePaginationParams({});
      expect(result).toEqual({
        skip: 0,
        limit: 50,
        page: 1,
        sortDirection: -1
      });
    });

    it("should parse custom page and limit", () => {
      const result = parsePaginationParams({ page: "3", limit: "20" });
      expect(result).toEqual({
        skip: 40,
        limit: 20,
        page: 3,
        sortDirection: -1
      });
    });

    it("should parse order asc and desc", () => {
      const ascResult = parsePaginationParams({ order: "asc" });
      expect(ascResult.sortDirection).toBe(1);

      const descResult = parsePaginationParams({ order: "desc" });
      expect(descResult.sortDirection).toBe(-1);
    });

    it("should handle invalid values by defaulting via parseInt", () => {
      const result = parsePaginationParams({ page: "invalid", limit: "invalid" });
      expect(isNaN(result.page)).toBe(true);
      expect(isNaN(result.limit)).toBe(true);
    });
  });
});
