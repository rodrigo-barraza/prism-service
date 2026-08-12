import { describe, it, expect } from "vitest";
import { LuposPersona } from "#src/services/personas/LuposPersona";

// Lupos starts lean and reaches the rest of his catalog through pre-flight
// discovery, which matches tool descriptions against the user's message
// text. That works for tools users ask for by name and fails for tools
// whose trigger is a mood — the gold economy fires on rudeness and
// kindness, words that never name it. These tests pin the two halves of
// that fix: the guidance renders from the persona's own defaults, and
// every tool the guidance names is callable when it does.

const defaultEnabledTools = LuposPersona.enabledByDefaultTools ?? [];

/** The tool policy as assembled for a turn that has discovered nothing. */
function buildColdStartPolicy(): string {
  if (typeof LuposPersona.toolPolicy !== "function") {
    return LuposPersona.toolPolicy ?? "";
  }
  return LuposPersona.toolPolicy({
    enabledTools: defaultEnabledTools,
    resolvedToolNames: defaultEnabledTools,
  });
}

/** The Gold Rules section alone — up to the next top-level heading. */
function extractGoldRules(policy: string): string {
  const start = policy.indexOf("# Gold Rules");
  if (start === -1) return "";
  const next = policy.indexOf("\n# ", start + 1);
  return next === -1 ? policy.slice(start) : policy.slice(start, next);
}

describe("Lupos persona tool policy", () => {
  it("states the gold economy exists on a turn that discovered nothing", () => {
    // Regression: the section was gated on a tool Lupos never enabled, so
    // the only text describing his hoard never entered the prompt and he
    // never gifted or mugged anyone.
    expect(buildColdStartPolicy()).toContain("# Gold Rules");
  });

  it("enables every gold tool its own Gold Rules name", () => {
    const goldRules = extractGoldRules(buildColdStartPolicy());
    const namedTools = [
      ...new Set(
        [...goldRules.matchAll(/`([a-z_]*gold[a-z_]*)`/g)].map(
          (match) => match[1],
        ),
      ),
    ];

    expect(namedTools.length).toBeGreaterThan(0);
    for (const toolName of namedTools) {
      expect(defaultEnabledTools).toContain(toolName);
    }
  });
});
