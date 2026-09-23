/**
 * The lightweight budget preset (ModelProfiles `budget`) for small local
 * models: no sub-agent or async-task tools, at most `maxTools` tools with
 * the discovery tools kept, and a system prompt without the directory tree
 * or the orchestrator addendum — applied in AgenticToolResolver and read
 * back by the prompt assembler through the agent conversation's ToolContext.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const schema = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
const WORK_TOOLS = Array.from({ length: 20 }, (_, index) => schema(`work_tool_${index + 1}`));
const ORCHESTRATOR_TOOLS = ["create_subagents", "send_subagent_message", "get_subagent_output"].map(schema);
const ASYNC_TOOLS = ["run_async_task", "wait_for_tasks"].map(schema);
const DISCOVERY_TOOLS = ["search_tools", "enable_tools", "discover_and_enable_tools"].map(schema);

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getToolSchemas: vi.fn(() => [...WORK_TOOLS, ...ORCHESTRATOR_TOOLS, ...ASYNC_TOOLS, ...DISCOVERY_TOOLS]),
    getMCPToolSchemas: vi.fn(() => []),
    getClientToolSchemas: vi.fn(() => [...WORK_TOOLS, ...ORCHESTRATOR_TOOLS, ...ASYNC_TOOLS, ...DISCOVERY_TOOLS]),
    getToolEmoji: vi.fn().mockReturnValue(null),
  },
}));
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: { getCollection: vi.fn(() => null), getDb: vi.fn(() => null) },
}));
vi.mock("#src/services/AgentPersonaRegistry", () => ({
  default: { get: vi.fn(() => ({ availableTools: ["*"], enabledByDefaultTools: ["*"] })) },
}));
vi.mock("#src/services/tool-definitions/InternalToolRegistry", () => ({
  default: { getNames: vi.fn(() => new Set<string>()) },
}));

import AgenticToolResolver from "#src/services/AgenticToolResolver";
import ToolContext from "#src/services/ToolContext";
import {
  applyToolBudget,
  budgetPresetFor,
  recordBudgetPreset,
  sectionsWithinBudget,
} from "#src/services/BudgetPreset";
import { BUDGET_PRESETS } from "#src/providers/ModelProfiles";
import { SYSTEM_PROMPT_SECTIONS } from "#src/constants";
import { wrapTag } from "#src/utils/SystemMessageTags";

const SMALL = { providerName: "vllm", resolvedModel: "google/gemma-4-12b-it" };
const LARGE = { providerName: "vllm", resolvedModel: "Qwen/Qwen3.8-27B" };
const ORCHESTRATOR_NAMES = ORCHESTRATOR_TOOLS.map((tool) => tool.name);
const ASYNC_NAMES = ASYNC_TOOLS.map((tool) => tool.name);

afterEach(() => {
  for (const id of ["conversation-small", "conversation-large", "conversation-x"]) ToolContext.cleanupInMemory(id);
});

describe("applyToolBudget", () => {
  const tools = [...WORK_TOOLS, ...ORCHESTRATOR_TOOLS, ...ASYNC_TOOLS, ...DISCOVERY_TOOLS];

  it("returns the standard set untouched", () => {
    const result = applyToolBudget(tools, BUDGET_PRESETS.standard);
    expect(result.tools).toBe(tools);
    expect(result.unavailable).toEqual([]);
  });

  it("drops background-work tools and caps the set, keeping the discovery tools", () => {
    const { tools: kept, unavailable } = applyToolBudget(tools, BUDGET_PRESETS.lightweight);
    const names = kept.map((tool) => tool.name);
    expect(names).toHaveLength(BUDGET_PRESETS.lightweight.maxTools!);
    for (const name of [...ORCHESTRATOR_NAMES, ...ASYNC_NAMES]) {
      expect(names).not.toContain(name);
      expect(unavailable).toContain(name);
    }
    expect(names).toEqual(expect.arrayContaining(DISCOVERY_TOOLS.map((tool) => tool.name)));
    // Capped-out tools are not unavailable: the model can still enable them.
    expect(unavailable).not.toContain("work_tool_20");
  });

  it("keeps explicitly enabled tools ahead of the rest", () => {
    const { tools: kept } = applyToolBudget(tools, BUDGET_PRESETS.lightweight, ["work_tool_20", "work_tool_19"]);
    const names = kept.map((tool) => tool.name);
    expect(names).toContain("work_tool_20");
    expect(names).toContain("work_tool_19");
    expect(names).not.toContain("work_tool_9");
  });
});

describe("AgenticToolResolver — budget by model", () => {
  it("gives a small local model the lightweight tool set", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "CODING",
      agentConversationId: "conversation-small",
      ...SMALL,
    });
    const names = finalTools.map((tool) => tool.name);
    expect(names.length).toBeLessThanOrEqual(BUDGET_PRESETS.lightweight.maxTools!);
    for (const name of [...ORCHESTRATOR_NAMES, ...ASYNC_NAMES]) expect(names).not.toContain(name);
    expect(names).toContain("search_tools");
    expect(budgetPresetFor(SMALL.resolvedModel, SMALL.providerName).name).toBe("lightweight");
  });

  it("leaves a large model's tool set alone", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: {},
      agent: "CODING",
      agentConversationId: "conversation-large",
      ...LARGE,
    });
    const names = finalTools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([...ORCHESTRATOR_NAMES, ...ASYNC_NAMES, "work_tool_20"]));
  });
});

describe("sectionsWithinBudget", () => {
  const sections = [
    wrapTag(SYSTEM_PROMPT_SECTIONS.IDENTITY, "You are Prism."),
    wrapTag(SYSTEM_PROMPT_SECTIONS.ORCHESTRATOR, "Spawn sub-agents with create_subagents."),
    wrapTag(SYSTEM_PROMPT_SECTIONS.ENVIRONMENT, "Linux"),
    wrapTag(SYSTEM_PROMPT_SECTIONS.PROJECT_STRUCTURE, "src/\n  index.ts"),
  ];

  it("keeps every section for a conversation on the standard preset", () => {
    expect(sectionsWithinBudget(sections, "conversation-x")).toEqual(sections);
    expect(sectionsWithinBudget(sections, null)).toEqual(sections);
  });

  it("leaves out the orchestrator addendum and the directory tree on the lightweight preset", () => {
    recordBudgetPreset("conversation-x", BUDGET_PRESETS.lightweight);
    expect(sectionsWithinBudget(sections, "conversation-x")).toEqual([sections[0], sections[2]]);
  });

  it("goes back to the full prompt when the conversation moves to a larger model", () => {
    recordBudgetPreset("conversation-x", BUDGET_PRESETS.lightweight);
    recordBudgetPreset("conversation-x", BUDGET_PRESETS.standard);
    expect(sectionsWithinBudget(sections, "conversation-x")).toEqual(sections);
  });
});
