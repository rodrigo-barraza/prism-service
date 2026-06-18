import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import logger from "../../utils/logger.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import { createStandardHooks } from "./lifecycle/HookInitializer.ts";
import { executeToolBatch } from "./lifecycle/ToolExecutor.ts";
import { checkAndWaitForApproval } from "./lifecycle/ApprovalGate.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "./lifecycle/PostExecutionEmitter.ts";
import { runExhaustionRecoveryPass } from "./lifecycle/ExhaustionRecovery.ts";
import {
  handleExitPlanMode,
  checkForPlanModeEntry,
} from "./lifecycle/PlanModeController.ts";
import { validateAfterToolExecution } from "./lifecycle/ValidationInterceptor.ts";
import { buildToolRetryGuidance } from "./lifecycle/ToolRetryInterceptor.ts";
import {
  isOutputTruncated,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  buildProviderErrorMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "./lifecycle/OutputTruncationRecovery.ts";
import { manageContextPressure } from "./lifecycle/ContextPressureManager.ts";
import { logKVCacheHitRate } from "./lifecycle/KVCacheReporter.ts";
import { injectToolDiscoveryNudge } from "./lifecycle/ToolDiscoveryNudge.ts";
import { finalizePassTracker } from "./lifecycle/TrackerFinalizer.ts";
import { handleCodexPlanningResponse } from "./lifecycle/CodexPlanningDetector.ts";

import PlanningModeService from "../PlanningModeService.ts";

import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  PassState,
  AgenticOptions,
} from "./types.ts";

