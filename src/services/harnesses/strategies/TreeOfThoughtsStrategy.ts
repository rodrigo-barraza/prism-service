/**
 * Tree of Thoughts (ToT) Thought Structure
 *
 * Paper: "Tree of Thoughts: Deliberate Problem Solving
 * with Large Language Models" (arxiv.org/abs/2305.10601)
 *
 * Two search strategies, both with value-threshold pruning:
 *
 *   BFS (Algorithm 1): Generate N branches in parallel, score,
 *   retain top-b as frontier. Execute the best; on validation
 *   failure, fall back to the next frontier candidate before
 *   re-branching.
 *
 *   Note on BFS Frontier Fallback: BFS frontier fallback (switching to the next-best
 *   pre-scored candidate upon validation failure) requires sandbox execution to be active
 *   (options.enableSandbox === true) to safely roll back any file changes from the failed branch
 *   before executing the next sibling. Without a sandbox, frontier fallback is bypassed to avoid
 *   running siblings on a dirty filesystem.
 *
 *   DFS (Algorithm 2): Explore siblings sequentially — generate
 *   one branch, score it, accept if above threshold. If below,
 *   try the next sibling. Accept best available after exhausting
 *   the sibling budget.
 *
 * Proactive backtracking: If all branches score below the value
 * threshold (default 5.0), the iteration is discarded and a
 * reflexion prompt is injected before re-branching — matching
 * the paper's state evaluator V(s) pruning.
 *
 * Shared branching machinery (branch generation, scoring, planning
 * phase, tool execution, commit, no-tool outcomes) lives in
 * branchingCommon.ts — this file holds only the ToT search logic.
 *
 * See ThoughtStructureRegistry.ts → THOUGHT_STRUCTURE_DEFINITIONS
 * (id: "tree_of_thoughts") for full paper-alignment metadata.
 */
import type BaseAgenticHarness from "#src/services/harnesses/BaseAgenticHarness";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
} from "#src/services/harnesses/types";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  MAX_TOOL_ITERATIONS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import { validateAfterToolExecution } from "#src/services/harnesses/lifecycle/ValidationInterceptor";
import { manageContextPressure } from "#src/services/harnesses/lifecycle/ContextPressureManager";
import { logKVCacheHitRate } from "#src/services/harnesses/lifecycle/KVCacheReporter";
import { finalizePassTracker } from "#src/services/harnesses/lifecycle/TrackerFinalizer";
import { maybeInjectSystemReminder } from "#src/services/harnesses/lifecycle/SystemReminderInjector";
import { checkCostBudget } from "#src/services/harnesses/lifecycle/CostBudgetEnforcer";
import { restoreSandboxCheckpoint } from "#src/services/harnesses/lifecycle/SandboxExecutor";
import { HARNESS } from "#src/constants";
import type {
  IterationPassOptions,
  ScoredBranch,
} from "#src/services/harnesses/strategies/branchingCommon";
import {
  runBeforePromptSetup,
  runPlanningPhase,
  generateBranch,
  scoreBranchesMultiCriteria,
  executeApprovedToolBatch,
  commitToolCallResults,
  handleNoToolCallOutcome,
  finalizeStrategyRun,
  persistLoopError,
} from "#src/services/harnesses/strategies/branchingCommon";

const {
  DEFAULT_BRANCH_COUNT,
  MAX_BACKTRACK_ATTEMPTS_PER_ITERATION,
  DEFAULT_VALUE_THRESHOLD,
  MAX_PROACTIVE_BACKTRACKS,
  DEFAULT_BFS_BEAM_WIDTH,
} = HARNESS;

const LOG_LABEL = "TreeOfThoughts";

