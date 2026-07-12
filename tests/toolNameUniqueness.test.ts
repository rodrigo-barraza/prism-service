import "./setup.ts";
import { describe, it, expect, vi, beforeAll } from "vitest";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";

vi.mock("#src/services/FileService", () => ({
  default: {
    extractKey: (imageReference: string) => imageReference.replace("minio://", ""),
    getFile: vi.fn().mockResolvedValue(null),
  },
}));

/**
 * These tests guard against duplicate tool names across all schema sources
 * that feed into the LLM tool array. Anthropic (and others) reject requests
 * when duplicate tool names are present: "tools: Tool names must be unique".
 *
 * The three sources are:
 *   1. cachedAISchemas — fetched from tools-api (/admin/tool-schemas)
 *   2. InternalToolRegistry — local tools in prism-service (ReminderTools, etc.)
 *   3. Orchestrator tools — create_team and related orchestration tools
 *
 * If a tool name exists in more than one source, these tests will fail,
 * catching the collision before it reaches production.
 */

const MOCK_API_SCHEMAS = [
  { name: "get_weather", description: "Get weather", domain: "Weather", endpoint: { path: "/weather" } },
  { name: "search_web", description: "Search the web", domain: "Web", endpoint: { path: "/web/search" } },
  { name: "create_cron_job", description: "Create cron job", domain: "Core Schedule Tools", endpoint: { path: "/agentic/scheduled-task/create", method: "POST" } },
  { name: "list_cron_jobs", description: "List cron jobs", domain: "Core Schedule Tools", endpoint: { path: "/agentic/scheduled-task/list", method: "POST" } },
  { name: "delete_cron_job", description: "Delete cron job", domain: "Core Schedule Tools", endpoint: { path: "/agentic/scheduled-task/delete", method: "POST" } },
  { name: "read_file", description: "Read file", domain: "Workspace", endpoint: { path: "/agentic/file/read" } },
];

describe("Tool Name Uniqueness", () => {
  beforeAll(async () => {
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      const urlString = String(url);
      if (urlString.includes("/admin/tool-schemas")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => MOCK_API_SCHEMAS,
        } as any;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({}),
      } as any;
    });
    await ToolOrchestratorService.refreshSchemas();
  });

  it("getToolSchemas() returns no duplicate tool names", () => {
    const allSchemas = ToolOrchestratorService.getToolSchemas();
    const allToolNames = allSchemas.map((tool) => tool.name);

    const duplicateToolNames = allToolNames.filter(
      (toolName, index) => allToolNames.indexOf(toolName) !== index,
    );

    expect(
      duplicateToolNames,
      `Duplicate tool names found in getToolSchemas(): [${[...new Set(duplicateToolNames)].join(", ")}]. ` +
      `Each tool name must be unique across tools-api, InternalToolRegistry, and orchestrator tools. ` +
      `Anthropic rejects requests with duplicate tool names.`,
    ).toEqual([]);
  });

  it("getClientToolSchemas() returns no duplicate tool names", () => {
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
    const allToolNames = clientSchemas.map((tool) => tool.name);

    const duplicateToolNames = allToolNames.filter(
      (toolName, index) => allToolNames.indexOf(toolName) !== index,
    );

    expect(
      duplicateToolNames,
      `Duplicate tool names found in getClientToolSchemas(): [${[...new Set(duplicateToolNames)].join(", ")}]. ` +
      `Each tool name must be unique across all schema sources.`,
    ).toEqual([]);
  });

  it("InternalToolRegistry has no self-duplicate tool names", () => {
    const internalSchemas = InternalToolRegistry.getSchemas();
    const internalToolNames = internalSchemas.map((tool) => tool.name);

    const duplicateToolNames = internalToolNames.filter(
      (toolName, index) => internalToolNames.indexOf(toolName) !== index,
    );

    expect(
      duplicateToolNames,
      `Duplicate tool names within InternalToolRegistry: [${[...new Set(duplicateToolNames)].join(", ")}]`,
    ).toEqual([]);
  });

  it("InternalToolRegistry tool names do not collide with tools-api schema names", () => {
    const internalToolNames = new Set(InternalToolRegistry.getSchemas().map((tool) => tool.name));
    const apiToolNames = MOCK_API_SCHEMAS.map((tool) => tool.name);

    const collisions = apiToolNames.filter((toolName) => internalToolNames.has(toolName));

    expect(
      collisions,
      `Tool name collisions between InternalToolRegistry and tools-api: [${collisions.join(", ")}]. ` +
      `Remove the duplicate from one source. Internal tools take execution priority ` +
      `(via InternalToolRegistry.has() check), but both schemas still get sent to the LLM.`,
    ).toEqual([]);
  });
});