interface BeforePromptHookContext {
  messages: ConversationMessage[];
  project: string;
  username: string;
  agent?: string | null;
  traceId?: string | null;
  agentSessionId: string;
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

/**
 * Structured strategy descriptors injected into branch prompts to enforce
 * genuine diversity. Each descriptor pushes the model toward a fundamentally
 * different problem-solving axis rather than cosmetic rephrasing.
 *
 * Based on the Plan Generation taxonomy (§2.1.2) from "Agent Systems with
 * Harness Engineering" — strategies should correspond to distinct trade-off
 * dimensions, not just reworded attempts at the same approach.
 */
const BRANCH_STRATEGY_DESCRIPTORS = [
  "", // Branch 0: unconstrained (model's natural first choice)
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

/**
 * TreeOfThoughtHarness — Graph-state harness with branching, multi-criteria
 * scoring, reflexion-based backtracking, and adaptive search.
 *
 * Based on the Tree of Thoughts framework (Yao et al., NeurIPS 2023) adapted
 * for agentic tool-use loops, upgraded with strategies from "Agent Systems
 * with Harness Engineering" (RUCAIBox, 2026):
 *
 *   - Reflexion-based backtracking (Shinn et al., NeurIPS 2023): on failure,
 *     the model self-critiques before retrying instead of blindly re-attempting
 *   - Multi-criteria scoring (§2.1.2): branches evaluated across correctness,
 *     risk, efficiency, and completeness — not a single holistic score
 *   - Adaptive branch count: reduces exploration breadth after iteration 1
 *     when trajectory context narrows the viable search space
 *   - Checkpoint/restore: failed branches don't pollute the conversation
 *     context — message arrays are snapshotted before execution
 *   - DFS-with-pruning mode: optional depth-first search that explores one
 *     branch deeply before backtracking, vs. the default BFS parallel evaluation
 *
 * Control flow (BFS mode — default):
 *   1. Generate N candidate reasoning branches in parallel
 *   2. Score candidates via multi-criteria self-evaluation
 *   3. Select the highest-scoring branch
 *   4. Execute tools from the selected branch
 *   5. If validation fails: reflexion self-critique → backtrack to next-best
 *   6. If text only: break → finalize
 *   7. Exhaustion recovery if iteration limit hit
 *
 * Control flow (DFS mode):
 *   1. Generate 1 candidate branch
 *   2. Execute tools immediately (no scoring needed for single branch)
 *   3. If validation fails: reflexion → checkpoint restore → generate new branch
 *      with explicit instruction to avoid the failed approach
 *   4. Repeat until success or backtrack budget exhausted
 */
export default class TreeOfThoughtHarness extends BaseAgenticHarness {
  static id = "tree_of_thought";
  static label = "Tree of Thought";
  static description =
    "Graph-state harness with parallel branching, multi-criteria scoring, reflexion backtracking, and adaptive search.";

  async run(): Promise<{ messages: ConversationMessage[] }> {
    const context = this.context;
    const state = this.state;
    const {
      options,
      agentSessionId,
      traceId,
      project,
      username,
      agent,
      workspaceRoot,
      emit,
      signal,
    } = context;

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
      agentSessionId,
      agentContext: options.agentContext,
      enabledTools: this.tools.resolvedEnabledTools,
      resolvedToolNames: this.tools.finalTools.map(
        (tool: ToolSchema) => tool.name,
      ),
      workspaceRoot: workspaceRoot || undefined,
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

    // ── Pre-loop: planning phase (planFirst or enter_plan_mode) ─────────────
    // Runs as a clean sequential loop BEFORE branching begins so the full ToT
    // search space — parallel branches, multi-criteria scoring, reflexion
    // backtracking, checkpoint/restore — is reserved for the approved implementation.
    if (state.planModeActive) {
      const { planApproved } = await this.runPlanningPhase(currentMessages);
      if (!planApproved) return { messages: currentMessages };
      // planModeActive is now false, planning instruction stripped
    }

    // ── Main loop ────────────────────────────────────────────
    try {
      while (state.iterations < resolvedMaxIterations) {
        state.iterations++;

        // ── Adaptive branch count ────────────────────────────
        // After the first iteration, reduce branch count because trajectory
        // context narrows the viable search space. In DFS mode, always 1
        // (depth-first by definition). Plan mode never reaches this point —
        // it completes as a pre-loop phase before branching begins.
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

        const passOptions: IterationPassOptions = {
          ...options,
          project,
          agent,
          username,
          tools: this.tools.finalTools,
        };

        // ── Context pressure management ──────────────────────────
        // Micro-compaction (pressure-gated) → auto-compaction → summary persistence
        const pressureResult = await manageContextPressure(
          currentMessages,
          context,
          state,
          "TreeOfThought",
        );
        currentMessages = pressureResult.messages;

        // ── Context window enforcement ─────────────────────────
        currentMessages = this.enforceContextWindow(
          currentMessages,
          this.tools.finalTools.length,
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
          this.tools.finalTools.map((tool: ToolSchema) => tool.name),
        );

        const branchResults = await Promise.all(
          Array.from({ length: adaptiveBranchCount }, (_, branchIndex) =>
            this.generateBranch(
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

        const scoredBranches = await this.scoreBranchesMultiCriteria(
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
          `[TreeOfThought] Iteration ${state.iterations}: selected branch ${selectedBranch.branchIndex + 1}/${adaptiveBranchCount} ` +
            `(score: ${selectedBranch.score.toFixed(1)}, correctness: ${selectedBranch.criteriaScores.correctness}, ` +
            `risk: ${selectedBranch.criteriaScores.risk}, efficiency: ${selectedBranch.criteriaScores.efficiency}, ` +
            `completeness: ${selectedBranch.criteriaScores.completeness})`,
        );

        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        //  PHASE 3: Execute selected branch with backtracking
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

        const selectedPass = selectedBranch.pass;

        // Finalize tracker for the selected pass
        finalizePassTracker(selectedPass, selectedPass.requestId || "");

        // Finalize/complete tracker requests for non-selected branches to prevent resource leaks and stats skewing
        for (const branch of scoredBranches) {
          if (branch !== selectedBranch && branch.pass.requestId) {
            finalizePassTracker(branch.pass, branch.pass.requestId);
          }
        }

        logKVCacheHitRate(selectedPass.usage, state.iterations, "TreeOfThought");
        this.emitGenerationProgress();

        this.emitUsageUpdate();

        // ── Tool execution from selected branch ─────────────────
        if (selectedPass.pendingToolCalls.length > 0) {
          // Snapshot messages BEFORE tool execution for checkpoint/restore
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

            results = await executeToolBatch(
              selectedPass.pendingToolCalls,
              context,
              this.tools,
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

            // Track what approach failed for future branch diversity
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

            // Determine if we should checkpoint-restore or continue with errors
            const backtrackAttemptsThisIteration = state.branchesBacktracked;
            const shouldRestoreCheckpoint =
              backtrackAttemptsThisIteration <=
                MAX_BACKTRACK_ATTEMPTS_PER_ITERATION &&
              scoredBranches.length > 1;

            if (shouldRestoreCheckpoint) {
              // Restore pre-execution message state (checkpoint/restore pattern)
              currentMessages = preExecutionSnapshot;

              emit({
                type: SERVER_SENT_EVENT_TYPES.STATUS,
                message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
                branchIndex: selectedBranch.branchIndex,
                validationErrors: validationFeedback.length,
                restoredCheckpoint: true,
              });

              logger.info(
                `[TreeOfThought] Branch ${selectedBranch.branchIndex + 1} failed validation. ` +
                  `Restored checkpoint. Injecting reflexion prompt for self-correction.`,
              );

              // ── Reflexion self-critique injection ──────────────
              // Instead of just "fix these errors", ask the model to analyze
              // WHY the approach failed before retrying (Shinn et al., 2023)
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
              // Exhausted backtrack budget — continue with errors as context
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

            this.logIteration(selectedPass, currentMessages);
            continue;
          }

          // ── No validation errors — commit this branch ──────────

          this.logIteration(selectedPass, currentMessages);

          // Clear failed approaches on success — the trajectory is viable
          failedApproachDescriptions = [];

          // ── Mid-execution plan mode entry (enter_plan_mode tool) ──────────
          // If the model calls enter_plan_mode during the implementation loop,
          // run the planning phase as a sequential sub-loop before resuming full
          // ToT branching. This preserves the same pre-loop planning semantics
          // for dynamically triggered plans as for planFirst sessions.
          checkForPlanModeEntry(
            selectedPass.pendingToolCalls,
            currentMessages,
            state,
            emit,
          );

          if (state.planModeActive) {
            const { planApproved } = await this.runPlanningPhase(currentMessages);
            if (!planApproved) return { messages: currentMessages };
            // planModeActive cleared — resume full ToT branching
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

          // ── Structured retry guidance on tool failure ──────────
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

          // ── Post-search nudge for tool discovery chain ─────────
          injectToolDiscoveryNudge(
            selectedPass.pendingToolCalls,
            results,
            currentMessages,
            context,
          );

          this.checkAndApplyToolSetChanges(currentMessages);

          continue;
        }

        // ── No tools — final text response ──────────────────────
        if (selectedPass.streamedText || selectedPass.streamedThinking.trim()) {
          // Handle Codex/planning models
          const codexResult = handleCodexPlanningResponse(
            selectedPass,
            currentMessages,
            context,
            state,
            this.tools.finalTools,
            "TreeOfThought",
          );
          if (codexResult.shouldContinueLoop) {
            this.logIteration(selectedPass, currentMessages);
            continue;
          }

          this.logIteration(selectedPass, currentMessages);
          hasCleanTextBreak = true;
          break;
        }

        // ── Empty output — check for truncation recovery ─────────
        if (isOutputTruncated(selectedPass)) {
          truncationRecoveryCount++;
          const configuredMaxTokens = context.options.maxTokens || "default";
          logger.warn(
            `[TreeOfThought] Max tokens truncation detected on iteration ${state.iterations} — ` +
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
            this.logIteration(selectedPass, currentMessages);
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
          this.logIteration(selectedPass, currentMessages);
          break;
        }

        logger.warn(
          `[TreeOfThought] Empty model output on iteration ${state.iterations}. Breaking.`,
        );
        this.logIteration(selectedPass, currentMessages);
        break;
      }

      // ── Exhaustion Recovery Pass ─────────────────────────────
      if (
        !hasCleanTextBreak &&
        state.streamedToolCalls.length > 0 &&
        !signal?.aborted
      ) {
        state.sessionOutcome = "exhausted";
        await runExhaustionRecoveryPass(this, context, state, currentMessages);
      }

      // ── Finalization (happy path) ──────────────────────────────
      logger.info(
        `[TreeOfThought] Session complete: ${state.iterations} iterations, ` +
          `${state.branchesExplored} branches explored, ` +
          `${state.branchesBacktracked} backtracked, ` +
          `strategy: ${searchStrategy}`,
      );

      await this.finalize(currentMessages, hooks);
      return { messages: currentMessages };
    } catch (loopError: unknown) {
      logger.error(
        `[TreeOfThought] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
      );

      injectErrorAsConversationMessage(
        currentMessages,
        buildProviderErrorMessage(loopError, state.iterations),
        context,
      );

      state.sessionOutcome = "error";

      try {
        await this.finalize(currentMessages, hooks);
      } catch (persistError: unknown) {
        logger.error(
          `[TreeOfThought] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
        );
      }
      throw loopError;
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  PRIVATE — Branch generation with structured diversity
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Generate a single reasoning branch with structured strategy-diversity
   * injection. Each branch after the first gets a distinct strategy
   * descriptor that pushes toward a fundamentally different problem-solving
   * axis (minimal vs thorough vs architectural vs risk-averse).
   *
   * When previous branches have failed, their approach summaries are
   * injected as negative examples so the model avoids repeating them.
   */
  private async generateBranch(
    branchIndex: number,
    totalBranches: number,
    currentMessages: ConversationMessage[],
    passOptions: IterationPassOptions,
    allowedToolNames: Set<string>,
    failedApproaches: string[],
  ): Promise<ScoredBranch> {
    const branchMessages = [...currentMessages];

    // Inject structured diversity prompt for non-primary branches
    if (branchIndex > 0 || failedApproaches.length > 0) {
      const strategyDescriptor =
        BRANCH_STRATEGY_DESCRIPTORS[
          branchIndex % BRANCH_STRATEGY_DESCRIPTORS.length
        ] || BRANCH_STRATEGY_DESCRIPTORS[1];

      let diversityInstruction =
        `[BRANCH ${branchIndex + 1}/${totalBranches}] ` + strategyDescriptor;

      // Inject failed approach avoidance when we have reflexion history
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

    const pass = this.createPassState(passOptions);
    const requestIdBase =
      this.context.requestId ||
      this.context.agentSessionId ||
      crypto.randomUUID();
    const passRequestId = `${requestIdBase}-iter-${this.state.iterations}-branch-${branchIndex}`;
    pass.requestId = passRequestId;
    this.registerTrackerRequest(passRequestId);

    const stream = this.createProviderStream(branchMessages, passOptions);
    await this.consumeStream(stream, pass, allowedToolNames);

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
  //  PRIVATE — Pre-loop planning phase
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Execute the planning phase as a sequential pre-loop before branching begins.
   *
   * Runs a restricted single-branch loop with only exit_plan_mode available.
   * The model writes its plan as text, then calls exit_plan_mode to submit it
   * for user approval. On approval, state.planModeActive is cleared and
   * currentMessages carries the full planning context so the main ToT branching
   * loop starts immediately with the complete tool set and full branch count.
   *
   * Returns { planApproved: false } on user rejection, signal abort, or planning
   * iteration budget exhaustion — the caller should return early without entering
   * the branching loop. Returns { planApproved: true } when the plan is approved.
   */
  private async runPlanningPhase(
    currentMessages: ConversationMessage[],
  ): Promise<{ planApproved: boolean }> {
    const context = this.context;
    const state = this.state;
    const { options, project, agent, username, signal } = context;

    const MAX_PLANNING_ITERATIONS = 10;

    PlanningModeService.injectPlanningInstruction(currentMessages);

    const planModeTools = this.tools.finalTools.filter(
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
      `[TreeOfThought] Planning phase started — model will plan before full ToT branching.`,
    );

    let planningIteration = 0;
    while (planningIteration < MAX_PLANNING_ITERATIONS) {
      planningIteration++;

      if (signal?.aborted) return { planApproved: false };

      const pass = this.createPassState(planPassOptions);
      const requestIdBase =
        context.requestId || context.agentSessionId || crypto.randomUUID();
      const passRequestId = `${requestIdBase}-plan-${planningIteration}`;
      pass.requestId = passRequestId;
      this.registerTrackerRequest(passRequestId);

      const stream = this.createProviderStream(currentMessages, planPassOptions);
      await this.consumeStream(stream, pass, allowedPlanToolNames);

      finalizePassTracker(pass, passRequestId);
      this.emitGenerationProgress();
      this.emitUsageUpdate();

      if (signal?.aborted) return { planApproved: false };

      // ── exit_plan_mode: emit proposal and wait for approval ────────
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

        // Commit the approved planning turn so the main branching loop
        // sees the approved plan as conversation context.
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
          `[TreeOfThought] Plan approved — entering full branching loop with ${this.tools.finalTools.length} tool(s).`,
        );
        return { planApproved: true };
      }

      // ── Unauthorized tool calls — block and redirect ───────────────
      const unauthorizedCalls = pass.pendingToolCalls.filter(
        (toolCall) => toolCall.name !== TOOL_NAMES.EXIT_PLAN_MODE,
      );
      if (unauthorizedCalls.length > 0) {
        const blockedNames = unauthorizedCalls
          .map((toolCall) => toolCall.name)
          .join(", ");
        logger.warn(
          `[TreeOfThought] Planning phase: blocked ${unauthorizedCalls.length} unauthorized tool call(s): [${blockedNames}]`,
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

      // ── Text-only response — model is still composing its plan ─────
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

      // ── Empty output — bail out ─────────────────────────────────────
      logger.warn(
        `[TreeOfThought] Planning phase iteration ${planningIteration}: empty output. Aborting planning phase.`,
      );
      return { planApproved: false };
    }

    logger.warn(
      `[TreeOfThought] Planning phase exhausted ${MAX_PLANNING_ITERATIONS} iterations without exit_plan_mode call.`,
    );
    return { planApproved: false };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  PRIVATE — Multi-criteria scoring (§2.1.2)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Score branches using multi-criteria self-evaluation via a single LLM call.
   *
   * Instead of a single holistic score, the model evaluates each candidate
   * across four dimensions from the paper's Task Planning taxonomy (§2.1.2):
   *
   *   - Correctness: will this approach produce the right result?
   *   - Risk: how likely is this to break existing functionality?
   *   - Efficiency: does this minimize unnecessary steps/tokens?
   *   - Completeness: does this address all parts of the task?
   *
   * The final score is a weighted composite: correctness (0.4) + risk (0.25)
   * + efficiency (0.15) + completeness (0.2).
   */
  private async scoreBranchesMultiCriteria(
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
      const scoringStream = this.context.provider.generateTextStream(
        scoringMessages,
        this.context.resolvedModel,
        scoringOptions,
      );

      for await (const chunk of scoringStream) {
        if (typeof chunk === "string") {
          scoreResponseText += chunk;
        }
      }

      // Parse multi-criteria scores
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
          // Weighted composite: correctness (0.4) + risk (0.25) + efficiency (0.15) + completeness (0.2)
          branches[candidateIndex].score =
            criteria.correctness * 0.4 +
            criteria.risk * 0.25 +
            criteria.efficiency * 0.15 +
            criteria.completeness * 0.2;
        }
      }

      // Fallback: try simple "N:score" format if multi-criteria parsing failed
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

      // Ensure all branches have a score (default to 5 if parsing missed them)
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
        `[TreeOfThought] Branch scores: ${branches.map((branch, index) => `${index + 1}:${branch.score.toFixed(1)}`).join(", ")}`,
      );
    } catch (scoringError: unknown) {
      logger.warn(
        `[TreeOfThought] Scoring failed: ${getErrorMessage(scoringError)}. Using equal scores.`,
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
}
