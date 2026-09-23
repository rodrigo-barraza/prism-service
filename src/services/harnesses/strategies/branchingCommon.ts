/**
 * Shared machinery for branching thought structures (ToT / GoT).
 *
 * Tree of Thoughts and Graph of Thoughts differ only in how they
 * pick what to execute (frontier selection vs. synthesis). Everything
 * else — branch generation, multi-criteria scoring, the pre-loop
 * planning phase, tool approval/execution, result commit, and the
 * no-tool-call outcome handling — is identical and lives here.
 *
 * Every function takes a `logLabel` so log lines still identify the
 * calling strategy ("TreeOfThoughts" / "GraphOfThoughts").
 */
import type BaseAgenticHarness from "#src/services/harnesses/BaseAgenticHarness";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  AgenticOptions,
  PassState,
  BeforePromptHookContext,
} from "#src/services/harnesses/types";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import RequestLogger from "#src/services/RequestLogger";
import {
  createStandardHooks,
  attachConfiguredHooks,
} from "#src/services/harnesses/lifecycle/HookInitializer";
import { executeToolBatch } from "#src/services/harnesses/lifecycle/ToolExecutor";
import {
  approvalRecordFor,
  checkAndWaitForApproval,
  orderResultsLikeCalls,
} from "#src/services/harnesses/lifecycle/ApprovalGate";
import {
  buildStopContinuationMessage,
  closeTurnHooks,
  fireInstructionsLoaded,
  fireStopFailure,
  flushHookContext,
  openTurnHooks,
  runPostToolBatchStage,
  runPreToolUseStage,
  runStopStage,
  type LoadedInstruction,
  type TurnHookHandle,
} from "#src/services/harnesses/lifecycle/TurnHooks";
import { buildHookPayload } from "#src/services/hooks/buildPayload";
import { HOOK_EVENTS } from "#src/services/hooks/types";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "#src/services/harnesses/lifecycle/PostExecutionEmitter";
import { runExhaustionRecoveryPass } from "#src/services/harnesses/lifecycle/ExhaustionRecovery";
import {
  handleExitPlanMode,
  checkForPlanModeEntry,
} from "#src/services/harnesses/lifecycle/PlanModeController";
import { buildPlanSubmissionContinuation } from "#src/services/harnesses/lifecycle/PlanSubmissionContinuation";
import { buildToolRetryGuidance } from "#src/services/harnesses/lifecycle/ToolRetryInterceptor";
import {
  isOutputTruncated,
  isAtOutputCeiling,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  buildProviderErrorMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "#src/services/harnesses/lifecycle/OutputTruncationRecovery";
import { injectToolDiscoveryNudge } from "#src/services/harnesses/lifecycle/ToolDiscoveryNudge";
import { finalizePassTracker } from "#src/services/harnesses/lifecycle/TrackerFinalizer";
import { handleCodexPlanningResponse } from "#src/services/harnesses/lifecycle/CodexPlanningDetector";
import { cleanupReminderCache } from "#src/services/harnesses/lifecycle/SystemReminderInjector";
import { streamWithRetries } from "#src/utils/ProviderStreamResilience";
import PlanningModeService from "#src/services/PlanningModeService";
import { HARNESS } from "#src/constants";

const { MAX_CONSECUTIVE_TOOL_ERRORS } = HARNESS;

export interface IterationPassOptions extends AgenticOptions {
  project: string;
  agent?: string | null;
  username: string;
}

export interface CriteriaScores {
  correctness: number;
  risk: number;
  efficiency: number;
  completeness: number;
}

export interface ScoredBranch {
  branchIndex: number;
  text: string;
  thinking: string;
  thinkingSignature: string;
  score: number;
  criteriaScores: CriteriaScores;
  pass: PassState;
}

export type StandardHooks = ReturnType<typeof createStandardHooks> & {
  /** The turn's configured-hook handle, set by `runBeforePromptSetup`. */
  turnHooks?: TurnHookHandle;
};

/**
 * Hooks a strategy run opened, so `runWithTurnHooks` can close them on every
 * exit path — the strategies return from half a dozen places.
 */
const openTurns = new WeakMap<BaseAgenticHarness, StandardHooks>();

/**
 * Run a branching strategy with the turn-level configured hooks closed on
 * every exit (SubagentStop, TurnEnd, session bookkeeping) — the same
 * guarantee the ReAct loop's `finally` gives.
 */
export async function runWithTurnHooks(
  harness: BaseAgenticHarness,
  strategy: (harness: BaseAgenticHarness) => Promise<{ messages: ConversationMessage[] }>,
): Promise<{ messages: ConversationMessage[] }> {
  try {
    return await strategy(harness);
  } finally {
    const standardHooks = openTurns.get(harness);
    openTurns.delete(harness);
    if (standardHooks?.turnHooks) {
      const handle = standardHooks.turnHooks;
      await closeTurnHooks(harness["context"], standardHooks.hooks, harness["state"], handle, {
        blocked: handle.blocked,
        reason: handle.reason,
      });
    }
  }
}

/**
 * Provider-native state a pass produced (OpenAI Responses: message phase,
 * reasoning items no tool call claimed, response.id; Anthropic: thinking
 * blocks) — spread onto the assistant message so it persists and is
 * replayed next turn.
 */
export function providerNativeState(pass: PassState) {
  return {
    ...(pass.phase !== undefined && { phase: pass.phase }),
    ...(pass.reasoningItems &&
      pass.reasoningItems.length > 0 && { reasoningItems: pass.reasoningItems }),
    ...(pass.providerResponseId && {
      providerResponseId: pass.providerResponseId,
    }),
    // Anthropic: the pass's thinking blocks, verbatim and in order
    ...(pass.thinkingBlocks &&
      pass.thinkingBlocks.length > 0 && { thinkingBlocks: pass.thinkingBlocks }),
  };
}

export const BRANCH_STRATEGY_DESCRIPTORS = [
  "",
  "Focus on a MINIMAL approach — use the fewest tools and smallest changes possible. " +
    "Prefer precision over coverage. Choose the simplest solution that could work.",
  "Focus on a THOROUGH approach — maximize correctness and safety. " +
    "Add validation, error handling, and defensive checks even if it means more steps.",
  "Focus on an ALTERNATIVE ARCHITECTURE — if branch 1 would modify code in place, " +
    "consider creating new files. If branch 1 would iterate, consider a batch approach. " +
    "Deliberately diverge from the obvious first solution.",
  "Focus on RISK MINIMIZATION — what approach has the lowest chance of breaking " +
    "existing functionality? Prefer reversible, incremental changes over large rewrites.",
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Pre-loop setup — hooks, beforePrompt, skills emission
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function runBeforePromptSetup(
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
): Promise<StandardHooks> {
  const context = harness["context"];
  const tools = harness["tools"];
  const {
    options,
    conversationId,
    agentConversationId,
    traceId,
    project,
    username,
    agent,
    workspaceRoot,
    emit,
  } = context;

  const standardHooks: StandardHooks = createStandardHooks({
    workspaceRoot: workspaceRoot || undefined,
    autoApprove: options.autoApprove === true,
    policies: options.policies,
    permissionRules: options._permissionRules,
    enableCriticGate: options.enableCriticGate === true,
    criticModel: options.criticModel || undefined,
  });
  const { hooks } = standardHooks;

  // Branching strategies get the user's configured hooks on the same terms as
  // the default harness — a guardrail must not stop applying because the
  // conversation switched to Tree-of-Thoughts.
  await attachConfiguredHooks(hooks, {
    project,
    username,
    agent,
    conversationId,
    agentConversationId: agentConversationId || "",
    workspaceRoot,
    hookDepth: context.parentAgentConversationId ? 1 : 0,
    emit: emit as (event: Record<string, unknown>) => void,
  });

  // The same turn-open events the ReAct loop fires. A refusal is reported on
  // `standardHooks.turnHooks.blocked`; the strategy returns before its loop.
  standardHooks.turnHooks = await openTurnHooks(context, hooks, currentMessages, {
    toolSchemas: tools.finalTools,
  });
  openTurns.set(harness, standardHooks);
  if (standardHooks.turnHooks.blocked) return standardHooks;

  if (options.planFirst) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.PLAN_MODE_ENTERED,
    });
  }

  const hookContext: BeforePromptHookContext = {
    messages: currentMessages,
    project,
    username,
    agent,
    traceId,
    conversationId,
    agentConversationId: agentConversationId || "",
    parentAgentConversationId: context.parentAgentConversationId,
    agentContext: options.agentContext,
    enabledTools: tools.resolvedEnabledTools,
    resolvedToolNames: tools.finalTools.map((tool: ToolSchema) => tool.name),
    workspaceRoot: workspaceRoot || undefined,
    workspaceEnabled: options.workspaceEnabled as boolean | undefined,
    locale: options.locale as string | undefined,
    // ReActHarness passes this; omitting it here silently dropped every
    // user-pinned rule whenever the conversation ran under Tree-of-Thoughts
    // or Graph-of-Thoughts.
    activeRuleNames: options.activeRuleNames as string[] | undefined,
  };
  await hooks.run("beforePrompt", hookContext);
  await fireInstructionsLoaded(
    context,
    hooks,
    hookContext._loadedInstructions as LoadedInstruction[] | undefined,
  );

  if (hookContext._assembledSystemPrompt) {
    const assembledPrompt = hookContext._assembledSystemPrompt as string;
    context.conversationMeta = {
      ...(context.conversationMeta || {}),
      systemPrompt: assembledPrompt,
    };
    if (!options.systemPrompt) {
      options.systemPrompt = assembledPrompt;
    }
  }

  // Expose the skill highlight and catalog to the context budget
  // tracker so skill tokens are reported as their own category.
  if (typeof hookContext._skillsText === "string") {
    options._skillsText = hookContext._skillsText;
  }
  if (typeof hookContext._skillCatalogText === "string") {
    options._skillCatalogText = hookContext._skillCatalogText;
  }

  if (
    Array.isArray(hookContext._injectedSkills) &&
    hookContext._injectedSkills.length > 0
  ) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.SKILLS_INJECTED,
      skills: hookContext._injectedSkills,
    });
  }

  return standardHooks;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Branch generation with structured diversity
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function generateBranch(
  harness: BaseAgenticHarness,
  branchIndex: number,
  totalBranches: number,
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
  failedApproaches: string[] = [],
  logLabel = "Branching",
): Promise<ScoredBranch> {
  const state: AgenticLoopState = harness["state"];
  const context = harness["context"];

  const branchMessages = [...currentMessages];

  if (branchIndex > 0 || failedApproaches.length > 0) {
    const strategyDescriptor =
      BRANCH_STRATEGY_DESCRIPTORS[
        branchIndex % BRANCH_STRATEGY_DESCRIPTORS.length
      ] || BRANCH_STRATEGY_DESCRIPTORS[1];

    let diversityInstruction =
      `[BRANCH ${branchIndex + 1}/${totalBranches}] ` + strategyDescriptor;

    if (failedApproaches.length > 0) {
      const failedSummaries = failedApproaches
        .map((approach, index) => `  ${index + 1}. ${approach}`)
        .join("\n");
      diversityInstruction +=
        `\n\nThe following approach(es) have already been tried and FAILED:\n` +
        `${failedSummaries}\n` +
        `You MUST use a fundamentally different strategy.`;
    }

    branchMessages.push({
      role: "user",
      content: diversityInstruction,
    });
  }

  const pass = harness.createPassState(passOptions);
  const { agentConversationId } = context;
  const resolvedAgentConversationId = agentConversationId || "";
  const requestIdBase =
    context.requestId || resolvedAgentConversationId || crypto.randomUUID();
  const passRequestId = `${requestIdBase}-iter-${state.iterations}-branch-${branchIndex}`;
  pass.requestId = passRequestId;
  harness.registerTrackerRequest(passRequestId);

  const stream = await harness.createProviderStream(branchMessages, passOptions);

  // Context exhaustion guard — return empty branch if budget is critically low
  if (stream === null) {
    logger.warn(
      `[${logLabel}] Context exhaustion on branch ${branchIndex} — returning empty branch.`,
    );
    return {
      branchIndex,
      text: "",
      thinking: "",
      thinkingSignature: "",
      score: 0,
      criteriaScores: {
        correctness: 0,
        risk: 0,
        efficiency: 0,
        completeness: 0,
      },
      pass,
    };
  }

  await harness.consumeStream(stream, pass, allowedToolNames);

  return {
    branchIndex,
    text: pass.streamedText,
    thinking: pass.streamedThinking,
    thinkingSignature: pass.thinkingSignature,
    score: 0,
    criteriaScores: {
      correctness: 0,
      risk: 0,
      efficiency: 0,
      completeness: 0,
    },
    pass,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Pre-loop planning phase
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function runPlanningPhase(
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
  logLabel = "Branching",
): Promise<{ planApproved: boolean }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, project, agent, username, signal } = context;

  const MAX_PLANNING_ITERATIONS = HARNESS.MAX_PLANNING_ITERATIONS;

  await PlanningModeService.injectPlanningInstruction(currentMessages);

  const planModeTools = tools.finalTools.filter(
    (tool: ToolSchema) => tool.name === TOOL_NAMES.EXIT_PLAN_MODE,
  );
  const allowedPlanToolNames = new Set(
    planModeTools.map((tool: ToolSchema) => tool.name),
  );
  const planPassOptions: IterationPassOptions = {
    ...options,
    project,
    agent,
    username,
    tools: planModeTools,
  };

  logger.info(
    `[${logLabel}] Planning phase started — model will plan before branching.`,
  );

  let planningIteration = 0;
  while (planningIteration < MAX_PLANNING_ITERATIONS) {
    planningIteration++;

    if (signal?.aborted) return { planApproved: false };

    const pass = harness.createPassState(planPassOptions);
    const requestIdBase =
      context.requestId || context.agentConversationId || crypto.randomUUID();
    const passRequestId = `${requestIdBase}-plan-${planningIteration}`;
    pass.requestId = passRequestId;
    harness.registerTrackerRequest(passRequestId);

    const stream = await harness.createProviderStream(
      currentMessages,
      planPassOptions,
    );

    // Context exhaustion guard — abort planning if budget is critically low
    if (stream === null) {
      logger.warn(
        `[${logLabel}] Context exhaustion during planning iteration ${planningIteration} — aborting.`,
      );
      break;
    }

    await harness.consumeStream(stream, pass, allowedPlanToolNames);

    finalizePassTracker(pass, passRequestId);
    harness.logIteration(pass, currentMessages);
    harness.emitGenerationProgress();
    harness.emitUsageUpdate();

    if (signal?.aborted) return { planApproved: false };

    const exitPlanToolCall = pass.pendingToolCalls.find(
      (toolCall) => toolCall.name === TOOL_NAMES.EXIT_PLAN_MODE,
    );

    if (exitPlanToolCall) {
      const results: ToolResult[] = [
        {
          name: exitPlanToolCall.name,
          id: exitPlanToolCall.id || "",
          result: {},
        },
      ];

      const { shouldContinueLoop } = await handleExitPlanMode(
        exitPlanToolCall,
        pass,
        results,
        currentMessages,
        context,
        state,
      );

      // Approved or not, the plan and its verdict are part of the turn —
      // a rejected plan is pushed too, so the caller's finalize persists it.
      currentMessages.push({
        role: "assistant",
        content: pass.finalStreamedText || "",
        ...(pass.streamedThinking.trim() && {
          thinking: pass.streamedThinking.trim(),
        }),
        ...(pass.thinkingSignature && {
          thinkingSignature: pass.thinkingSignature,
        }),
        ...providerNativeState(pass),
        toolCalls: [
          {
            id: exitPlanToolCall.id || null,
            name: exitPlanToolCall.name,
            args: exitPlanToolCall.args,
            result: results[0].result,
          },
        ],
      });

      if (!shouldContinueLoop) return { planApproved: false };

      logger.info(
        `[${logLabel}] Plan approved — entering main loop with ${tools.finalTools.length} tool(s).`,
      );
      return { planApproved: true };
    }

    const unauthorizedCalls = pass.pendingToolCalls.filter(
      (toolCall) => toolCall.name !== TOOL_NAMES.EXIT_PLAN_MODE,
    );
    if (unauthorizedCalls.length > 0) {
      const blockedNames = unauthorizedCalls
        .map((toolCall) => toolCall.name)
        .join(", ");
      logger.warn(
        `[${logLabel}] Planning phase: blocked ${unauthorizedCalls.length} unauthorized tool call(s): [${blockedNames}]`,
      );
      if (pass.finalStreamedText || pass.streamedText) {
        currentMessages.push({
          role: "assistant",
          content: pass.finalStreamedText || pass.streamedText,
          ...(pass.streamedThinking.trim() && {
            thinking: pass.streamedThinking.trim(),
          }),
          ...(pass.thinkingSignature && {
            thinkingSignature: pass.thinkingSignature,
          }),
        ...providerNativeState(pass),
        });
      }
      currentMessages.push({
        role: "system",
        content: wrapSystemMessage(
          SYSTEM_MESSAGE_TAGS.PLAN_MODE,
          PromptLocaleService.get(
            (options?.locale as string | undefined) ||
              PromptLocaleService.getDefaultLocale(),
            "harness.planningMode.blocked",
            { blockedNames },
          ),
        ),
      });
      continue;
    }

    if (pass.finalStreamedText || pass.streamedText || pass.streamedThinking.trim()) {
      currentMessages.push({
        role: "assistant",
        content: pass.finalStreamedText || pass.streamedText,
        ...(pass.streamedThinking.trim() && {
          thinking: pass.streamedThinking.trim(),
        }),
        ...(pass.thinkingSignature && {
          thinkingSignature: pass.thinkingSignature,
        }),
      ...providerNativeState(pass),
      });
      // Keep the plan, then ask for it to be submitted — the next request
      // must not end on the assistant turn (no prefill).
      currentMessages.push(
        buildPlanSubmissionContinuation(options?.locale as string | undefined),
      );
      continue;
    }

    logger.warn(
      `[${logLabel}] Planning phase iteration ${planningIteration}: empty output. Aborting planning phase.`,
    );
    state.conversationOutcome = "exhausted";
    return { planApproved: false };
  }

  logger.warn(
    `[${logLabel}] Planning phase exhausted ${MAX_PLANNING_ITERATIONS} iterations without exit_plan_mode call.`,
  );
  state.conversationOutcome = "exhausted";
  return { planApproved: false };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Multi-criteria scoring (§2.1.2)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function scoreBranchesMultiCriteria(
  harness: BaseAgenticHarness,
  branches: ScoredBranch[],
  logLabel = "Branching",
): Promise<ScoredBranch[]> {
  if (branches.length <= 1) {
    if (branches[0]) {
      branches[0].score = 10;
      branches[0].criteriaScores = {
        correctness: 10,
        risk: 10,
        efficiency: 10,
        completeness: 10,
      };
    }
    return branches;
  }

  const context = harness["context"];

  try {
    const candidateSummaries = branches
      .map((branch, index) => {
        const textPreview = (branch.text || branch.thinking || "(no output)")
          .slice(0, 500)
          .trim();
        const toolCallCount = branch.pass.pendingToolCalls.length;
        const toolCallNames = branch.pass.pendingToolCalls
          .map((toolCall) => toolCall.name)
          .join(", ");
        return (
          `[Candidate ${index + 1}] ` +
          `${toolCallCount} tool call(s)${toolCallNames ? ` (${toolCallNames})` : ""}.\n` +
          `Output: ${textPreview}`
        );
      })
      .join("\n\n");

    const scoringPrompt = [
      "Rate each candidate approach on 4 criteria (1-10 each):",
      "- CORRECTNESS: Will this produce the right result?",
      "- RISK: How safe is this? (10=very safe, 1=destructive)",
      "- EFFICIENCY: Does it minimize unnecessary steps?",
      "- COMPLETENESS: Does it address all parts of the task?",
      "",
      "Respond ONLY in this exact format (one line per candidate):",
      "1: correctness=8, risk=7, efficiency=6, completeness=9",
      "2: correctness=5, risk=9, efficiency=8, completeness=4",
      "",
      candidateSummaries,
    ].join("\n");

    const scoringMessages = [{ role: "user" as const, content: scoringPrompt }];

    const scoringSignal = AbortSignal.timeout(15_000);
    const scoringOptions = {
      maxTokens: 200,
      temperature: 0,
      signal: scoringSignal,
    };

    let scoreResponseText = "";
    const scoringRequestStartMilliseconds = performance.now();
    const scoringStream = streamWithRetries(
      () =>
        context.provider.generateTextStream(
          scoringMessages,
          context.resolvedModel,
          scoringOptions,
        ),
      { signal: scoringSignal, label: context.providerName },
    );

    for await (const chunk of scoringStream) {
      if (typeof chunk === "string") {
        scoreResponseText += chunk;
      }
    }

    RequestLogger.logBackgroundLlmCall({
      requestId: `${context.requestId || context.agentConversationId || "unknown"}-scoring-iter-${harness["state"].iterations}`,
      endpoint: "/agent",
      operation: "agent:scoring",
      project: context.project,
      username: context.username,
      agent: context.agent || null,
      provider: context.providerName,
      model: context.resolvedModel,
      traceId: context.traceId || null,
      agentConversationId: context.agentConversationId || null,
      aiMessages: scoringMessages as Parameters<
        typeof RequestLogger.logBackgroundLlmCall
      >[0]["aiMessages"],
      resultText: scoreResponseText,
      success: true,
      errorMessage: null,
      requestStartMilliseconds: scoringRequestStartMilliseconds,
    }).catch((scoringLogError: Error) =>
      logger.error(
        `[${logLabel}] Failed to log scoring request: ${getErrorMessage(scoringLogError)}`,
      ),
    );

    const linePattern =
      /(\d+)\s*:\s*correctness\s*=\s*(\d+(?:\.\d+)?)\s*,\s*risk\s*=\s*(\d+(?:\.\d+)?)\s*,\s*efficiency\s*=\s*(\d+(?:\.\d+)?)\s*,\s*completeness\s*=\s*(\d+(?:\.\d+)?)/gi;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = linePattern.exec(scoreResponseText)) !== null) {
      const candidateIndex = parseInt(lineMatch[1], 10) - 1;
      if (candidateIndex >= 0 && candidateIndex < branches.length) {
        const criteria: CriteriaScores = {
          correctness: Math.min(10, Math.max(0, parseFloat(lineMatch[2]))),
          risk: Math.min(10, Math.max(0, parseFloat(lineMatch[3]))),
          efficiency: Math.min(10, Math.max(0, parseFloat(lineMatch[4]))),
          completeness: Math.min(10, Math.max(0, parseFloat(lineMatch[5]))),
        };
        branches[candidateIndex].criteriaScores = criteria;
        branches[candidateIndex].score =
          criteria.correctness * 0.4 +
          criteria.risk * 0.25 +
          criteria.efficiency * 0.15 +
          criteria.completeness * 0.2;
      }
    }

    const hasMultiCriteriaScores = branches.some(
      (branch) => branch.criteriaScores.correctness > 0,
    );
    if (!hasMultiCriteriaScores) {
      const simpleScorePattern = /(\d+)\s*:\s*(\d+(?:\.\d+)?)/g;
      let simpleMatch: RegExpExecArray | null;
      while (
        (simpleMatch = simpleScorePattern.exec(scoreResponseText)) !== null
      ) {
        const candidateIndex = parseInt(simpleMatch[1], 10) - 1;
        const candidateScore = parseFloat(simpleMatch[2]);
        if (
          candidateIndex >= 0 &&
          candidateIndex < branches.length &&
          candidateScore >= 0 &&
          candidateScore <= 10
        ) {
          branches[candidateIndex].score = candidateScore;
          branches[candidateIndex].criteriaScores = {
            correctness: candidateScore,
            risk: candidateScore,
            efficiency: candidateScore,
            completeness: candidateScore,
          };
        }
      }
    }

    for (const branch of branches) {
      if (branch.score === 0) {
        branch.score = 5;
        branch.criteriaScores = {
          correctness: 5,
          risk: 5,
          efficiency: 5,
          completeness: 5,
        };
      }
    }

    logger.info(
      `[${logLabel}] Branch scores: ${branches.map((branch, index) => `${index + 1}:${branch.score.toFixed(1)}`).join(", ")}`,
    );
  } catch (scoringError: unknown) {
    logger.warn(
      `[${logLabel}] Scoring failed: ${getErrorMessage(scoringError)}. Using equal scores.`,
    );
    for (const branch of branches) {
      branch.score = 5;
      branch.criteriaScores = {
        correctness: 5,
        risk: 5,
        efficiency: 5,
        completeness: 5,
      };
    }
  }

  return branches;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Tool approval + execution + post-execution processing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function executeApprovedToolBatch(
  harness: BaseAgenticHarness,
  pass: PassState,
  currentMessages: ConversationMessage[],
  standardHooks: StandardHooks,
): Promise<{ results: ToolResult[] }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, emit } = context;
  const { hooks, approvalEngine } = standardHooks;

  // Context from a batch that was backtracked (validation failure) must not
  // leak into the next committed one.
  state.pendingHookContext = [];

  // PreToolUse BEFORE the gate, as in the ReAct loop.
  const preToolUse = await runPreToolUseStage(
    pass.pendingToolCalls,
    context,
    hooks,
    state,
  );

  const { executableToolCalls, blockedResults, shouldApproveAll } =
    await checkAndWaitForApproval(
      preToolUse.executable,
      context,
      approvalEngine,
      { toolSchemas: tools.finalTools, hooks },
    );
  if (shouldApproveAll) {
    options.autoApprove = true;
  }

  // Denied calls (rule, PreToolUse or PermissionRequest hook, the user)
  // never run; every call the gate cleared runs in one batch. Results keep
  // the model's order.
  let executedResults: ToolResult[] = [];
  if (executableToolCalls.length > 0) {
    context._currentMessages = currentMessages;

    executedResults = await executeToolBatch(
      executableToolCalls,
      context,
      tools,
      hooks,
      state,
    );
  }
  const results: ToolResult[] = orderResultsLikeCalls(pass.pendingToolCalls, [
    ...executedResults,
    ...blockedResults,
    ...preToolUse.blocked,
  ]);

  // ── Post-execution processing ─────────────────────────
  await processToolResultMedia(
    pass.pendingToolCalls,
    results,
    state,
    pass,
    emit,
    context,
  );

  trackToolErrors(
    pass.pendingToolCalls,
    results,
    state,
    MAX_CONSECUTIVE_TOOL_ERRORS,
    emit,
  );

  emitPostExecutionStatus(pass.pendingToolCalls, emit);

  await runPostToolBatchStage(context, hooks, state, pass.pendingToolCalls, results);

  return { results };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Commit a validated pass — plan-mode check, assistant
