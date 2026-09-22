import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  matchesMatcher,
  matchesToolCall,
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

  // ── Argument rules — `Tool(argPattern)`, prompt 12's rule syntax ──
  describe("argument rules", () => {
    it.each([
      // canonical value of a shell tool is its command; `*` crosses `/`
      ["execute_shell(git *)", "execute_shell", { command: "git push origin/main" }, true],
      ["execute_shell(git *)", "execute_shell", { command: "rm -rf /" }, false],
      // the tool part is itself a glob
      ["execute_*(git *)", "execute_command", { command: "git status" }, true],
      ["execute_shell(git *)", "execute_command", { command: "git status" }, false],
      // canonical value of a file tool is its path; `*` stays in one segment
      ["write_file(src/**)", "write_file", { path: "src/a/b.ts" }, true],
      ["write_file(src/*)", "write_file", { path: "src/a/b.ts" }, false],
      ["write_file(src/**/*.ts)", "write_file", { path: "src/index.ts" }, true],
      // named argument, anchored regex
      ["write_file(path=/.*\\.env/)", "write_file", { path: "config/.env" }, true],
      ["write_file(path=/\\.env/)", "write_file", { path: "config/.env" }, false],
      // prefix form
      ["execute_shell(npm run test:*)", "execute_shell", { command: "npm run test --watch" }, true],
      ["execute_shell(npm run test:*)", "execute_shell", { command: "npm run test" }, true],
      ["execute_shell(npm run test:*)", "execute_shell", { command: "npm run testing" }, false],
      // an unknown tool's canonical value is its arguments as sorted JSON
      ["mcp__github__*(*prism-service*)", "mcp__github__create_issue", { title: "t", repo: "prism-service" }, true],
      ["mcp__github__*(repo=prism*)", "mcp__github__create_issue", { repo: "prism-service" }, true],
      ["mcp__github__*(repo=prism*)", "mcp__github__create_issue", { repo: "tools-service" }, false],
      // array arguments match when any element does
      ["read_files(docs/**)", "read_files", { paths: ["src/a.ts", "docs/b.md"] }, true],
    ])("%s on %s %j → %s", (matcher, toolName, args, expected) => {
      expect(matchesToolCall(matcher, toolName, args)).toBe(expected);
    });

    it("keeps name-only matchers exactly as matchesMatcher reads them", () => {
      expect(matchesToolCall("Bash|Edit", "Edit", { anything: 1 })).toBe(true);
      expect(matchesToolCall("^mcp__", "mcp__x__y", {})).toBe(true);
      expect(matchesToolCall("", "whatever", {})).toBe(true);
      expect(matchesToolCall("read_file", "write_file", {})).toBe(false);
    });

    it("classifies rules, and a rule whose regex cannot compile as invalid", () => {
      expect(describeMatcher("execute_shell(git *)")).toBe("rule");
      expect(describeMatcher("write_file(path=/[/)")).toBe("invalid");
      expect(matchesToolCall("write_file(path=/[/)", "write_file", { path: "[" })).toBe(false);
    });

    it("never throws on hostile argument shapes", () => {
      expect(() => matchesToolCall("x(*)", "x", { value: 1n as unknown })).not.toThrow();
      expect(matchesToolCall("x(*)", "x", null)).toBe(true);
    });
  });
});
