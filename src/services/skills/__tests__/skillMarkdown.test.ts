/**
 * SKILL.md frontmatter through a real YAML parser (prompt 19, Landing 2).
 * The importer's old flat parser split each line at its first colon: a
 * folded or literal description came back as ">" or "|", a list-valued
 * `allowed-tools` vanished, and a quoted value with a colon lost its tail.
 */
import { describe, it, expect } from "vitest";
import {
  parseSkillMarkdown,
  readAllowedTools,
  validateAgentSkill,
} from "../skillMarkdown.ts";

describe("parseSkillMarkdown", () => {
  const cases: Array<{
    label: string;
    content: string;
    frontmatter: Record<string, unknown>;
    body: string;
    error?: RegExp;
  }> = [
    {
      label: "flat keys, quoted value",
      content: '---\nname: x\ndescription: "y z"\n---\n\nbody text',
      frontmatter: { name: "x", description: "y z" },
      body: "body text",
    },
    {
      label: "no frontmatter is all body",
      content: "just a prompt",
      frontmatter: {},
      body: "just a prompt",
    },
    {
      label: "folded multi-line description",
      content: "---\nname: notes\ndescription: >\n  Write release notes\n  from the log.\n---\nBody",
      frontmatter: { name: "notes", description: "Write release notes from the log.\n" },
      body: "Body",
    },
    {
      label: "literal multi-line description keeps its lines",
      content: "---\nname: notes\ndescription: |\n  line one\n  line two\n---\nBody",
      frontmatter: { name: "notes", description: "line one\nline two\n" },
      body: "Body",
    },
    {
      label: "block list",
      content: "---\nname: t\nallowed-tools:\n  - Read\n  - Grep\n---\nBody",
      frontmatter: { name: "t", "allowed-tools": ["Read", "Grep"] },
      body: "Body",
    },
    {
      label: "flow list",
      content: "---\nname: t\nallowed-tools: [Read, Grep]\n---\nBody",
      frontmatter: { name: "t", "allowed-tools": ["Read", "Grep"] },
      body: "Body",
    },
    {
      label: "a colon inside a quoted value",
      content: '---\nname: t\ndescription: "Deploy: then verify"\n---\nBody',
      frontmatter: { name: "t", description: "Deploy: then verify" },
      body: "Body",
    },
    {
      label: "comments and a nested map",
      content: "---\n# a comment\nname: t # trailing\nmetadata:\n  owner: me\n---\nBody",
      frontmatter: { name: "t", metadata: { owner: "me" } },
      body: "Body",
    },
    {
      label: "CRLF line endings and a BOM",
      content: "﻿---\r\nname: t\r\ndescription: d\r\n---\r\nBody\r\n",
      frontmatter: { name: "t", description: "d" },
      body: "Body",
    },
    {
      label: "empty frontmatter",
      content: "---\n---\nBody",
      frontmatter: {},
      body: "Body",
    },
    {
      label: "a --- rule later in the body is body",
      content: "---\nname: t\n---\nAbove\n\n---\n\nBelow",
      frontmatter: { name: "t" },
      body: "Above\n\n---\n\nBelow",
    },
    {
      label: "YAML 1.2 core: yes/on stay strings",
      content: "---\nname: t\nflag: yes\n---\nBody",
      frontmatter: { name: "t", flag: "yes" },
      body: "Body",
    },
    {
      label: "invalid YAML is an error, the body survives",
      content: "---\nname: [unclosed\n---\nBody",
      frontmatter: {},
      body: "Body",
      error: /invalid YAML frontmatter/,
    },
    {
      label: "a list is not a mapping",
      content: "---\n- a\n- b\n---\nBody",
      frontmatter: {},
      body: "Body",
      error: /mapping/,
    },
    {
      label: "never closed",
      content: "---\nname: t\nBody without a closing fence",
      frontmatter: {},
      body: "---\nname: t\nBody without a closing fence",
      error: /never closed/,
    },
  ];

  it.each(cases)("$label", ({ content, frontmatter, body, error }) => {
    const parsed = parseSkillMarkdown(content);
    expect(parsed.frontmatter).toEqual(frontmatter);
    expect(parsed.body).toBe(body);
    if (error) expect(parsed.error).toMatch(error);
    else expect(parsed.error).toBeNull();
  });
});

describe("readAllowedTools", () => {
  it.each([
    { label: "absent", value: undefined, tools: null },
    { label: "block list", value: ["Read", "Grep"], tools: ["Read", "Grep"] },
    { label: "comma string (Claude Code)", value: "Read, Grep, Glob", tools: ["Read", "Grep", "Glob"] },
    { label: "space string (Agent Skills)", value: "Read Grep", tools: ["Read", "Grep"] },
    {
      label: "patterns keep their parenthesised spaces",
      value: "Bash(git status:*) Bash(jq:*), Read",
      tools: ["Bash(git status:*)", "Bash(jq:*)", "Read"],
    },
    { label: "duplicates and blanks dropped", value: ["Read", " ", "Read", 3], tools: ["Read"] },
    { label: "not a list or string", value: { Read: true }, tools: null },
  ])("$label", ({ value, tools }) => {
    expect(readAllowedTools(value)).toEqual(tools);
  });
});

describe("validateAgentSkill (Agent Skills naming rules)", () => {
  it.each([
    { label: "valid", name: "release-notes", description: "Write notes", directory: "release-notes", error: null },
    { label: "missing name", name: undefined, description: "d", directory: "x", error: /name/ },
    { label: "uppercase", name: "Bad_Name", description: "d", directory: "Bad_Name", error: /lowercase/ },
    { label: "double hyphen", name: "a--b", description: "d", directory: "a--b", error: /lowercase/ },
    { label: "leading hyphen", name: "-a", description: "d", directory: "-a", error: /lowercase/ },
    { label: "over 64 chars", name: "a".repeat(65), description: "d", directory: "a".repeat(65), error: /64/ },
    { label: "not the directory's name", name: "notes", description: "d", directory: "release-notes", error: /directory/ },
    { label: "missing description", name: "a", description: "", directory: "a", error: /description/ },
    { label: "description over 1024", name: "a", description: "d".repeat(1025), directory: "a", error: /1024/ },
  ])("$label", ({ name, description, directory, error }) => {
    const result = validateAgentSkill({ name, description }, directory);
    if (error) expect(result).toMatch(error);
    else expect(result).toBeNull();
  });
});
