/**
 * Prompt 17, Landing 2 — file-defined agents in the persona registry:
 * precedence against database agents (the database wins, and the clash is
 * logged), mtime invalidation through the registry, lookup by name or id,
 * and the spawn tools' roster listing name AND description.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./setup.ts";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";
import logger from "#src/utils/logger";

function agentFile(fields: Record<string, string>, prompt = "You help.") {
  const frontmatter = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `---\n${frontmatter}\n---\n${prompt}\n`;
}

describe("file-defined agents in the persona registry", () => {
  let root: string;

  function writeAgent(relativePath: string, content: string, mtimeSeconds?: number) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    if (mtimeSeconds !== undefined) fs.utimesSync(filePath, mtimeSeconds, mtimeSeconds);
    return filePath;
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-"));
  });

  afterEach(() => {
    AgentPersonaRegistry.useAgentDefinitionFiles(() => []);
    AgentPersonaRegistry.unregister("CUSTOM_CODE_REVIEWER");
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("registers a file agent with its pins; the Markdown body is its identity", () => {
    const filePath = writeAgent(
      ".claude/agents/code-reviewer.md",
      agentFile({
        name: "code-reviewer",
        description: "Reviews diffs for correctness bugs. Reports only real ones.",
        model: "opus",
        effort: "high",
        maxTurns: "8",
        permissionMode: "plan",
        tools: "Read, Grep",
        disallowedTools: "Bash",
      }, "You review code carefully."),
    );
    AgentPersonaRegistry.useAgentDefinitionFiles(() => [root], 0);

    const persona = AgentPersonaRegistry.get("CUSTOM_CODE_REVIEWER");
    expect(persona).toMatchObject({
      id: "CUSTOM_CODE_REVIEWER",
      name: "code-reviewer",
      custom: true,
      source: "file",
      sourcePath: filePath,
      model: "claude-opus-5-5",
      provider: "anthropic",
      effort: "high",
      maxTurns: 8,
      permissionMode: "plan",
      availableTools: ["read_file", "search_file_contents"],
      blockedTools: ["execute_shell"],
    });
    expect(persona!.identity({})).toBe("You review code carefully.");
    expect(AgentPersonaRegistry.list()).toContainEqual(
      expect.objectContaining({ id: "CUSTOM_CODE_REVIEWER", custom: true, source: "file" }),
    );
  });

  it("resolves by id or by name, however the model spells it", () => {
    writeAgent(".claude/agents/cr.md", agentFile({ name: "code-reviewer", description: "d" }));
    AgentPersonaRegistry.useAgentDefinitionFiles(() => [root], 0);
    for (const spelling of ["code-reviewer", "Code Reviewer", "CODE_REVIEWER", "CUSTOM_CODE_REVIEWER", "custom_code_reviewer"]) {
      expect(AgentPersonaRegistry.resolve(spelling)?.id).toBe("CUSTOM_CODE_REVIEWER");
    }
    // Built-ins by display name too.
    expect(AgentPersonaRegistry.resolve("Clankerbox")?.id).toBe("STICKERS");
    expect(AgentPersonaRegistry.resolve("coding")?.id).toBe("CODING");
    expect(AgentPersonaRegistry.resolve("nobody")).toBeNull();
  });

  it("the database agent wins a clash, the clash is logged, and the file agent returns when the database one goes", () => {
    const warn = vi.spyOn(logger, "warn");
    writeAgent(".claude/agents/cr.md", agentFile({ name: "Code Reviewer", description: "from the file", model: "haiku" }));
    AgentPersonaRegistry.useAgentDefinitionFiles(() => [root], 0);
    expect(AgentPersonaRegistry.get("CUSTOM_CODE_REVIEWER")?.source).toBe("file");

    AgentPersonaRegistry.registerCustom({
      agentId: "CUSTOM_CODE_REVIEWER",
      name: "Code Reviewer",
      description: "from the database",
      availableTools: ["read_file"],
    });
    const persona = AgentPersonaRegistry.get("CUSTOM_CODE_REVIEWER");
    expect(persona).toMatchObject({ source: "database", description: "from the database" });
    expect(persona?.model).toBeUndefined();
    expect(AgentPersonaRegistry.list().filter((entry) => entry.id === "CUSTOM_CODE_REVIEWER")).toHaveLength(1);

    const report = AgentPersonaRegistry.describeFileAgents();
    expect(report.agents).toEqual([]);
    expect(report.shadowed).toEqual([
      expect.objectContaining({
        agentId: "CUSTOM_CODE_REVIEWER",
        shadowedBy: 'database custom agent "Code Reviewer" (CUSTOM_CODE_REVIEWER)',
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is shadowed by database custom agent"));

    AgentPersonaRegistry.unregister("CUSTOM_CODE_REVIEWER");
    expect(AgentPersonaRegistry.get("CUSTOM_CODE_REVIEWER")).toMatchObject({ source: "file", description: "from the file" });
  });

  it("a file agent named like a built-in is shadowed by it", () => {
    writeAgent(".claude/agents/coding.md", agentFile({ name: "Coding", description: "an impostor" }));
    AgentPersonaRegistry.useAgentDefinitionFiles(() => [root], 0);
    expect(AgentPersonaRegistry.resolve("Coding")?.id).toBe("CODING");
    expect(AgentPersonaRegistry.has("CUSTOM_CODING")).toBe(false);
    expect(AgentPersonaRegistry.describeFileAgents().shadowed).toEqual([
      expect.objectContaining({ agentId: "CUSTOM_CODING", shadowedBy: 'built-in agent "Coding" (CODING)' }),
    ]);
  });

  it("an edited file is picked up by mtime; a rejected one is reported with its reason", () => {
    const filePath = writeAgent(".claude/agents/cr.md", agentFile({ name: "code-reviewer", description: "d", effort: "low" }), 1_000);
    AgentPersonaRegistry.useAgentDefinitionFiles(() => [root], 0);
    expect(AgentPersonaRegistry.get("CUSTOM_CODE_REVIEWER")?.effort).toBe("low");

    writeAgent(".claude/agents/cr.md", agentFile({ name: "code-reviewer", description: "d", effort: "max" }), 2_000);
    expect(AgentPersonaRegistry.get("CUSTOM_CODE_REVIEWER")?.effort).toBe("max");

    writeAgent(".claude/agents/cr.md", agentFile({ name: "code-reviewer", description: "d", effort: "maxx" }), 3_000);
    expect(AgentPersonaRegistry.has("CUSTOM_CODE_REVIEWER")).toBe(false);
    expect(AgentPersonaRegistry.describeFileAgents().errors).toEqual([
      { path: filePath, error: expect.stringContaining("effort must be one of") },
    ]);
  });

  it("the spawn tools' roster lists each agent's name AND description", () => {
    writeAgent(".claude/agents/cr.md", agentFile({
      name: "code-reviewer",
      description: "Reviews diffs for correctness bugs. Reports only real ones.",
    }));
    AgentPersonaRegistry.useAgentDefinitionFiles(() => [root], 0);

    const schemas = ToolOrchestratorService.getToolSchemas() as Array<{
      name: string;
      parameters: { properties: Record<string, { description?: string; items?: { properties: Record<string, { description?: string }> } }> };
    }>;
    const createSubagent = schemas.find((schema) => schema.name === "create_subagent")!;
    const agentParameter = createSubagent.parameters.properties.agent.description!;
    // First sentence of the description, beside the name.
    expect(agentParameter).toContain("'code-reviewer' — Reviews diffs for correctness bugs.");
    expect(agentParameter).not.toContain("Reports only real ones.");
    expect(agentParameter).toContain("'Coding' — ");
    const createSubagents = schemas.find((schema) => schema.name === "create_subagents")!;
    expect(JSON.stringify(createSubagents.parameters)).toContain("'code-reviewer' — Reviews diffs for correctness bugs.");
  });
});
