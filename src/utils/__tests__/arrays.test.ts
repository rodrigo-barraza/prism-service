import { describe, it, expect } from "vitest";
import { ARENA_SCORES } from "#src/arrays";

describe("Arrays (Arena Scores Map)", () => {
  it("should export ARENA_SCORES with expected categories", () => {
    expect(ARENA_SCORES).toBeDefined();
    expect(ARENA_SCORES.text).toBeDefined();
    expect(ARENA_SCORES.code).toBeDefined();
    expect(ARENA_SCORES.vision).toBeDefined();
    expect(ARENA_SCORES.document).toBeDefined();
    expect(ARENA_SCORES.image).toBeDefined();
    expect(ARENA_SCORES.imageEdit).toBeDefined();
    expect(ARENA_SCORES.search).toBeDefined();
  });

  it("should have numeric scores for text models", () => {
    const textScores = ARENA_SCORES.text;
    expect(textScores["gemini-3.5-flash"]).toBeGreaterThan(1500);
    expect(textScores["claude-mythos-5-thinking"]).toBe(1550);
  });

  it("should have numeric scores for code models", () => {
    const codeScores = ARENA_SCORES.code;
    expect(codeScores["claude-mythos-5-thinking"]).toBe(1595);
    expect(codeScores["gemini-3.5-flash"]).toBe(1485);
  });

  it("should verify that scores are integers", () => {
    for (const [, score] of Object.entries(ARENA_SCORES.text)) {
      expect(typeof score).toBe("number");
      expect(Number.isInteger(score)).toBe(true);
    }
  });
});
