import type BaseAgenticHarness from "../BaseAgenticHarness.ts";
import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  AgenticOptions,
  PassState,
} from "../types.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../utils/logger.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";
import RequestLogger from "../../RequestLogger.ts";
import { createStandardHooks } from "../lifecycle/HookInitializer.ts";
import { executeToolBatch } from "../lifecycle/ToolExecutor.ts";
import { checkAndWaitForApproval } from "../lifecycle/ApprovalGate.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "../lifecycle/PostExecutionEmitter.ts";
import { runExhaustionRecoveryPass } from "../lifecycle/ExhaustionRecovery.ts";
import {
  handleExitPlanMode,
  checkForPlanModeEntry,
} from "../lifecycle/PlanModeController.ts";
import { validateAfterToolExecution } from "../lifecycle/ValidationInterceptor.ts";
import { buildToolRetryGuidance } from "../lifecycle/ToolRetryInterceptor.ts";
import {
  isOutputTruncated,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  buildProviderErrorMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "../lifecycle/OutputTruncationRecovery.ts";
import { manageContextPressure } from "../lifecycle/ContextPressureManager.ts";
import { logKVCacheHitRate } from "../lifecycle/KVCacheReporter.ts";
import { injectToolDiscoveryNudge } from "../lifecycle/ToolDiscoveryNudge.ts";
import { finalizePassTracker } from "../lifecycle/TrackerFinalizer.ts";
import { handleCodexPlanningResponse } from "../lifecycle/CodexPlanningDetector.ts";
import { maybeInjectSystemReminder, cleanupReminderCache } from "../lifecycle/SystemReminderInjector.ts";
import { checkCostBudget } from "../lifecycle/CostBudgetEnforcer.ts";
import { createSandboxCheckpoint, restoreSandboxCheckpoint } from "../lifecycle/SandboxExecutor.ts";
import PlanningModeService from "../../PlanningModeService.ts";

interface BeforePromptHookContext {
  messages: ConversationMessage[];
  project: string;
  username: string;
  agent?: string | null;
  traceId?: string | null;
  agentConversationId: string;
  agentContext?: unknown;
  enabledTools: string[] | null;
  resolvedToolNames: string[];
  workspaceRoot?: string;
  _injectedSkills?: string[];
  [key: string]: unknown;
}

interface IterationPassOptions extends AgenticOptions {
  project: string;
  agent?: string | null;
  username: string;
}

const MAX_TOOL_ITERATIONS = 25;
const MAX_CONSECUTIVE_TOOL_ERRORS = 3;
const DEFAULT_BRANCH_COUNT = 3;
const MAX_BACKTRACK_ATTEMPTS_PER_ITERATION = 2;

interface ScoredBranch {
  branchIndex: number;
  text: string;
  thinking: string;
  thinkingSignature: string;
  score: number;
  criteriaScores: CriteriaScores;
  pass: PassState;
}

interface CriteriaScores {
  correctness: number;
  risk: number;
  efficiency: number;
  completeness: number;
}

type SearchStrategy = "bfs" | "dfs";

const BRANCH_STRATEGY_DESCRIPTORS = [
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
//  Public API — called by ReActHarness when reasoningStrategy === "tree_of_thoughts"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function runTreeOfThoughts(
  harness: BaseAgenticHarness,
): Promise<{ messages: ConversationMessage[] }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const {
    options,
    agentConversationId,
    traceId,
    project,
    username,
    agent,
    workspaceRoot,
    emit,
    signal,
  } = context;

  const resolvedAgentConversationId = agentConversationId || "";

  const searchStrategy: SearchStrategy =
    (options.searchStrategy as SearchStrategy) || "bfs";
  const initialBranchCount = Math.min(
    Math.max(1, options.branchCount || DEFAULT_BRANCH_COUNT),
    5,
  );

  const clientMaxIterations = options.maxIterations;
  const resolvedMaxIterations =
    clientMaxIterations === 0
      ? Infinity
      : clientMaxIterations
        ? Math.min(100, Math.max(1, clientMaxIterations))
        : MAX_TOOL_ITERATIONS;

  let currentMessages: ConversationMessage[] = [...context.messages];
  let truncationRecoveryCount = 0;
  let hasCleanTextBreak = false;
  let failedApproachDescriptions: string[] = [];

  const { hooks, approvalEngine } = createStandardHooks({
    workspaceRoot: workspaceRoot || undefined,
    autoApprove: options.autoApprove === true,
    policies: options.policies,
    enableCriticGate: options.enableCriticGate === true,
    criticModel: options.criticModel || undefined,
  });

  if (options.planFirst) {
    emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.PLAN_MODE_ENTERED,
    });
  }

  // ── beforePrompt hook (once) ──────────────────────────
  const hookContext: BeforePromptHookContext = {
    messages: currentMessages,
    project,
    username,
    agent,
    traceId,
    agentConversationId: resolvedAgentConversationId,
    agentContext: options.agentContext,
    enabledTools: tools.resolvedEnabledTools,
    resolvedToolNames: tools.finalTools.map(
      (tool: ToolSchema) => tool.name,
    ),
    workspaceRoot: workspaceRoot || undefined,
    workspaceEnabled: options.workspaceEnabled as boolean | undefined,
  };
  await hooks.run("beforePrompt", hookContext);

  const assembledSystemMessage =
    currentMessages.find(
      (message) =>
        message.role === "system" && message._isIdentityPrompt === true,
    ) || currentMessages.find((message) => message.role === "system");
  if (assembledSystemMessage?.content) {
    context.conversationMeta = {
      ...(context.conversationMeta || {}),
      systemPrompt: assembledSystemMessage.content,
    };
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

  // ── Pre-loop planning phase ─────────────────────────────
  if (state.planModeActive) {
    const { planApproved } = await runPlanningPhase(harness, currentMessages);
    if (!planApproved) return { messages: currentMessages };
  }

  // ── Main loop ────────────────────────────────────────────
  try {
    while (state.iterations < resolvedMaxIterations) {
      state.iterations++;

      const adaptiveBranchCount =
        searchStrategy === "dfs"
          ? 1
          : state.iterations === 1
            ? initialBranchCount
            : Math.max(1, Math.ceil(initialBranchCount * 0.6));

      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.ITERATION_PROGRESS,
        iteration: state.iterations,
        maxIterations: resolvedMaxIterations,
        harness: "tree_of_thought",
        searchStrategy,
        branchCount: adaptiveBranchCount,
      });

      // ── Instruction fade-out countermeasure ─────────────────
      await maybeInjectSystemReminder(
        currentMessages,
        state,
        context,
      );

      const passOptions: IterationPassOptions = {
        ...options,
        project,
        agent,
        username,
        tools: tools.finalTools,
      };

      // ── Context pressure management ──────────────────────────
      const pressureResult = await manageContextPressure(
        currentMessages,
        context,
        state,
        "TreeOfThoughts",
      );
      currentMessages = pressureResult.messages;

      // ── Context window enforcement ─────────────────────────
      currentMessages = harness.enforceContextWindow(
        currentMessages,
        tools.finalTools.length,
      );

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 1: Generate candidate branches
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.BRANCHING_STARTED,
        branchCount: adaptiveBranchCount,
        iteration: state.iterations,
        searchStrategy,
      });

      const allowedToolNames = new Set(
        tools.finalTools.map((tool: ToolSchema) => tool.name),
      );

      const branchResults = await Promise.all(
        Array.from({ length: adaptiveBranchCount }, (_, branchIndex) =>
          generateBranch(
            harness,
            branchIndex,
            adaptiveBranchCount,
            currentMessages,
            passOptions,
            allowedToolNames,
            failedApproachDescriptions,
          ),
        ),
      );

      if (signal?.aborted) break;

      state.branchesExplored += adaptiveBranchCount;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 2: Multi-criteria score and rank branches
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      const scoredBranches = await scoreBranchesMultiCriteria(
        harness,
        branchResults,
        currentMessages,
      );

      scoredBranches.sort(
        (branchA, branchB) => branchB.score - branchA.score,
      );

      const selectedBranch = scoredBranches[0];
      state.selectedBranchScores.push(selectedBranch.score);

      state.finalStreamedText = selectedBranch.pass.finalStreamedText;
      state.streamedThinking = selectedBranch.pass.streamedThinking;

      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.BRANCH_SELECTED,
        branchIndex: selectedBranch.branchIndex,
        score: selectedBranch.score,
        branchCount: adaptiveBranchCount,
        criteriaScores: selectedBranch.criteriaScores,
        scores: scoredBranches.map((branch) => ({
          index: branch.branchIndex,
          score: branch.score,
          criteria: branch.criteriaScores,
        })),
      });

      logger.info(
        `[TreeOfThoughts] Iteration ${state.iterations}: selected branch ${selectedBranch.branchIndex + 1}/${adaptiveBranchCount} ` +
          `(score: ${selectedBranch.score.toFixed(1)}, correctness: ${selectedBranch.criteriaScores.correctness}, ` +
          `risk: ${selectedBranch.criteriaScores.risk}, efficiency: ${selectedBranch.criteriaScores.efficiency}, ` +
          `completeness: ${selectedBranch.criteriaScores.completeness})`,
      );

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 3: Execute selected branch with backtracking
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      const selectedPass = selectedBranch.pass;

      finalizePassTracker(selectedPass, selectedPass.requestId || "");

      for (const branch of scoredBranches) {
        if (branch !== selectedBranch && branch.pass.requestId) {
          finalizePassTracker(branch.pass, branch.pass.requestId);
          harness.logIteration(branch.pass, currentMessages);
        }
      }

      logKVCacheHitRate(selectedPass.usage, state.iterations, "TreeOfThoughts");
      harness.emitGenerationProgress();

      harness.emitUsageUpdate();

      // ── Cost budget enforcement ────────────────────────────
      if (checkCostBudget(state, context.resolvedModel, options.maxCostDollars, emit)) {
        break;
      }

      // ── Tool execution from selected branch ─────────────────
      if (selectedPass.pendingToolCalls.length > 0) {
        const preExecutionSnapshot = currentMessages.map((message) => ({
          ...message,
        }));

        const { isApproved, shouldApproveAll } =
          await checkAndWaitForApproval(
            selectedPass.pendingToolCalls,
            context,
            approvalEngine,
          );

        let results: ToolResult[] = [];
        let sandboxCheckpointReference: string | null = null;
        if (!isApproved) {
          results = selectedPass.pendingToolCalls.map((toolCall) => ({
            name: toolCall.name,
            id: toolCall.id,
            result: {
              success: false,
              error: "USER_REJECTED",
              message: "Tool execution was manually rejected by the user.",
            },
          }));
        } else {
          if (shouldApproveAll) {
            options.autoApprove = true;
          }

          context._currentMessages = currentMessages;

          // ── Sandbox checkpoint (git-based rollback) ────────────
          sandboxCheckpointReference = options.enableSandbox
            ? createSandboxCheckpoint(workspaceRoot, emit)
            : null;

          results = await executeToolBatch(
            selectedPass.pendingToolCalls,
            context,
            tools,
            hooks,
            state,
          );
        }

        // ── Post-execution processing ─────────────────────────
        await processToolResultMedia(
          selectedPass.pendingToolCalls,
          results,
          state,
          selectedPass,
          emit,
          context,
        );

        trackToolErrors(
          selectedPass.pendingToolCalls,
          results,
          state,
          MAX_CONSECUTIVE_TOOL_ERRORS,
          emit,
        );

        emitPostExecutionStatus(selectedPass.pendingToolCalls, emit);

        // ── Validation + reflexion-based backtracking ──────────
        const validationFeedback = await validateAfterToolExecution(
          selectedPass.pendingToolCalls,
          results,
          context,
          state,
        );

        if (validationFeedback.length > 0) {
          state.branchesBacktracked++;

          const errorBlock = validationFeedback
            .map(
              (feedback) =>
                `### ${feedback.filePath} (${feedback.validatorType})\n${feedback.rawOutput}`,
            )
            .join("\n\n");

          const failedApproachSummary = (
            selectedPass.streamedText ||
            selectedPass.streamedThinking ||
            ""
          )
            .slice(0, 300)
            .trim();
          if (failedApproachSummary) {
            failedApproachDescriptions.push(failedApproachSummary);
          }

          const backtrackAttemptsThisIteration = state.branchesBacktracked;
          const shouldRestoreCheckpoint =
            backtrackAttemptsThisIteration <=
              MAX_BACKTRACK_ATTEMPTS_PER_ITERATION &&
            scoredBranches.length > 1;

          if (shouldRestoreCheckpoint) {
            currentMessages = preExecutionSnapshot;

            // Restore filesystem to pre-execution state alongside conversation
            if (sandboxCheckpointReference) {
              restoreSandboxCheckpoint(workspaceRoot, sandboxCheckpointReference, emit);
            }

            emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
              branchIndex: selectedBranch.branchIndex,
              validationErrors: validationFeedback.length,
              restoredCheckpoint: true,
            });

            logger.info(
              `[TreeOfThoughts] Branch ${selectedBranch.branchIndex + 1} failed validation. ` +
                `Restored checkpoint. Injecting reflexion prompt for self-correction.`,
            );

            currentMessages.push({
              role: "system",
              content:
                `[REFLEXION — BRANCH ${selectedBranch.branchIndex + 1} FAILED VALIDATION]\n\n` +
                `The previous approach produced ${validationFeedback.length} validation error(s):\n\n` +
                `${errorBlock}\n\n` +
                `Before retrying, ANALYZE what went wrong:\n` +
                `1. What assumption in the previous approach caused the failure?\n` +
                `2. What is fundamentally different about a correct solution?\n` +
                `3. What specific alternative strategy would avoid this class of error?\n\n` +
                `Apply your analysis and take a DIFFERENT approach on the next attempt.`,
            });
          } else {
            emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
              branchIndex: selectedBranch.branchIndex,
              validationErrors: validationFeedback.length,
              restoredCheckpoint: false,
            });

            currentMessages.push({
              role: "assistant",
              content: selectedPass.streamedText || "",
              ...(selectedPass.streamedThinking.trim() && {
                thinking: selectedPass.streamedThinking.trim(),
              }),
              toolCalls: selectedPass.pendingToolCalls.map(
                (toolCall: ToolCall) => {
                  const matchingResult = results.find(
                    (result) => result.id === toolCall.id,
                  );
                  return {
                    id: toolCall.id || null,
                    name: toolCall.name,
                    args: toolCall.args,
                    result: matchingResult ? matchingResult.result : null,
                    durationMs: matchingResult?.durationMs,
                  };
                },
              ),
            });

            currentMessages.push({
              role: "system",
              content:
                `[VALIDATION ERROR — BACKTRACK BUDGET EXHAUSTED]\n\n` +
                `${errorBlock}\n\n` +
                `Multiple approaches have failed. Fix the remaining issues directly.`,
            });
          }

          harness.logIteration(selectedPass, currentMessages);
          continue;
        }

        // ── No validation errors — commit this branch ──────────

        harness.logIteration(selectedPass, currentMessages);

        failedApproachDescriptions = [];

        checkForPlanModeEntry(
          selectedPass.pendingToolCalls,
          currentMessages,
          state,
          emit,
        );

        if (state.planModeActive) {
          const { planApproved } = await runPlanningPhase(harness, currentMessages);
          if (!planApproved) return { messages: currentMessages };
        }

        const assistantMessage: ConversationMessage = {
          role: "assistant",
          content: selectedPass.streamedText || "",
          ...(selectedPass.streamedThinking.trim() && {
            thinking: selectedPass.streamedThinking.trim(),
          }),
          ...(selectedPass.thinkingSignature && {
            thinkingSignature: selectedPass.thinkingSignature,
          }),
          toolCalls: selectedPass.pendingToolCalls.map(
            (toolCall: ToolCall) => {
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
                durationMs: matchingResult?.durationMs,
              };
            },
          ),
        };
        currentMessages.push(assistantMessage);

        const retryGuidanceMessage = buildToolRetryGuidance(
          selectedPass.pendingToolCalls,
          results,
          state,
          MAX_CONSECUTIVE_TOOL_ERRORS,
        );
        if (retryGuidanceMessage) {
          currentMessages.push(retryGuidanceMessage);
        }

        currentMessages = currentMessages.filter(
          (message) =>
            !(
              message.role === "assistant" &&
              !message.content?.trim() &&
              (!message.toolCalls || message.toolCalls.length === 0)
            ),
        );

        injectToolDiscoveryNudge(
          selectedPass.pendingToolCalls,
          results,
          currentMessages,
          context,
        );

        harness.checkAndApplyToolSetChanges(currentMessages);

        continue;
      }

      // ── No tools — final text response ──────────────────────
      if (selectedPass.streamedText || selectedPass.streamedThinking.trim()) {
        const codexResult = handleCodexPlanningResponse(
          selectedPass,
          currentMessages,
          context,
          state,
          tools.finalTools,
          "TreeOfThoughts",
        );
        if (codexResult.shouldContinueLoop) {
          harness.logIteration(selectedPass, currentMessages);
          continue;
        }

        harness.logIteration(selectedPass, currentMessages);
        hasCleanTextBreak = true;
        break;
      }

      // ── Empty output — check for truncation recovery ─────────
      if (isOutputTruncated(selectedPass)) {
        truncationRecoveryCount++;
        const configuredMaxTokens = context.options.maxTokens || "default";
        logger.warn(
          `[TreeOfThoughts] Max tokens truncation detected on iteration ${state.iterations} — ` +
            `Recovery attempt ${truncationRecoveryCount}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
        );

        if (truncationRecoveryCount <= MAX_OUTPUT_TRUNCATION_RECOVERIES) {
          const escalatedMaxTokens = injectContinuationContext(
            currentMessages,
            selectedPass,
            context,
            truncationRecoveryCount,
          );
          context.options.maxTokens = escalatedMaxTokens;
          harness.logIteration(selectedPass, currentMessages);
          continue;
        }

        const exhaustionMessage = buildExhaustedRecoveryMessage(
          MAX_OUTPUT_TRUNCATION_RECOVERIES,
          configuredMaxTokens,
        );
        injectErrorAsConversationMessage(
          currentMessages,
          exhaustionMessage,
          context,
        );
        harness.logIteration(selectedPass, currentMessages);
        break;
      }

      logger.warn(
        `[TreeOfThoughts] Empty model output on iteration ${state.iterations}. Breaking.`,
      );
      harness.logIteration(selectedPass, currentMessages);
      break;
    }

    // ── Exhaustion Recovery Pass ─────────────────────────────
    if (
      !hasCleanTextBreak &&
      state.streamedToolCalls.length > 0 &&
      !signal?.aborted
    ) {
      state.conversationOutcome = "exhausted";
      await runExhaustionRecoveryPass(harness, context, state, currentMessages);
    }

    // ── Finalization ──────────────────────────────────────────
    logger.info(
      `[TreeOfThoughts] Session complete: ${state.iterations} iterations, ` +
        `${state.branchesExplored} branches explored, ` +
        `${state.branchesBacktracked} backtracked, ` +
        `strategy: ${searchStrategy}`,
    );

    cleanupReminderCache(resolvedAgentConversationId);
    await harness["finalize"](currentMessages, hooks);
    return { messages: currentMessages };
  } catch (loopError: unknown) {
    logger.error(
      `[TreeOfThoughts] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
    );

    injectErrorAsConversationMessage(
      currentMessages,
      buildProviderErrorMessage(loopError, state.iterations),
      context,
    );

    state.conversationOutcome = "error";

    try {
      await harness["finalize"](currentMessages, hooks);
    } catch (persistError: unknown) {
      logger.error(
        `[TreeOfThoughts] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
      );
    }
    throw loopError;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Branch generation with structured diversity
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function generateBranch(
  harness: BaseAgenticHarness,
  branchIndex: number,
  totalBranches: number,
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
  failedApproaches: string[],
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
    context.requestId ||
    resolvedAgentConversationId ||
    crypto.randomUUID();
  const passRequestId = `${requestIdBase}-iter-${state.iterations}-branch-${branchIndex}`;
  pass.requestId = passRequestId;
  harness.registerTrackerRequest(passRequestId);

  const stream = harness.createProviderStream(branchMessages, passOptions);
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

async function runPlanningPhase(
  harness: BaseAgenticHarness,
  currentMessages: ConversationMessage[],
): Promise<{ planApproved: boolean }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, project, agent, username, signal } = context;

  const MAX_PLANNING_ITERATIONS = 10;

  PlanningModeService.injectPlanningInstruction(currentMessages);

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
    `[TreeOfThoughts] Planning phase started — model will plan before full branching.`,
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

    const stream = harness.createProviderStream(currentMessages, planPassOptions);
    await harness.consumeStream(stream, pass, allowedPlanToolNames);

    finalizePassTracker(pass, passRequestId);
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

      if (!shouldContinueLoop) return { planApproved: false };

      currentMessages.push({
        role: "assistant",
        content: pass.streamedText || "",
        ...(pass.streamedThinking.trim() && {
          thinking: pass.streamedThinking.trim(),
        }),
        ...(pass.thinkingSignature && {
          thinkingSignature: pass.thinkingSignature,
        }),
        toolCalls: [
          {
            id: exitPlanToolCall.id || null,
            name: exitPlanToolCall.name,
            args: exitPlanToolCall.args,
            result: results[0].result,
          },
        ],
      });

      logger.info(
        `[TreeOfThoughts] Plan approved — entering full branching loop with ${tools.finalTools.length} tool(s).`,
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
        `[TreeOfThoughts] Planning phase: blocked ${unauthorizedCalls.length} unauthorized tool call(s): [${blockedNames}]`,
      );
      if (pass.streamedText) {
        currentMessages.push({
          role: "assistant",
          content: pass.streamedText,
          ...(pass.streamedThinking.trim() && {
            thinking: pass.streamedThinking.trim(),
          }),
          ...(pass.thinkingSignature && {
            thinkingSignature: pass.thinkingSignature,
          }),
        });
      }
      currentMessages.push({
        role: "system",
        content:
          `You are in PLANNING MODE. Tool call(s) [${blockedNames}] were blocked — ` +
          `only exit_plan_mode is available. Write your complete plan as text output, ` +
          `then call exit_plan_mode to submit it for user approval.`,
      });
      continue;
    }

    if (pass.streamedText || pass.streamedThinking.trim()) {
      currentMessages.push({
        role: "assistant",
        content: pass.streamedText,
        ...(pass.streamedThinking.trim() && {
          thinking: pass.streamedThinking.trim(),
        }),
        ...(pass.thinkingSignature && {
          thinkingSignature: pass.thinkingSignature,
        }),
      });
      continue;
    }

    logger.warn(
      `[TreeOfThoughts] Planning phase iteration ${planningIteration}: empty output. Aborting planning phase.`,
    );
    return { planApproved: false };
  }

  logger.warn(
    `[TreeOfThoughts] Planning phase exhausted ${MAX_PLANNING_ITERATIONS} iterations without exit_plan_mode call.`,
  );
  return { planApproved: false };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Multi-criteria scoring (§2.1.2)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function scoreBranchesMultiCriteria(
  harness: BaseAgenticHarness,
  branches: ScoredBranch[],
  _currentMessages: ConversationMessage[],
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

    const scoringMessages = [
      { role: "user" as const, content: scoringPrompt },
    ];

    const scoringOptions = {
      maxTokens: 200,
      temperature: 0,
      signal: AbortSignal.timeout(15_000),
    };

    let scoreResponseText = "";
    const scoringRequestStartMs = performance.now();
    const scoringStream = context.provider.generateTextStream(
      scoringMessages,
      context.resolvedModel,
      scoringOptions,
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
      aiMessages: scoringMessages as Parameters<typeof RequestLogger.logBackgroundLlmCall>[0]["aiMessages"],
      resultText: scoreResponseText,
      success: true,
      errorMessage: null,
      requestStartMs: scoringRequestStartMs,
    }).catch((scoringLogError: unknown) =>
      logger.error(
        `[TreeOfThoughts] Failed to log scoring request: ${getErrorMessage(scoringLogError)}`,
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
      `[TreeOfThoughts] Branch scores: ${branches.map((branch, index) => `${index + 1}:${branch.score.toFixed(1)}`).join(", ")}`,
    );
  } catch (scoringError: unknown) {
    logger.warn(
      `[TreeOfThoughts] Scoring failed: ${getErrorMessage(scoringError)}. Using equal scores.`,
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
