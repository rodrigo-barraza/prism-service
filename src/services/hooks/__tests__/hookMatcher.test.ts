import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  matchesMatcher,
  describeMatcher,
  clearMatcherCache,
  MAX_MATCHER_LENGTH,
} from "#src/services/hooks/HookMatcher";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// Matcher syntax — the three tiers, and the guarantee that a
// broken pattern never escapes as an exception.
// ────────────────────────────────────────────────────────────

describe("HookMatcher", () => {
  beforeEach(() => {
    clearMatcherCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("tier 1 — match everything", () => {
    it.each([
      ["empty string", ""],
      ["whitespace", "   "],
      ["asterisk", "*"],
      ["padded asterisk", " * "],
    ])("treats %s as matching every tool", (_label, matcher) => {
      expect(matchesMatcher(matcher, "Bash")).toBe(true);
      expect(matchesMatcher(matcher, "mcp__github__create_issue")).toBe(true);
    });

    it("treats a missing matcher as matching every tool", () => {
      expect(matchesMatcher(undefined, "Bash")).toBe(true);
      expect(matchesMatcher(null, "Bash")).toBe(true);
    });

    it("matches everything even when there is no value to test", () => {
      expect(matchesMatcher("*", "")).toBe(true);
      expect(matchesMatcher("", undefined)).toBe(true);
    });
  });

  describe("tier 2 — exact names and lists", () => {
    it("matches an exact tool name", () => {
      expect(matchesMatcher("Bash", "Bash")).toBe(true);
    });

    it("is case sensitive", () => {
      expect(matchesMatcher("Bash", "bash")).toBe(false);
    });

    it("does not match a name that merely contains the pattern", () => {
      expect(matchesMatcher("Edit", "MultiEdit")).toBe(false);
      expect(matchesMatcher("Bash", "BashOutput")).toBe(false);
    });

    it("matches any entry of a pipe-separated list", () => {
      expect(matchesMatcher("Bash|Edit|Write", "Edit")).toBe(true);
      expect(matchesMatcher("Bash|Edit|Write", "Read")).toBe(false);
    });

    it("matches any entry of a comma-separated list, ignoring spaces", () => {
      expect(matchesMatcher("Write, Edit", "Edit")).toBe(true);
      expect(matchesMatcher("Write, Edit", "Write")).toBe(true);
      expect(matchesMatcher("Write, Edit", "Read")).toBe(false);
    });

    it("treats underscores as literal, so MCP names need no escaping", () => {
      expect(
        matchesMatcher("mcp__github__create_issue", "mcp__github__create_issue"),
      ).toBe(true);
      // A regex reading would let `_` match nothing special either, but the
      // literal tier also means no accidental substring match.
      expect(matchesMatcher("mcp__github__create_issue", "mcp__github__x")).toBe(
        false,
      );
    });

    it("keeps `Edit|Write` literal rather than an unanchored regex", () => {
      // This is the tier boundary that matters: as a regex, `Edit|Write` is
      // unanchored and would also match `MultiEdit`.
      expect(matchesMatcher("Edit|Write", "Edit")).toBe(true);
      expect(matchesMatcher("Edit|Write", "MultiEdit")).toBe(false);
      expect(describeMatcher("Edit|Write")).toBe("literal");
    });
  });

  describe("tier 3 — unanchored regex", () => {
    it("matches a prefix pattern anywhere in the name", () => {
      expect(matchesMatcher("Notebook.*", "NotebookEdit")).toBe(true);
      expect(matchesMatcher("Notebook.*", "Edit")).toBe(false);
    });

    it("honours anchors when the author supplies them", () => {
      expect(matchesMatcher("^mcp__", "mcp__github__create_issue")).toBe(true);
      expect(matchesMatcher("^mcp__", "not_mcp__github__x")).toBe(false);
    });

    it("is unanchored by default", () => {
      expect(matchesMatcher("Edit$", "MultiEdit")).toBe(true);
      expect(matchesMatcher("(Edit|Write)", "MultiEdit")).toBe(true);
    });

    it("classifies a regex pattern as regex", () => {
      expect(describeMatcher("Notebook.*")).toBe("regex");
    });
  });

  describe("hostile and malformed patterns", () => {
    it("returns false and warns for an invalid regex instead of throwing", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      expect(() => matchesMatcher("[unterminated", "Bash")).not.toThrow();
      expect(matchesMatcher("[unterminated", "Bash")).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    it("warns only once per invalid pattern", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      matchesMatcher("(((", "Bash");
      matchesMatcher("(((", "Edit");
      matchesMatcher("(((", "Write");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("rejects a pattern longer than the ceiling", () => {
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      // A classic catastrophic-backtracking shape, padded past the limit.
      const oversized = `(a+)+$${"x".repeat(MAX_MATCHER_LENGTH)}`;
      expect(oversized.length).toBeGreaterThan(MAX_MATCHER_LENGTH);
      expect(matchesMatcher(oversized, "aaaaaaaaaaaaaaaaaaaa!")).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("exceeds the"),
      );
      expect(describeMatcher(oversized)).toBe("invalid");
    });

    it("rejects an oversized literal name too", () => {
      vi.spyOn(logger, "warn").mockImplementation(() => {});
      const oversized = "A".repeat(MAX_MATCHER_LENGTH + 1);
      expect(matchesMatcher(oversized, oversized)).toBe(false);
    });

    it("accepts a pattern exactly at the ceiling", () => {
      const atLimit = "a".repeat(MAX_MATCHER_LENGTH);
      expect(matchesMatcher(atLimit, atLimit)).toBe(true);
    });
  });

  describe("caching", () => {
    it("reuses a compiled pattern across calls", () => {
      expect(matchesMatcher("Note.*", "NotebookEdit")).toBe(true);
      expect(matchesMatcher("Note.*", "NotebookEdit")).toBe(true);
      clearMatcherCache();
      expect(matchesMatcher("Note.*", "NotebookEdit")).toBe(true);
    });

    it("does not leak regex lastIndex between calls", () => {
      // Repeated `.test` on the same compiled pattern must be stateless.
      for (let index = 0; index < 5; index += 1) {
        expect(matchesMatcher("mcp__.*__list", "mcp__files__list")).toBe(true);
      }
    });
  });
});
