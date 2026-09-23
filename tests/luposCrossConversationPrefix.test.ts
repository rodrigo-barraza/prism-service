/**
 * luposCrossConversationPrefix.test.ts — audit K1 for LUPOS.
 *
 * Every Discord reply is a fresh one-shot conversation, so the prompt cache
 * that matters is the prefix two DIFFERENT conversations share. Two turns
 * for two different messages — different pre-flight picks, different
 * per-turn context — go through the real request-building path:
 * AgenticLoopService (resolver, pre-flight, activation) → ReActHarness →
 * the real SystemPromptAssembler with the real LUPOS persona and locales →
 * the real Gemini adapter; only the Gemini SDK, the catalog fetch, the
 * pre-flight search and the per-turn services (somatic state, variety,
 * memories) are scripted.
 *
 * Measured on the 2026-09-22 catalog before this change, the two requests'
 * tool blocks diverged at char 575 (~140 tokens: the bridge, then a pick
 * sorted in among his defaults) and the system instructions at char 19,333
 * (a pick-gated policy section spliced in ahead of Gold Rules). Now both are
 * byte-identical — ~13K tokens (chars/4) of shared prefix — and the picks
 * ride a tool-update message after the user's message.
 */
import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_CLOUD_GEMINI_API_KEY = "test-google-key";
});

const captured = vi.hoisted(() => ({
  google: [] as Array<Record<string, unknown>>,
  /** What the model answers, per request; default: a short reply. */
  script: [] as Array<Array<Record<string, unknown>>>,
}));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class MockGoogleGenAI {
    models = {
      generateContentStream: async (request: Record<string, unknown>) => {
        captured.google.push(structuredClone(request));
        const parts = captured.script.shift() ?? [{ text: "whatever, pup" }];
        return (async function* () {
          yield {
            responseId: `g-${captured.google.length}`,
            candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
          };
        })();
      },
      generateContent: vi.fn(),
    };
  },
  Modality: { AUDIO: "AUDIO", TEXT: "TEXT" },
  MediaResolution: { LOW: "LOW", HIGH: "HIGH" },
  ServiceTier: { AUTO: "AUTO", STANDARD: "STANDARD" },
  FunctionCallingConfigMode: { AUTO: "AUTO", ANY: "ANY", NONE: "NONE", VALIDATED: "VALIDATED" },
}));

// Per-turn context differs every turn — it must never reach the prefix.
const perTurn = vi.hoisted(() => ({ tag: "A", picks: [] as string[] }));
vi.mock("#src/services/somatic/SomaticStateService", () => ({
  default: {
    adaptFromMessage: vi.fn(async () => []),
    renderSystemMessage: vi.fn(async () => `somatic state for turn ${perTurn.tag}`),
    getState: vi.fn(async () => null),
  },
}));
vi.mock("#src/services/ResponseVarietyService", () => ({
  default: { renderBlock: vi.fn(async () => `recent replies seen on turn ${perTurn.tag}`) },
}));
vi.mock("#src/services/system-prompt/SkillMemoryScorer", () => ({
  SkillMemoryScorer: class {
    async fetchSkillCatalog() {
      return { entries: [], highlighted: [] };
    }
    async fetchMemories() {
      return { memoriesText: `memories for turn ${perTurn.tag}`, injectedMemoryIds: [] };
    }
  },
}));
vi.mock("#src/services/WorkflowMemoryService", () => ({
  default: { retrieveRelevantWorkflows: vi.fn(async () => ""), createHook: () => async () => {} },
}));
vi.mock("#src/services/MemoryExtractor", () => ({ default: { createHook: () => async () => {} } }));
vi.mock("#src/services/ConversationEmbeddingService", () => ({
  default: { createHook: () => async () => {}, persistCompactionSummary: vi.fn() },
}));

import "./setup.ts";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import AgenticLoopService from "#src/services/AgenticLoopService";
import googleProvider from "#src/providers/google";
import { getModelByName } from "#src/config";
import { LuposPersona } from "#src/services/personas/LuposPersona";

function catalogTool(name: string, domain: string, properties: Record<string, unknown> = {}) {
  return {
    name,
    description: `${name}: what it does (test catalog).`,
    parameters: { type: "object", properties },
    domain,
    endpoint: { path: `/test/${name}` },
  };
}