//  message construction, retry guidance, tool-set changes
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function commitToolCallResults(
  harness: BaseAgenticHarness,
  pass: PassState,
  results: ToolResult[],
  currentMessages: ConversationMessage[],
  logLabel = "Branching",
): Promise<{ planAborted: boolean; messages: ConversationMessage[] }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { options, emit } = context;

  await checkForPlanModeEntry(
    pass.pendingToolCalls,
    currentMessages,
    state,
    emit,
    options?.locale as string | undefined,
  );

  if (state.planModeActive) {
    const { planApproved } = await runPlanningPhase(
      harness,
      currentMessages,
      logLabel,
    );
    if (!planApproved) return { planAborted: true, messages: currentMessages };
  }

  const assistantMessage: ConversationMessage = {
    role: "assistant",
    content: pass.streamedText || "",
    ...(pass.streamedThinking.trim() && {
      thinking: pass.streamedThinking.trim(),
    }),
    ...(pass.thinkingSignature && {
      thinkingSignature: pass.thinkingSignature,
    }),
    ...providerNativeState(pass),
    toolCalls: pass.pendingToolCalls.map((toolCall: ToolCall) => {
      const matchingResult = results.find(
        (result) => result.id === toolCall.id,
      );
      return {
        id: toolCall.id || null,
        responsesItemId: toolCall.responsesItemId || undefined,
        name: toolCall.name,
        args: toolCall.args,
        thoughtSignature: toolCall.thoughtSignature || undefined,
        reasoningItem: toolCall.reasoningItem || undefined,
        result: matchingResult ? matchingResult.result : null,
        durationMilliseconds: matchingResult?.durationMilliseconds,
        ...approvalRecordFor(toolCall),
      };
    }),
  };
  currentMessages.push(assistantMessage);
  flushHookContext(currentMessages, state);

  const retryGuidanceMessage = buildToolRetryGuidance(
    pass.pendingToolCalls,
    results,
    state,
    MAX_CONSECUTIVE_TOOL_ERRORS,
    options?.locale as string | undefined,
  );
  if (retryGuidanceMessage) {
    currentMessages.push(retryGuidanceMessage);
  }

  // Drop empty assistant messages — but NEVER thinking-only ones.
  // Deleting a mid-history thinking message orphans its
  // "[System: …]" continuation nudge, loses the thinking signature,
  // and mutates the prompt prefix (full re-prefill, busting the
  // provider prompt cache).
  const updatedMessages = currentMessages.filter(
    (message) =>
      !(
        message.role === "assistant" &&
        !message.content?.trim() &&
        !message.thinking?.trim() &&
        (!message.toolCalls || message.toolCalls.length === 0)
      ),
  );

  injectToolDiscoveryNudge(
    pass.pendingToolCalls,
    results,
    updatedMessages,
    context,
  );

  harness.checkAndApplyToolSetChanges(updatedMessages, pass.usage);

  return { planAborted: false, messages: updatedMessages };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  No-tool-call outcome — clean break, thinking-only