type SearchStrategy = "bfs" | "dfs";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Public API — called by ReActHarness when thoughtStructure === "tree_of_thoughts"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function runTreeOfThoughts(
  harness: BaseAgenticHarness,
): Promise<{ messages: ConversationMessage[] }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, project, username, agent, workspaceRoot, emit, signal } =
    context;

  const searchStrategy: SearchStrategy =
    (options.searchStrategy as SearchStrategy) || "bfs";
  const initialBranchCount = Math.min(
    Math.max(1, options.branchCount || DEFAULT_BRANCH_COUNT),
    5,
  );
  const valueThreshold = options.valueThreshold ?? DEFAULT_VALUE_THRESHOLD;
  const bfsBeamWidth = Math.min(DEFAULT_BFS_BEAM_WIDTH, initialBranchCount);

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

  const standardHooks = await runBeforePromptSetup(harness, currentMessages);

  // ── Pre-loop planning phase ─────────────────────────────
  if (state.planModeActive) {
    const { planApproved } = await runPlanningPhase(
      harness,
      currentMessages,
      LOG_LABEL,
    );
    if (!planApproved) return { messages: currentMessages };
  }

  // ── Main loop ────────────────────────────────────────────
  try {
    while (state.iterations < resolvedMaxIterations) {
      state.iterations++;

      const adaptiveBranchCount =
        searchStrategy === "dfs"
          ? initialBranchCount
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
      await maybeInjectSystemReminder(currentMessages, state, context);

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

      const allowedToolNames = new Set(
        tools.finalTools.map((tool: ToolSchema) => tool.name),
      );

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 1+2: Generate, score, and select — strategy-aware
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      let scoredBranches: ScoredBranch[];
      let selectedBranch: ScoredBranch;

      if (searchStrategy === "dfs") {
        // ── True DFS: sequential sibling exploration (Paper Algorithm 2) ──
        // Generate one branch at a time, score it, accept if above
        // threshold. Try up to `initialBranchCount` siblings before
        // accepting the best available.
        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.BRANCHING_STARTED,
          branchCount: adaptiveBranchCount,
          iteration: state.iterations,
          searchStrategy,
        });

        let acceptedBranch: ScoredBranch | null = null;
        const exploredSiblings: ScoredBranch[] = [];

        for (
          let siblingAttempt = 0;
          siblingAttempt < adaptiveBranchCount;
          siblingAttempt++
        ) {
          if (signal?.aborted) break;

          const branch = await generateBranch(
            harness,
            siblingAttempt,
            adaptiveBranchCount,
            currentMessages,
            passOptions,
            allowedToolNames,
            failedApproachDescriptions,
            LOG_LABEL,
          );
          state.branchesExplored++;

          const [scoredSibling] = await scoreBranchesMultiCriteria(
            harness,
            [branch],
            LOG_LABEL,
          );
          exploredSiblings.push(scoredSibling);

          if (scoredSibling.score >= valueThreshold) {
            acceptedBranch = scoredSibling;
            logger.info(
              `[TreeOfThoughts/DFS] Sibling ${siblingAttempt + 1}/${adaptiveBranchCount} accepted ` +
                `(score: ${scoredSibling.score.toFixed(1)} >= threshold: ${valueThreshold})`,
            );
            break;
          }

          state.branchesBacktracked++;
          failedApproachDescriptions.push(
            (scoredSibling.text || scoredSibling.thinking || "").slice(0, 300),
          );

          emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
            branchIndex: scoredSibling.branchIndex,
            reason: "dfs_sibling_pruned",
            score: scoredSibling.score,
            threshold: valueThreshold,
            siblingAttempt: siblingAttempt + 1,
            maxSiblings: adaptiveBranchCount,
          });

          logger.info(
            `[TreeOfThoughts/DFS] Sibling ${siblingAttempt + 1}/${adaptiveBranchCount} pruned ` +
              `(score: ${scoredSibling.score.toFixed(1)} < threshold: ${valueThreshold})`,
          );
        }

        if (!acceptedBranch) {
          exploredSiblings.sort(
            (branchA, branchB) => branchB.score - branchA.score,
          );
          acceptedBranch = exploredSiblings[0];
          logger.info(
            `[TreeOfThoughts/DFS] No sibling above threshold — accepting best available ` +
              `(score: ${acceptedBranch.score.toFixed(1)})`,
          );
        }

        scoredBranches = exploredSiblings.sort(
          (branchA, branchB) => branchB.score - branchA.score,
        );
        selectedBranch = acceptedBranch;
      } else {
        // ── BFS: parallel generation + frontier retention (Paper Algorithm 1) ──
        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.BRANCHING_STARTED,
          branchCount: adaptiveBranchCount,
          iteration: state.iterations,
          searchStrategy,
        });

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
              LOG_LABEL,
            ),
          ),
        );

        if (signal?.aborted) break;

        state.branchesExplored += adaptiveBranchCount;

        scoredBranches = await scoreBranchesMultiCriteria(
          harness,
          branchResults,
          LOG_LABEL,
        );

        scoredBranches.sort(
          (branchA, branchB) => branchB.score - branchA.score,
        );

        selectedBranch = scoredBranches[0];

        // ── Retain top-b candidates as frontier (Paper Algorithm 1: "b best states") ──
        state.frontierCandidates = scoredBranches
          .slice(1, bfsBeamWidth)
          .map((branch) => ({
            pass: branch.pass,
            score: branch.score,
            branchIndex: branch.branchIndex,
            criteriaScores: branch.criteriaScores,
          }));
      }

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
        searchStrategy,
        frontierSize: state.frontierCandidates.length,
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
      //  PHASE 2.5: Proactive value-threshold pruning (Paper §2.1)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      if (
        selectedBranch.score < valueThreshold &&
        state.iterations > 1 &&
        state.proactiveBacktracks < MAX_PROACTIVE_BACKTRACKS
      ) {
        state.proactiveBacktracks++;
        state.branchesBacktracked++;

        const failedSummary = (
          selectedBranch.text ||
          selectedBranch.thinking ||
          ""
        )
          .slice(0, 300)
          .trim();
        if (failedSummary) failedApproachDescriptions.push(failedSummary);

        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
          branchIndex: selectedBranch.branchIndex,
          reason: "proactive_value_threshold",
          bestScore: selectedBranch.score,
          threshold: valueThreshold,
          proactiveBacktracks: state.proactiveBacktracks,
          maxProactiveBacktracks: MAX_PROACTIVE_BACKTRACKS,
        });

        logger.info(
          `[TreeOfThoughts] Proactive backtrack — best score ${selectedBranch.score.toFixed(1)} ` +
            `< threshold ${valueThreshold}. Re-branching (${state.proactiveBacktracks}/${MAX_PROACTIVE_BACKTRACKS}).`,
        );

        currentMessages.push({
          role: "system",
          content: wrapSystemMessage(
            SYSTEM_MESSAGE_TAGS.BACKTRACK,
            PromptLocaleService.get(
              (options?.locale as string | undefined) ||
                PromptLocaleService.getDefaultLocale(),
              "harness.treeOfThoughts.proactiveBacktrack",
              {
                branchCount: String(scoredBranches.length),
                bestScore: selectedBranch.score.toFixed(1),
                threshold: String(valueThreshold),
              },
            ),
          ),
        });

        continue;
      }

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
      if (
        checkCostBudget(
          state,
          context.resolvedModel,
          options.maxCostDollars,
          emit,
          { budget: options._sharedCostBudget, loopId: context.agentConversationId },
        )
      ) {
        break;
      }

      // ── Tool execution from selected branch ─────────────────
      if (selectedPass.pendingToolCalls.length > 0) {
        const preExecutionSnapshot = currentMessages.map((message) => ({
          ...message,
        }));

        const { results, sandboxCheckpointReference } =
          await executeApprovedToolBatch(
            harness,
            selectedPass,
            currentMessages,
            standardHooks,
          );

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

          // ── BFS frontier fallback (Paper Algorithm 1: try next-best state) ──
          // Before re-branching from scratch, try the next frontier candidate
          // that was already scored but not executed.
          if (
            searchStrategy === "bfs" &&
            state.frontierCandidates.length > 0 &&
            sandboxCheckpointReference
          ) {
            const fallbackCandidate = state.frontierCandidates.shift()!;

            currentMessages = preExecutionSnapshot;
            restoreSandboxCheckpoint(
              workspaceRoot,
              sandboxCheckpointReference,
              emit,
            );

            emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
              branchIndex: selectedBranch.branchIndex,
              validationErrors: validationFeedback.length,
              restoredCheckpoint: true,
              reason: "frontier_fallback",
              fallbackBranchIndex: fallbackCandidate.branchIndex,
              fallbackScore: fallbackCandidate.score,
            });

            logger.info(
              `[TreeOfThoughts/BFS] Branch ${selectedBranch.branchIndex + 1} failed validation. ` +
                `Falling back to frontier candidate ${fallbackCandidate.branchIndex + 1} ` +
                `(score: ${fallbackCandidate.score.toFixed(1)}).`,
            );

            currentMessages.push({
              role: "system",
              content: wrapSystemMessage(
                SYSTEM_MESSAGE_TAGS.VALIDATION_ERRORS,
                PromptLocaleService.get(
                  (options?.locale as string | undefined) ||
                    PromptLocaleService.getDefaultLocale(),
                  "harness.treeOfThoughts.frontierFallback",
                  {
                    branchIndex: String(selectedBranch.branchIndex + 1),
                    errorCount: String(validationFeedback.length),
                    errorBlock,
                  },
                ),
              ),
            });

            // Re-enter the main execution path with the fallback candidate's pass
            // by replacing the selected branch and re-executing the tool phase
            // on the next iteration with the fallback's tool calls.
            harness.logIteration(selectedPass, currentMessages);

            // Inject the fallback branch's reasoning as context for the next iteration
            if (fallbackCandidate.pass.finalStreamedText || fallbackCandidate.pass.streamedText) {
              currentMessages.push({
                role: "assistant",
                content: fallbackCandidate.pass.finalStreamedText || fallbackCandidate.pass.streamedText,
                ...(fallbackCandidate.pass.streamedThinking.trim() && {
                  thinking: fallbackCandidate.pass.streamedThinking.trim(),
                }),
              });
            }

            continue;
          }

          const shouldRestoreCheckpoint =
            backtrackAttemptsThisIteration <=
              MAX_BACKTRACK_ATTEMPTS_PER_ITERATION && scoredBranches.length > 1;

          if (shouldRestoreCheckpoint) {
            currentMessages = preExecutionSnapshot;

            // Restore filesystem to pre-execution state alongside conversation
            if (sandboxCheckpointReference) {
              restoreSandboxCheckpoint(
                workspaceRoot,
                sandboxCheckpointReference,
                emit,
              );
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
              content: wrapSystemMessage(
                SYSTEM_MESSAGE_TAGS.VALIDATION_ERRORS,
                PromptLocaleService.get(
                  (options?.locale as string | undefined) ||
                    PromptLocaleService.getDefaultLocale(),
                  "harness.treeOfThoughts.reflexion",
                  {
                    branchIndex: String(selectedBranch.branchIndex + 1),
                    errorCount: String(validationFeedback.length),
                    errorBlock,
                  },
                ),
              ),
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
                    durationMilliseconds: matchingResult?.durationMilliseconds,
                  };
                },
              ),
            });

            currentMessages.push({
              role: "system",
              content: wrapSystemMessage(
                SYSTEM_MESSAGE_TAGS.VALIDATION_ERRORS,
                PromptLocaleService.get(
                  (options?.locale as string | undefined) ||
                    PromptLocaleService.getDefaultLocale(),
                  "harness.treeOfThoughts.budgetExhausted",
                  { errorBlock },
                ),
              ),
            });
          }

          harness.logIteration(selectedPass, currentMessages);
          continue;
        }

        // ── No validation errors — commit this branch ──────────

        harness.logIteration(selectedPass, currentMessages);

        failedApproachDescriptions = [];

        const commitResult = await commitToolCallResults(
          harness,
          selectedPass,
          results,
          currentMessages,
          LOG_LABEL,
        );
        if (commitResult.planAborted) {
          return { messages: commitResult.messages };
        }
        currentMessages = commitResult.messages;

        continue;
      }

      // ── No tools — final text / thinking-only / truncation ──
      const outcome = handleNoToolCallOutcome(
        harness,
        selectedPass,
        currentMessages,
        truncationRecoveryCount,
        LOG_LABEL,
      );
      truncationRecoveryCount = outcome.truncationRecoveryCount;
      if (outcome.cleanTextBreak) hasCleanTextBreak = true;
      if (outcome.action === "break") break;
      continue;
    }

    await finalizeStrategyRun(
      harness,
      currentMessages,
      standardHooks,
      hasCleanTextBreak,
      LOG_LABEL,
      `${state.iterations} iterations, ` +
        `${state.branchesExplored} branches explored, ` +
        `${state.branchesBacktracked} backtracked (${state.proactiveBacktracks} proactive), ` +
        `strategy: ${searchStrategy}`,
    );
    return { messages: currentMessages };
  } catch (loopError: unknown) {
    return await persistLoopError(
      harness,
      currentMessages,
      standardHooks,
      loopError,
      LOG_LABEL,
    );
  }
}
