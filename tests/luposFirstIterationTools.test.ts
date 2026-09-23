/**
 * luposFirstIterationTools.test.ts
 *
 * What LUPOS's first iteration carries, resolved through the real path:
 * AgenticToolResolver + AgentPersonaRegistry + the real InternalToolRegistry
 * (every Prism-local tool), over a tools-service catalog that holds every
 * tool tools-service files under a Core domain (ToolSchemaService's domain
 * map, 2026-09-22) — the tools coreToolsLocked hands to iteration 1.
 *
 * Each Discord reply is a fresh one-shot conversation. Before the trim his
 * iteration 1 carried ~40 core schemas (≈13K tokens) of which 30 days of
 * traffic used one; the core set is now pinned exactly, so a new core tool
 * reaching him is a decision somebody makes here, not a silent regrowth.
 */
import "./setup.ts";
import { describe, it, expect, vi, beforeAll } from "vitest";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import AgenticToolResolver from "#src/services/AgenticToolResolver";
import { AGENT_IDS, TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import { LuposPersona } from "#src/services/personas/LuposPersona";
import { partitionByDiscoverableUniverse } from "#src/services/ToolDiscoveryScope";

function catalogTool(name: string, domain: string) {
  return {
    name,
    description: `${name} (test catalog)`,
    parameters: { type: "object", properties: {} },
    domain,
    endpoint: { path: `/test/${name}` },
  };
}

const CORE_HARNESS = "Core Harness Tools";
const TOOLS_SERVICE_CATALOG = [
  // Core Harness Tools — tools-service
  ...[
    "read_url",
    "evaluate_expression",
    "execute_python",
    "execute_javascript",
    "think",
    "sleep",
    "emit_structured_output",
    "search_web",
    "save_memory",
    "write_datastore",
    "query_datastore",
    "delete_datastore",
  ].map((name) => catalogTool(name, CORE_HARNESS)),
  catalogTool("search_tools", "Core Discover Tools"),
  ...["create_task", "get_task", "list_tasks", "update_task"].map((name) =>
    catalogTool(name, "Core Task Tools"),
  ),
  ...["create_cron_job", "list_cron_jobs", "delete_cron_job", "trigger_cron_job"].map(
    (name) => catalogTool(name, "Core Schedule Tools"),
  ),
  ...["read_file", "write_file", "execute_command", "run_git"].map((name) =>
    catalogTool(name, "Core Workspace Tools"),
  ),
  // The Discord and Creative tools his defaults name, and a few he reaches
  // only through discovery.
  ...[
    "react_to_discord_message",
    "get_discord_gold_balance",
    "give_discord_gold",
    "mug_discord_gold",
    "get_discord_user_profile",
    "search_discord_messages",
    "get_discord_guild_emojis",
    "create_discord_poll",
    "schedule_discord_reminder",
  ].map((name) => catalogTool(name, "Discord")),
  catalogTool("generate_image", "Creative"),
  catalogTool("execute_shell", "Compute"),
  catalogTool("send_email", "Communication"),
  catalogTool("get_weather", "Weather & Environment"),
];

/** Everything he may call on iteration 1 beyond his defaults. */
const EXPECTED_CORE_TOOLS = [
  TOOL_NAMES.READ_URL,
  TOOL_NAMES.SEARCH_WEB,
  TOOL_NAMES.EXECUTE_PYTHON,
  TOOL_NAMES.EXECUTE_JAVASCRIPT,
  TOOL_NAMES.CALCULATE_PRECISE,
  TOOL_NAMES.RETRIEVE_OFFLOADED_CONTENT,
  TOOL_NAMES.THINK,
  TOOL_NAMES.SEARCH_TOOLS,
  TOOL_NAMES.ENABLE_TOOLS,
  TOOL_NAMES.DISABLE_TOOLS,
  TOOL_NAMES.DISCOVER_AND_ENABLE_TOOLS,
].sort();

const DEFAULT_TOOLS = LuposPersona.enabledByDefaultTools ?? [];

beforeAll(async () => {
  vi.mocked(global.fetch).mockImplementation(async (url) => {
    if (String(url).includes("/admin/tool-schemas")) {
      return { ok: true, status: 200, json: async () => TOOLS_SERVICE_CATALOG } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  await ToolOrchestratorService.refreshSchemas();
});

/** Names in `tools` that the catalog marks system:true (the core surface). */
function coreNames(tools: Array<{ name: string }>): string[] {
  const systemNames = new Set(
    ToolOrchestratorService.getClientToolSchemas()
      .filter((schema) => schema.system === true)
      .map((schema) => schema.name),
  );
  return tools
    .map((tool) => tool.name)
    .filter((name) => systemNames.has(name))
    .sort();
}

async function resolveLupos(
  options: Record<string, unknown> = {},
  modelDefinition?: Record<string, unknown>,
) {
  return AgenticToolResolver.resolve({
    options,
    agent: AGENT_IDS.LUPOS,
    project: "lupos",
    username: "discord",
    ...(modelDefinition && { modelDefinition }),
  });
}

describe("LUPOS iteration 1 — core surface", () => {
  it("carries exactly the web, sandbox, recall, think and discovery tools beside his defaults", async () => {
    const { finalTools } = await resolveLupos();

    expect(coreNames(finalTools)).toEqual(EXPECTED_CORE_TOOLS);
    expect(finalTools.map((tool) => tool.name).sort()).toEqual(
      [...DEFAULT_TOOLS, ...EXPECTED_CORE_TOOLS].sort(),
    );
  });

  it("drops think when the model reasons natively", async () => {
    const { finalTools } = await resolveLupos({}, { thinking: true });

    expect(coreNames(finalTools)).toEqual(
      EXPECTED_CORE_TOOLS.filter((name) => name !== TOOL_NAMES.THINK),
    );
  });

  it("keeps the same core set in a prism-client conversation (disabledTools mode)", async () => {
    // The client sends every tool it has not enabled; blockedTools strips
    // the core harness tools there too, even though CORE_HARNESS is granted.
    const { finalTools } = await resolveLupos({
      disabledTools: ["get_discord_guild_emojis", "create_discord_poll"],
    });

    expect(coreNames(finalTools)).toEqual(EXPECTED_CORE_TOOLS);
  });

  it("cannot enable the trimmed tools back mid-turn", async () => {
    // enable_tools / discover_and_enable_tools activate only what this
    // partition allows (ToolDiscoveryScope).
    const trimmed = [
      TOOL_NAMES.SAVE_MEMORY,
      "write_datastore",
      TOOL_NAMES.CREATE_TASK,
      TOOL_NAMES.LIST_SKILLS,
      TOOL_NAMES.CREATE_SKILL,
      "run_async_task",
      "run_tool_program",
      "propose_goal",
      TOOL_NAMES.SLEEP,
    ];
    const { allowed, blocked } = partitionByDiscoverableUniverse(
      LuposPersona,
      ToolOrchestratorService.getClientToolSchemas(),
      [...trimmed, "create_discord_poll", "get_discord_guild_emojis"],
    );

    expect(blocked.sort()).toEqual([...trimmed].sort());
    // …while the Discord tools he is not given up front stay reachable.
    expect(allowed.sort()).toEqual(["create_discord_poll", "get_discord_guild_emojis"]);
    const { discoverableTools } = await resolveLupos();
    expect(discoverableTools.map((tool) => tool.name)).toContain("create_discord_poll");
  });
});