//  continuation, truncation recovery, or empty output
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export function handleNoToolCallOutcome(
  harness: BaseAgenticHarness,
  pass: PassState,
  currentMessages: ConversationMessage[],
  truncationRecoveryCount: number,
  logLabel = "Branching",
): {
  action: "continue" | "break";
  truncationRecoveryCount: number;
  cleanTextBreak: boolean;
} {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, emit } = context;

  // Text present → clean text break. Thinking-only → continuation.
  if (pass.streamedText) {
    const codexResult = handleCodexPlanningResponse(
      pass,
      currentMessages,
      context,
      state,
      tools.finalTools,
      logLabel,
    );
    if (codexResult.shouldContinueLoop) {
      harness.logIteration(pass, currentMessages);
      return { action: "continue", truncationRecoveryCount, cleanTextBreak: false };
    }

    harness.logIteration(pass, currentMessages);
    return { action: "break", truncationRecoveryCount, cleanTextBreak: true };
  }

  if (!pass.streamedText && pass.streamedThinking.trim()) {
    logger.warn(
      `[${logLabel}] Thinking-only response on iteration ${state.iterations} — ` +
        `thinking=${pass.streamedThinking.length}chars, text=0. ` +
        `Injecting continuation prompt.`,
    );

    currentMessages.push({
      role: "assistant",
      content: "",
      thinking: pass.streamedThinking.trim(),
      ...(pass.thinkingSignature && {
        thinkingSignature: pass.thinkingSignature,
      }),
    ...providerNativeState(pass),
    });

    currentMessages.push({
      role: "user",
      content:
        "[System: Your previous response contained only internal reasoning " +
        "without producing any visible output. Your thinking has been preserved. " +
        "Now respond concisely with your actual answer, analysis, or tool calls. " +
        "Do not repeat your reasoning — act on it.]",
    });

    harness.logIteration(pass, currentMessages);
    return { action: "continue", truncationRecoveryCount, cleanTextBreak: false };
  }

  // ── Empty output — check for truncation recovery ─────────
  if (isOutputTruncated(pass)) {
    truncationRecoveryCount++;
    const configuredMaxTokens = context.options.maxTokens || "default";
    const modelOutputCeiling = context.modelDefinition?.maxOutputTokens as
      | number
      | undefined;
    logger.warn(
      `[${logLabel}] Max tokens truncation detected on iteration ${state.iterations} — ` +
        `Recovery attempt ${truncationRecoveryCount}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
    );

    const alreadyAtCeiling =
      typeof configuredMaxTokens === "number" &&
      isAtOutputCeiling(configuredMaxTokens, modelOutputCeiling);

    if (
      !alreadyAtCeiling &&
      truncationRecoveryCount <= MAX_OUTPUT_TRUNCATION_RECOVERIES
    ) {
      const escalatedMaxTokens = injectContinuationContext(
        currentMessages,
        pass,
        context,
        truncationRecoveryCount,
      );
      context.options.maxTokens = escalatedMaxTokens;
      harness.logIteration(pass, currentMessages);
      return { action: "continue", truncationRecoveryCount, cleanTextBreak: false };
    }

    if (alreadyAtCeiling) {
      logger.warn(
        `[${logLabel}] Skipping truncation recovery — maxTokens (${configuredMaxTokens}) ` +
          `is already at or above model ceiling (${modelOutputCeiling}). Escalation would be pointless.`,
      );
    }
    const exhaustionMessage = buildExhaustedRecoveryMessage(
      alreadyAtCeiling ? 0 : MAX_OUTPUT_TRUNCATION_RECOVERIES,
      configuredMaxTokens,
      options?.locale as string | undefined,
    );
    injectErrorAsConversationMessage(
      currentMessages,
      exhaustionMessage,
      context,
    );
    harness.logIteration(pass, currentMessages);
    return { action: "break", truncationRecoveryCount, cleanTextBreak: false };
  }

  logger.warn(
    `[${logLabel}] Empty model output on iteration ${state.iterations}. Breaking.`,
  );

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.EMPTY_OUTPUT,
    iteration: state.iterations,
  });

  harness.logIteration(pass, currentMessages);
  return { action: "break", truncationRecoveryCount, cleanTextBreak: false };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Run finalization + loop error persistence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * The strategy's pass answered without tool calls — the point the turn would
 * end. Stop hooks are awaited here; returns `true` when one blocked, after
 * recording the answer and the hook's reason so the loop can continue.
 */
export async function continueAfterStopHooks(
  harness: BaseAgenticHarness,
  pass: PassState,
  currentMessages: ConversationMessage[],
  standardHooks: StandardHooks,
): Promise<boolean> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const answer = pass.finalStreamedText || pass.streamedText || "";
  const { continueWith } = await runStopStage(
    context,
    standardHooks.hooks,
    state,
    answer,
    currentMessages,
  );
  if (!continueWith || context.signal?.aborted) return false;
  currentMessages.push({
    role: "assistant",
    content: answer,
    ...(pass.streamedThinking?.trim() && { thinking: pass.streamedThinking.trim() }),
    ...(pass.thinkingSignature && { thinkingSignature: pass.thinkingSignature }),
    ...providerNativeState(pass),
  });
  currentMessages.push(buildStopContinuationMessage(continueWith));
  return true;
}

export async function finalizeStrategyRun(
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
  standardHooks: StandardHooks,
  hasCleanTextBreak: boolean,
  logLabel: string,
  sessionSummary: string,
): Promise<void> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { signal } = context;

  // ── Exhaustion Recovery Pass ─────────────────────────────
  if (
    !hasCleanTextBreak &&
    state.streamedToolCalls.length > 0 &&
    !signal?.aborted
  ) {
    if (state.conversationOutcome === "completed") state.conversationOutcome = "exhausted";
    await runExhaustionRecoveryPass(harness, context, state, currentMessages);
  }

  logger.info(`[${logLabel}] Session complete: ${sessionSummary}`);

  cleanupReminderCache(context.agentConversationId || "");
  await harness["finalize"](currentMessages, standardHooks.hooks);
}

export async function persistLoopError(
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
  standardHooks: StandardHooks,
  loopError: unknown,
  logLabel: string,
): Promise<never> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const { options } = context;

  logger.error(
    `[${logLabel}] Loop error on iteration ${state.iterations}: ${getErrorMessage(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
  );

  // StopFailure / Error — observation only; recovery stays here. `onError`
  // was declared on AgentHooks from the start but fired nowhere before the
  // hooks feature; this is the one path every harness's throw goes through.
  await fireStopFailure(context, standardHooks.hooks, loopError);
  await standardHooks.hooks
    .run(
      "onError",
      buildHookPayload(
        HOOK_EVENTS.ERROR,
        {
          conversationId: context.conversationId,
          agentConversationId: context.agentConversationId as string,
          parentAgentConversationId: context.parentAgentConversationId as string,
          project: context.project,
          username: context.username,
          agent: context.agent,
          workspaceRoot: context.workspaceRoot,
        },
        { error_message: getErrorMessage(loopError) },
      ),
    )
    .catch(() => undefined);

  injectErrorAsConversationMessage(
    currentMessages,
    buildProviderErrorMessage(
      loopError,
      state.iterations,
      options?.locale as string | undefined,
    ),
    context,
  );

  state.conversationOutcome = "error";

  try {
    await harness["finalize"](currentMessages, standardHooks.hooks);
  } catch (persistError: unknown) {
    logger.error(
      `[${logLabel}] Failed to persist messages on error path: ${getErrorMessage(persistError)}`,
    );
  }
  throw loopError;
}
