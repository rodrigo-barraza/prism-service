/**
 * Prompt 17, Landing 2 — agent definitions as files: frontmatter parsing
 * (multi-line strings, lists, missing optional fields, malformed YAML) and
 * the mtime cache.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentDefinitionFileCache,
  parseAgentDefinitionFile,
} from "#src/services/agents/AgentDefinitionFiles";
import {
  normalizeAgentDefinitionBody,
  normalizeAgentDefinitionFields,
  resolveModelAlias,
} from "#src/services/agents/AgentDefinitionFields";

function parse(content: string, filePath = "/workspace/.claude/agents/reviewer.md") {
  return parseAgentDefinitionFile(content, filePath);
}

function definitionOf(content: string, filePath?: string) {
  const result = parse(content, filePath);
  if ("error" in result) throw new Error(`expected a definition, got: ${result.error}`);
  return result.definition;
}

describe("parseAgentDefinitionFile — frontmatter", () => {
  it("reads every field, with the Markdown body as the system prompt", () => {
    const definition = definitionOf(`---
name: code-reviewer
description: Reviews a diff for correctness bugs.
model: claude-sonnet-5
provider: anthropic
effort: low
tools: [read_file, search_file_contents]
disallowedTools: [execute_shell]
maxTurns: 12
permissionMode: plan
color: blue
---
You are a careful reviewer.

Report only real bugs.
`);
    expect(definition).toMatchObject({
      agentId: "CUSTOM_CODE_REVIEWER",
      name: "code-reviewer",
      prompt: "You are a careful reviewer.\n\nReport only real bugs.",
      color: "blue",
      fields: {
        description: "Reviews a diff for correctness bugs.",
        model: "claude-sonnet-5",
        provider: "anthropic",
        effort: "low",
        tools: ["read_file", "search_file_contents"],
        disallowedTools: ["execute_shell"],
        maxTurns: 12,
        permissionMode: "plan",
      },
    });
  });

  it("multi-line strings: literal (|) and folded (>) block scalars", () => {
    const literal = definitionOf(`---
name: literal
description: |
  First line.
  Second line.
---
body`);
    expect(literal.fields.description).toBe("First line.\nSecond line.");

    const folded = definitionOf(`---
name: folded
description: >
  One sentence
  folded onto one line.
---
body`);
    expect(folded.fields.description).toBe("One sentence folded onto one line.");
  });

  it("lists: block sequence, flow sequence and Claude Code's comma-separated string", () => {
    const block = definitionOf(`---
name: block
description: d
tools:
  - read_file
  - find_files
---
`);
    expect(block.fields.tools).toEqual(["read_file", "find_files"]);

    const flow = definitionOf(`---
name: flow
description: d
disallowedTools: [write_file, execute_shell]
---
`);
    expect(flow.fields.disallowedTools).toEqual(["write_file", "execute_shell"]);

    // Claude Code's own tool names map to Prism's; rule text keeps the tool.
    const claudeCode = definitionOf(`---
name: claude-code
description: d
tools: Read, Grep, Glob, Bash(git status), WebSearch, mcp__github__list_issues
---
`);
    expect(claudeCode.fields.tools).toEqual([
      "read_file",
      "search_file_contents",
      "find_files",
      "execute_shell",
      "search_web",
      "mcp__github__list_issues",
    ]);
  });

  it("missing optional fields stay absent; the name falls back to the file name", () => {
    const definition = definitionOf(
      `---
description: Only a description.
---
Prompt.`,
      "/workspace/.prism/agents/Doc Writer.md",
    );
    expect(definition.name).toBe("Doc Writer");
    expect(definition.agentId).toBe("CUSTOM_DOC_WRITER");
    expect(definition.fields).toEqual({ description: "Only a description." });
  });

  it("model aliases resolve to the newest catalogued model and its provider; inherit pins nothing", () => {
    expect(resolveModelAlias("opus")).toBe("claude-opus-5-5");
    expect(resolveModelAlias("sonnet")).toBe("claude-sonnet-5");
    expect(resolveModelAlias("haiku")).toBe("claude-haiku-4-5-20251001");
    expect(normalizeAgentDefinitionFields({ model: "opus" }).fields).toEqual({
      model: "claude-opus-5-5",
      provider: "anthropic",
    });
    expect(normalizeAgentDefinitionFields({ model: "inherit" }).fields).toEqual({});
    // A catalogued model brings its provider.
    expect(normalizeAgentDefinitionFields({ model: "gemini-3.6-flash" }).fields.provider).toBe("google");
  });

  it("Claude Code's unquoted colon in a description parses (the leniency Claude Code applies)", () => {
    const definition = definitionOf(`---
name: planner
description: Use this agent when: the task needs a plan first.
---
`);
    expect(definition.fields.description).toBe("Use this agent when: the task needs a plan first.");
  });

  it("malformed YAML is a clear error naming the line — not a throw", () => {
    const result = parse(`---
name: broken
description: d
tools: [read_file, find_files
---
body`);
    expect(result).toEqual({ error: expect.stringMatching(/^invalid YAML frontmatter at line \d+, column \d+: /) });
  });

  it("no frontmatter, a non-mapping frontmatter, a missing description: clear errors", () => {
    expect(parse("Just a prompt.")).toEqual({ error: expect.stringContaining("missing YAML frontmatter") });
    expect(parse("---\n- a\n- b\n---\nbody")).toEqual({ error: expect.stringContaining("must be a mapping") });
    expect(parse("---\nname: x\n---\nbody")).toEqual({ error: expect.stringContaining("description is required") });
  });

  it("invalid field values name the field and what it accepts", () => {
    const result = parse(`---
name: bad
description: d
effort: hgih
maxTurns: 0
permissionMode: yolo
provider: anthropic
---
`);
    expect("error" in result && result.error).toMatch(/effort must be one of none, minimal, low, medium, high, xhigh, max/);
    expect("error" in result && result.error).toMatch(/maxTurns must be an integer from 1 to 100/);
    expect("error" in result && result.error).toMatch(/permissionMode must be one of/);
    expect("error" in result && result.error).toMatch(/provider needs a model/);
  });

  it("bypassPermissions (Claude Code's name) is the bypass mode", () => {
    expect(normalizeAgentDefinitionFields({ permissionMode: "bypassPermissions" }).fields.permissionMode).toBe("bypass");
  });
});

describe("normalizeAgentDefinitionBody — the custom-agents routes", () => {
  it("rewrites tools to availableTools and resolves the model alias", () => {
    expect(normalizeAgentDefinitionBody({ name: "A", tools: "Read, Grep", model: "haiku", effort: "LOW" })).toEqual({
      body: {
        name: "A",
        availableTools: ["read_file", "search_file_contents"],
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        effort: "low",
      },
    });
  });

  it("returns every invalid field", () => {
    expect(normalizeAgentDefinitionBody({ name: "A", maxTurns: 1.5, effort: 3 })).toEqual({
      errors: [
        expect.stringContaining("effort must be one of"),
        expect.stringContaining("maxTurns must be an integer"),
      ],
    });
  });
});

describe("AgentDefinitionFileCache — mtime cache", () => {
  let root: string;
  let parsedPaths: string[];

  function writeAgent(relativePath: string, content: string, mtimeSeconds?: number) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    if (mtimeSeconds !== undefined) fs.utimesSync(filePath, mtimeSeconds, mtimeSeconds);
    return filePath;
  }

  function newCache(intervalMilliseconds = 0) {
    return new AgentDefinitionFileCache(() => [root], intervalMilliseconds, (filePath) => {
      parsedPaths.push(filePath);
    });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-definitions-"));
    parsedPaths = [];
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("parses a file once, and again only when its mtime changes", () => {
    const filePath = writeAgent(".claude/agents/a.md", "---\nname: a\ndescription: first\n---\n", 1_000);
    const cache = newCache();

    expect(cache.scan().definitions.map((definition) => definition.fields.description)).toEqual(["first"]);
    expect(cache.scan().changed).toBe(false);
    expect(parsedPaths).toEqual([filePath]);

    // Same size, new content, new mtime: re-parsed.
    writeAgent(".claude/agents/a.md", "---\nname: a\ndescription: again\n---\n", 2_000);
    const rescan = cache.scan();
    expect(rescan.changed).toBe(true);
    expect(rescan.definitions[0].fields.description).toBe("again");
    expect(parsedPaths).toEqual([filePath, filePath]);
  });

  it("drops a deleted file and picks up a new one", () => {
    const first = writeAgent(".claude/agents/a.md", "---\nname: a\ndescription: d\n---\n");
    const cache = newCache();
    expect(cache.scan().definitions).toHaveLength(1);

    fs.rmSync(first);
    writeAgent(".prism/agents/b.md", "---\nname: b\ndescription: d\n---\n");
    const scan = cache.scan();
    expect(scan.changed).toBe(true);
    expect(scan.definitions.map((definition) => definition.name)).toEqual(["b"]);
  });

  it("throttles: within the interval a scan returns the previous one without touching disk", () => {
    writeAgent(".claude/agents/a.md", "---\nname: a\ndescription: d\n---\n");
    const cache = newCache(60_000);
    expect(cache.scan().definitions).toHaveLength(1);
    writeAgent(".claude/agents/b.md", "---\nname: b\ndescription: d\n---\n");
    expect(cache.scan().definitions).toHaveLength(1);
    expect(cache.scan({ force: true }).definitions).toHaveLength(2);
  });

  it(".prism/agents outranks .claude/agents for the same agent; the other is reported shadowed", () => {
    writeAgent(".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: claude\n---\n");
    const prismPath = writeAgent(".prism/agents/reviewer.md", "---\nname: Reviewer\ndescription: prism\n---\n");
    const scan = newCache().scan();
    expect(scan.definitions.map((definition) => definition.fields.description)).toEqual(["prism"]);
    expect(scan.shadowed).toEqual([
      { path: path.join(root, ".claude/agents/reviewer.md"), agentId: "CUSTOM_REVIEWER", shadowedBy: prismPath },
    ]);
  });

  it("a rejected file is reported with its error and does not stop the others", () => {
    const badPath = writeAgent(".claude/agents/bad.md", "---\nname: bad\ndescription: [unclosed\n---\n");
    writeAgent(".claude/agents/good.md", "---\nname: good\ndescription: d\n---\n");
    const scan = newCache().scan();
    expect(scan.definitions.map((definition) => definition.name)).toEqual(["good"]);
    expect(scan.errors).toEqual([{ path: badPath, error: expect.stringContaining("invalid YAML frontmatter") }]);
  });

  it("a missing agents directory is simply nothing", () => {
    expect(newCache().scan()).toMatchObject({ definitions: [], errors: [], shadowed: [] });
  });
});