const text = { type: "string", description: "Text" };
const CATALOG = [
  // His defaults and core harness tools — the declared set.
  ...["react_to_discord_message", "get_discord_gold_balance", "give_discord_gold", "mug_discord_gold", "get_discord_user_profile", "search_discord_messages"].map(
    (name) => catalogTool(name, "Discord", { query: text }),
  ),
  catalogTool("generate_image", "Creative", { prompt: text }),
  ...["read_url", "evaluate_expression", "execute_python", "execute_javascript", "think", "search_web"].map((name) =>
    catalogTool(name, "Core Harness Tools", { input: text }),
  ),
  catalogTool("search_tools", "Core Discover Tools", { query: text }),
  // What pre-flight picks from — each gates a policy section or not.
  catalogTool("create_discord_poll", "Discord", { question: text }),
  catalogTool("synthesize_speech", "Creative", { text }),
  catalogTool("get_anime", "Knowledge", { query: text }),
  catalogTool("get_weather", "Weather & Environment", { location: text }),
  catalogTool("get_moon_phase", "Weather & Environment", {}),
];

const PICKS_A = ["get_weather", "get_moon_phase"];
const PICKS_B = ["create_discord_poll", "get_anime", "synthesize_speech"];

async function runTurn(tag: string, message: string, picks: string[]) {
  perTurn.tag = tag;
  perTurn.picks = picks;
  const before = captured.google.length;
  const emitted: Array<Record<string, unknown>> = [];
  await AgenticLoopService.runAgenticLoop({
    provider: googleProvider as never,
    providerName: "google",
    resolvedModel: "gemini-3.6-flash",
    modelDefinition: getModelByName("gemini-3.6-flash") as never,
    // lupos-bot sends the channel's recent history as the turn's messages.
    messages: [
      { role: "user", content: `[earlier in #general, turn ${tag}] someone said something` },
      { role: "user", content: message },
    ] as never,
    originalMessages: [] as never,
    options: {
      agenticLoopEnabled: true,
      thinkingEnabled: true,
      maxIterations: 4,
      agentContext: {
        platform: "discord",
        guildId: "123456789012345678",
        channelId: "223456789012345678",
        requesterUserId: "323456789012345678",
        platformContext: { description: `#general on turn ${tag}`, ids: `ids for turn ${tag}` },
      },
    },
    agentConversationId: `agent-conv-${tag}`,
    conversationId: `conv-${tag}`,
    isNewConversation: true,
    agent: "LUPOS",
    project: "lupos",
    username: "lupos",
    emit: (event: Record<string, unknown>) => emitted.push(event),
    requestId: `req-${tag}`,
    requestStart: performance.now(),
  } as never);
  return { requests: captured.google.slice(before), emitted };
}

const configOf = (request: Record<string, unknown>) => request.config as Record<string, unknown>;
const systemOf = (request: Record<string, unknown>) => JSON.stringify(configOf(request).systemInstruction);
const toolsOf = (request: Record<string, unknown>) => JSON.stringify(configOf(request).tools);
const declaredNames = (request: Record<string, unknown>) =>
  ((configOf(request).tools as Array<{ functionDeclarations?: Array<{ name: string }> }>) ?? []).flatMap(
    (tool) => (tool.functionDeclarations ?? []).map((declaration) => declaration.name),
  );
const contentsText = (request: Record<string, unknown>) =>
  ((request.contents as Array<{ parts: Array<{ text?: string }> }>) ?? []).map((content) =>
    content.parts.map((part) => part.text ?? "").join(""),
  );

function firstDivergence(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) if (left[index] !== right[index]) return index;
  return left.length === right.length ? -1 : length;
}

