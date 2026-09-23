/**
 * The one path rule for a skill folder: relative, no `..`, no absolute
 * spelling on any platform. read_skill_file, the zip reader and the folder
 * store all normalize through it.
 */
import { describe, it, expect } from "vitest";
import { normalizeSkillFilePath } from "../skillFilePaths.ts";

describe("normalizeSkillFilePath", () => {
  it.each([
    ["references/template.md", "references/template.md"],
    ["./references//template.md", "references/template.md"],
    ["scripts\\collect.sh", "scripts/collect.sh"],
    ["  SKILL.md  ", "SKILL.md"],
    ["a/./b/c.txt", "a/b/c.txt"],
    ["..hidden/file", "..hidden/file"],
    ["file..txt", "file..txt"],
  ])("accepts %j as %j", (input, expected) => {
    expect(normalizeSkillFilePath(input)).toEqual({ path: expected });
  });

  it.each([
    ["../secret.txt", /leaves the skill folder/],
    ["references/../../secret.txt", /leaves the skill folder/],
    ["..\\secret.txt", /leaves the skill folder/],
    ["a/b/..", /leaves the skill folder/],
    ["/etc/passwd", /absolute/],
    ["\\\\server\\share\\x", /absolute/],
    ["C:\\Windows\\win.ini", /absolute/],
    ["c:/x", /absolute/],
    ["~/secret.txt", /absolute/],
    ["~", /absolute/],
    ["", /required/],
    ["   ", /required/],
    [".", /required/],
    ["a\u0000b", /NUL/],
    ["a".repeat(600), /long/],
  ])("rejects %j", (input, message) => {
    const result = normalizeSkillFilePath(input);
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toMatch(message);
  });

  it("rejects a non-string", () => {
    expect(normalizeSkillFilePath(42)).toHaveProperty("error");
  });
});
