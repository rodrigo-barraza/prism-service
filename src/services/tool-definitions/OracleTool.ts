import { DOMAINS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { SharedCostBudget } from "#src/services/harnesses/lifecycle/CostBudgetEnforcer";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import type { TokenUsage } from "#src/types/admin";
import logger from "#src/utils/logger";
import { type InternalToolContext } from "./InternalToolRegistry.ts";

// ────────────────────────────────────────────────────────────
// ask_oracle — a second opinion from a stronger model
// ────────────────────────────────────────────────────────────
// OpenHands' ask_oracle / Anthropic's advisor tool: an agent stuck on a
// decision consults the `oracle` role model (RoleModelResolver — an agent
// pin, then Settings, else a frontier model from ANOTHER provider).
//   • No tools and no conversation: the oracle reads a FIXED system prompt
//     (identical on every call, so a provider can cache it) and the brief
//     the agent writes — question plus the context it chooses to pass.
//   • It returns advice only; the calling agent stays the one who acts.
//   • Its cost is charged to the turn's shared cost budget (the tree-wide
//     SharedCostBudget), and a spent budget refuses the call.
// ────────────────────────────────────────────────────────────

export const ASK_ORACLE_TOOL_NAME = "ask_oracle";

/** The oracle's system prompt. Fixed text — never interpolate into it. */
export const ORACLE_SYSTEM_PROMPT = [
  "You are the oracle: a senior expert that another AI agent consults partway through a task.",
  "You see only the brief the agent wrote below — not its conversation, files or tools — and you cannot act or call tools.",
  "Answer with advice the agent can act on: the answer or approach you recommend and why, the main risk or the thing most likely to be wrong, and how the agent can check it.",
  "Be direct and brief. Prefer one clear recommendation over a survey of options.",
  "If the brief lacks something you need to answer well, say exactly what is missing instead of guessing.",
].join("\n");

export const ORACLE_LIMITS = {
  /** The brief is compact by construction: longer input is cut, and says so. */
  QUESTION_MAXIMUM_CHARACTERS: 4_000,
  CONTEXT_MAXIMUM_CHARACTERS: 24_000,
  /** Room for a thinking model's reasoning plus a short answer. */
  MAXIMUM_OUTPUT_TOKENS: 16_384,
} as const;

function clip(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[… cut: the brief keeps the first ${limit} characters]`;
}

/** The one user message the oracle reads. */
export function buildOracleBrief(question: string, context?: string): string {
  const sections = [`<question>\n${clip(question.trim(), ORACLE_LIMITS.QUESTION_MAXIMUM_CHARACTERS)}\n</question>`];
  if (context?.trim()) {
    sections.push(`<context>\n${clip(context.trim(), ORACLE_LIMITS.CONTEXT_MAXIMUM_CHARACTERS)}\n</context>`);
  }
  return sections.join("\n\n");
}

/** What the tool's execution context carries for it (ToolExecutor fills these). */
export interface OracleCallContext extends InternalToolContext {
  _providerName?: string;
  _resolvedModel?: string;
  _sharedCostBudget?: SharedCostBudget;
  traceId?: string | null;
}

export interface OracleAdvice {
  advice: string;
  provider: string;
  model: string;
  /** Why this model (the routing decision's reason). */
  chosenBecause: string;
  costDollars: number | null;
  usage: TokenUsage | null;
}

/** Ask the oracle. Returns its advice, or `{ error }` — never throws. */
export async function consultOracle(
  { question, context }: { question: string; context?: string },
  callContext: OracleCallContext,
): Promise<OracleAdvice | { error: string }> {
  if (!question.trim()) return { error: "ask_oracle needs a question." };

  // Loaded on use: the registry imports every internal tool, and the
  // provider / routing graph has no business loading with it.
  const [{ getPricing, MODALITY_TYPES }, { getProvider }, { default: RequestLogger }, { resolveOracleModel }, { calculateTextCost }] =
    await Promise.all([
      import("#src/config"),
      import("#src/providers/index"),
      import("#src/services/RequestLogger"),
      import("#src/services/routing/RoleModelResolver"),
      import("#src/utils/CostCalculator"),
    ]);

  const budget = callContext._sharedCostBudget;
  if (budget?.isExceeded()) {
    return {
      error:
        `The cost budget is spent ($${budget.totalSpentDollars().toFixed(4)} of $${budget.maxCostDollars.toFixed(2)}) — ` +
        "the oracle was not consulted.",
    };
  }

  const decision = await resolveOracleModel({
    agent: callContext.agent ?? null,
    main: {
      provider: callContext._providerName ?? "",
      model: callContext._resolvedModel ?? "",
    },
  });
  if (!decision.provider || !decision.model) {
    return { error: "No oracle model is available (no provider key, and no main model to fall back to)." };
  }

  const messages = [
    { role: "system", content: ORACLE_SYSTEM_PROMPT },
    { role: "user", content: buildOracleBrief(question, context) },
  ];
  const requestStartMilliseconds = performance.now();
  let text = "";
  let usage: TokenUsage | null = null;
  let failure: string | null = null;
  try {
    const provider = getProvider(decision.provider) as {
      generateText: (
        messages: unknown[],
        model: string,
        options: Record<string, unknown>,
      ) => Promise<{ text?: string; usage?: TokenUsage }>;
    };
    const result = await provider.generateText(messages, decision.model, {
      maxTokens: ORACLE_LIMITS.MAXIMUM_OUTPUT_TOKENS,
      ...(callContext.signal && { signal: callContext.signal }),
      // A pinned effort; otherwise the oracle model thinks at its own default.
      ...(decision.effort && { reasoningEffort: decision.effort, thinkingLevel: decision.effort }),
    });
    text = result.text ?? "";
    usage = result.usage ?? null;
  } catch (error: unknown) {
    failure = getErrorMessage(error);
  }

  const pricing = getPricing(MODALITY_TYPES.TEXT, MODALITY_TYPES.TEXT)[decision.model];
  const costDollars = calculateTextCost(usage, pricing);
  if (budget && costDollars) {
    budget.charge(`${ASK_ORACLE_TOOL_NAME}:${callContext.agentConversationId || "root"}`, costDollars);
  }

  RequestLogger.logBackgroundLlmCall({
    requestId: crypto.randomUUID(),
    endpoint: "/agent",
    operation: "agent:oracle",
    project: callContext.project ?? "",
    username: callContext.username ?? "",
    agent: callContext.agent || null,
    provider: decision.provider,
    model: decision.model,
    traceId: callContext.traceId || null,
    conversationId: callContext.conversationId || null,
    agentConversationId: callContext.agentConversationId || null,
    aiMessages: messages as Parameters<typeof RequestLogger.logBackgroundLlmCall>[0]["aiMessages"],
    resultText: text,
    usage: usage as Record<string, unknown> | null,
    success: failure === null,
    errorMessage: failure,
    requestStartMilliseconds,
  }).catch((logError: unknown) =>
    logger.warn(`[ask_oracle] Failed to log the oracle call: ${getErrorMessage(logError)}`),
  );

  if (failure !== null) {
    return { error: `The oracle (${decision.provider}/${decision.model}) failed: ${failure}` };
  }
  logger.info(
    `[ask_oracle] ${decision.provider}/${decision.model} (${decision.source}: ${decision.reason}) — ` +
      `${text.length} chars, $${(costDollars ?? 0).toFixed(4)}`,
  );
  return {
    advice: text,
    provider: decision.provider,
    model: decision.model,
    chosenBecause: decision.reason,
    costDollars,
    usage,
  };
}

const askOracle = {
  name: ASK_ORACLE_TOOL_NAME,
  // Reads nothing and changes nothing: the brief is text the agent wrote.
  capabilities: [] as const,
  emoji: INTERNAL_TOOL_EMOJIS[ASK_ORACLE_TOOL_NAME],
  description:
    "Ask a stronger model for a second opinion on a hard decision: a design choice, a bug you cannot explain, a plan you are unsure of. " +
    "The oracle sees ONLY what you write here — not this conversation, the files or your tools — so put everything it needs into `context` (the relevant code, the error, what you tried). " +
    "It cannot act; it returns advice, and you decide what to do with it. It costs more than a normal step and counts against the cost budget: " +
    "use it when being wrong would be expensive, not for routine questions.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: `The question, stated so it can be answered without this conversation (up to ${ORACLE_LIMITS.QUESTION_MAXIMUM_CHARACTERS} characters).`,
      },
      context: {
        type: "string",
        description: `Everything the oracle needs to answer: relevant code, errors, constraints, what you tried (up to ${ORACLE_LIMITS.CONTEXT_MAXIMUM_CHARACTERS} characters).`,
      },
    },
    required: ["question"],
  },
  display: {
    activeVerb: "Consulting the oracle",
    completedVerb: "Consulted the oracle",
    subjectParam: "question",
    subjectFormat: "truncate" as const,
  },
  labels: ["oracle", "advice", "second opinion"],
  domain: DOMAINS.CORE_ORCHESTRATOR.displayName,

  execute(toolArguments: Record<string, unknown>, context: InternalToolContext) {
    return consultOracle(
      {
        question: typeof toolArguments.question === "string" ? toolArguments.question : "",
        context: typeof toolArguments.context === "string" ? toolArguments.context : undefined,
      },
      context as OracleCallContext,
    );
  },
};

export default [askOracle];