describe("LUPOS: two conversations share their static prefix", () => {
  let turnA: Awaited<ReturnType<typeof runTurn>>;
  let turnB: Awaited<ReturnType<typeof runTurn>>;

  beforeAll(async () => {
    vi.mocked(global.fetch).mockImplementation(async (url) => {
      if (String(url).includes("/admin/tool-schemas")) {
        return { ok: true, status: 200, json: async () => CATALOG } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    await ToolOrchestratorService.refreshSchemas();
    vi.spyOn(ToolOrchestratorService, "executeSearchToolsWithMCP").mockImplementation(
      async () => ({ matches: perTurn.picks.map((name) => ({ name })) }) as never,
    );
    turnA = await runTurn("A", "lupos what's the weather and is the moon full", PICKS_A);
    turnB = await runTurn("B", "lupos make a poll about the best anime and say it out loud", PICKS_B);
  });

  it("sends the same system instruction and the same tool block, byte for byte", () => {
    const [requestA] = turnA.requests;
    const [requestB] = turnB.requests;
    const system = systemOf(requestA);
    const tools = toolsOf(requestA);

    expect(firstDivergence(systemOf(requestA), systemOf(requestB))).toBe(-1);
    expect(firstDivergence(toolsOf(requestA), toolsOf(requestB))).toBe(-1);
    // A real prefix, not an empty one (chars/4 ≈ tokens).
    expect((system.length + tools.length) / 4).toBeGreaterThan(4_000);
  });

  it("declares his stable set only — the bridge first, the rest by name, no pick", () => {
    const declared = declaredNames(turnB.requests[0]);
    expect(declared[0]).toBe("tool_call");
    expect(declared.slice(1)).toEqual([...declared.slice(1)].sort());
    for (const pick of [...PICKS_A, ...PICKS_B]) expect(declared).not.toContain(pick);
    for (const tool of LuposPersona.enabledByDefaultTools ?? []) expect(declared).toContain(tool);
  });

  it("keeps pick-gated policy sections out of the system instruction", () => {
    const system = systemOf(turnB.requests[0]);
    expect(system).toContain("# Gold Rules");
    expect(system).not.toContain("# Discord Actions");
    expect(system).not.toContain("# Audio Rules");
  });

  it("delivers the picks after the user's message, with the sections they unlock", () => {
    const texts = contentsText(turnB.requests[0]);
    const userIndex = texts.findIndex((entry) => entry.includes("make a poll about the best anime"));
    const update = texts.at(-1)!;
    expect(texts.length - 1).toBeGreaterThan(userIndex);
    expect(update).toContain("<tool-update>");
    for (const pick of PICKS_B) expect(update).toContain(`### ${pick}`);
    expect(update).toContain("tool_call");
    expect(update).toContain("# Discord Actions");
    expect(update).toContain("# Audio Rules");
    // Turn A's picks unlock no section of his.
    expect(contentsText(turnA.requests[0]).at(-1)).not.toContain("# Discord Actions");
    // Per-turn context stays in the contents, never in the prefix.
    expect(systemOf(turnB.requests[0])).not.toContain("somatic state for turn");
    expect(texts.join("\n")).toContain("somatic state for turn B");
  });

  it("tells the client which tools pre-flight picked", () => {
    const preflight = turnB.emitted.find((event) => event.type === "status" && event.preflight === true);
    expect(preflight).toMatchObject({ dynamicTools: PICKS_B });
  });
});

describe("LUPOS: an activated pick is callable through the bridge", () => {
  beforeEach(() => {
    captured.script = [];
  });

  it("runs a pick the model calls through tool_call, on the same declared tools", async () => {
    const execute = vi
      .spyOn(ToolOrchestratorService, "executeTool")
      .mockResolvedValue({ results: [{ title: "Cowboy Bebop" }] } as never);
    captured.script = [
      [{ functionCall: { name: "tool_call", args: { name: "get_anime", args: { query: "bebop" } } } }],
      [{ text: "bebop. obviously." }],
    ];

    const { requests, emitted } = await runTurn("C", "lupos best anime ever, go", ["get_anime"]);

    expect(requests).toHaveLength(2);
    expect(execute.mock.calls.map((call) => [call[0], call[1]])).toEqual([["get_anime", { query: "bebop" }]]);
    // Watchers (lupos-bot's presence line, the client) see the tool, not the bridge.
    const frames = emitted
      .filter((event) => event.type === "tool_execution")
      .map((event) => [event.status, (event.tool as { name: string; args: unknown }).name, (event.tool as { args: unknown }).args]);
    expect(frames).toEqual([
      ["calling", "get_anime", { query: "bebop" }],
      ["done", "get_anime", { query: "bebop" }],
    ]);
    // The second request extends the first: same tools, same system.
    expect(toolsOf(requests[1])).toBe(toolsOf(requests[0]));
    expect(systemOf(requests[1])).toBe(systemOf(requests[0]));
    execute.mockRestore();
  });
});
