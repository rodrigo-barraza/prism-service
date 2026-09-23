/**
 * Prompt 17, Landing 3: ask_oracle(question, context?) consults the oracle
 * role model — no tools, a fixed system prompt, the agent's brief and nothing
 * else — and its cost counts against the shared budget.
 *
 * The provider is the REAL Anthropic provider over a mocked SDK: the
 * assertions are on the payload `messages.create` receives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "./setup.ts";

const mockMessagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: (...args: unknown[]) => {
        mockMessagesCreate(...args);
        const data = {
          content: [{ type: "text", text: "Use a lock file; check it with `ls`." }],
          usage: {
            input_tokens: 1_000,
            output_tokens: 400,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          stop_reason: "end_turn",
        };
        return { ...data, withResponse: async () => ({ data, response: { headers: { get: () => null } } }) };
      },
    };
  },
}));

// Every cloud provider has a key — the oracle's default picks by which do.
vi.mock("#src/services/ModelRoleRouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/services/ModelRoleRouter")>()),
  getAvailableCloudProviders: () => new Set(["anthropic", "openai", "google"]),
}));

import anthropicProvider from "#src/providers/anthropic";
import { getProvider } from "#src/providers/index";
import { getPricing, MODALITY_TYPES } from "#src/config";
import RequestLogger from "#src/services/RequestLogger";
import SettingsService from "#src/services/SettingsService";
import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";
import AutoApprovalEngine, { APPROVAL_TIERS } from "#src/services/AutoApprovalEngine";
import { SharedCostBudget } from "#src/services/harnesses/lifecycle/CostBudgetEnforcer";
import { calculateTextCost } from "#src/utils/CostCalculator";
import {
  ORACLE_LIMITS,
  ORACLE_SYSTEM_PROMPT,
  consultOracle,
} from "#src/services/tool-definitions/OracleTool";

/** The main loop runs Gemini; the oracle's default is a frontier model from another provider. */
const callContext = (budget?: SharedCostBudget) => ({
  project: "test-project",
  username: "test-user",
  agent: "CODING",
  conversationId: "oracle-conversation",
  agentConversationId: "oracle-conversation",
  traceId: "trace-oracle",
  _providerName: "google",
  _resolvedModel: "gemini-3.6-flash",
  ...(budget && { _sharedCostBudget: budget }),
});

/** The system prompt as sent, whether a string or text blocks (cache breakpoints). */
function systemTextOf(payload: Record<string, unknown>): string {
  const system = payload.system;
  if (typeof system === "string") return system;
  return (system as Array<{ text: string }>).map((block) => block.text).join("");
}

function userTextOf(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  return (message.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

beforeEach(() => {
  mockMessagesCreate.mockClear();
  vi.mocked(getProvider).mockImplementation(((name: string) => {
    if (name !== "anthropic") throw new Error(`unexpected provider ${name}`);
    return anthropicProvider;
  }) as typeof getProvider);
  const readSection = SettingsService.getSection.bind(SettingsService);
  vi.spyOn(SettingsService, "getSection").mockImplementation((async (section: string) =>
    section === "agents" ? {} : readSection(section as never)) as typeof SettingsService.getSection);
  vi.spyOn(RequestLogger, "logBackgroundLlmCall").mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ask_oracle — request shape", () => {
  it("sends no tools, the fixed system prompt and one user message holding only the brief", async () => {
    const advice = await consultOracle(
      { question: "Should the cache key include the locale?", context: "keys are `${userId}:${path}` today" },
      callContext(),
    );

    expect(advice).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
    const [payload] = mockMessagesCreate.mock.calls[0] as [Record<string, unknown>];

    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("tool_choice");
    expect(systemTextOf(payload)).toBe(ORACLE_SYSTEM_PROMPT);

    const messages = payload.messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(userTextOf(messages[0])).toBe(
      "<question>\nShould the cache key include the locale?\n</question>\n\n" +
        "<context>\nkeys are `${userId}:${path}` today\n</context>",
    );
    expect(payload.max_tokens).toBe(ORACLE_LIMITS.MAXIMUM_OUTPUT_TOKENS);

    expect(RequestLogger.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "agent:oracle", provider: "anthropic", model: "claude-opus-5-5" }),
    );
  });

  it("keeps the system prompt byte-identical across calls (the cacheable prefix) and caps the brief", async () => {
    await consultOracle({ question: "First question?" }, callContext());
    await consultOracle({ question: "Second?", context: "x".repeat(ORACLE_LIMITS.CONTEXT_MAXIMUM_CHARACTERS + 500) }, callContext());

    const [first, second] = mockMessagesCreate.mock.calls.map(([payload]) => payload as Record<string, unknown>);
    expect(systemTextOf(second)).toBe(systemTextOf(first));

    const brief = userTextOf((second.messages as Array<{ content: unknown }>)[0]);
    expect(brief.length).toBeLessThan(ORACLE_LIMITS.CONTEXT_MAXIMUM_CHARACTERS + 200);
    expect(brief).toContain(`[… cut: the brief keeps the first ${ORACLE_LIMITS.CONTEXT_MAXIMUM_CHARACTERS} characters]`);
  });
});

describe("ask_oracle — budget", () => {
  it("charges the call to the shared budget at the oracle model's own prices", async () => {
    const budget = new SharedCostBudget(1);
    budget.record("oracle-conversation", 0.1); // the calling loop's own spend so far

    const advice = await consultOracle({ question: "Which index?" }, callContext(budget));

    const expected = calculateTextCost(
      { inputTokens: 1_000, outputTokens: 400, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)["claude-opus-5-5"],
    )!;
    expect(expected).toBeGreaterThan(0);
    expect(advice).toMatchObject({ costDollars: expected });
    expect(budget.totalSpentDollars()).toBeCloseTo(0.1 + expected, 10);

    // A second consultation adds to the first (the loop's own record is
    // replaced each iteration; the oracle's key accumulates).
    await consultOracle({ question: "And the second index?" }, callContext(budget));
    expect(budget.totalSpentDollars()).toBeCloseTo(0.1 + 2 * expected, 10);
  });

  it("refuses without calling the model once the budget is spent", async () => {
    const budget = new SharedCostBudget(0.05);
    budget.record("oracle-conversation", 0.06);

    const refused = await consultOracle({ question: "Anything?" }, callContext(budget));

    expect(refused).toEqual({ error: expect.stringMatching(/cost budget is spent/) });
    expect(mockMessagesCreate).not.toHaveBeenCalled();
  });
});

describe("ask_oracle — as a tool", () => {
  it("is an internal tool every loop can call without an approval card", async () => {
    expect(InternalToolRegistry.has("ask_oracle")).toBe(true);
    const result = await InternalToolRegistry.execute("ask_oracle", { question: "Ready?" }, callContext());
    expect(result).toMatchObject({ advice: expect.stringContaining("lock file") });

    const engine = new AutoApprovalEngine();
    expect(engine.getTier("ask_oracle")).toBe(APPROVAL_TIERS.AUTO);
    // report_progress (Landing 1) fell to WRITE: a delegate asked the user
    // before it could say how far it had got.
    expect(engine.getTier("report_progress")).toBe(APPROVAL_TIERS.AUTO);
  });
});
