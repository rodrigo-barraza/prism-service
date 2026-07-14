/**
 * Graph of Thoughts (GoT) Thought Structure
 *
 * Paper: "Graph of Thoughts: Solving Elaborate Problems
 * with Large Language Models" (arxiv.org/abs/2308.09687)
 *
 * Generates N parallel branches, scores each, then synthesizes
 * the best aspects of ALL branches into a unified response
 * (aggregation > selection). Core differentiator from ToT.
 *
 * Shared branching machinery (branch generation, scoring, planning
 * phase, tool execution, commit, no-tool outcomes) lives in
 * branchingCommon.ts — this file holds only the GoT synthesis logic.
 *
 * See ThoughtStructureRegistry.ts → THOUGHT_STRUCTURE_DEFINITIONS
 * (id: "graph_of_thoughts") for full paper-alignment metadata.
 */
import type BaseAgenticHarness from "#src/services/harnesses/BaseAgenticHarness";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type {
  ConversationMessage,
  ToolSchema,
  PassState,
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
  DEFAULT_VALUE_THRESHOLD,
  MAX_PROACTIVE_BACKTRACKS,
} = HARNESS;

const LOG_LABEL = "GraphOfThoughts";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Public API — called by ReActHarness when thoughtStructure === "graph_of_thoughts"
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export async function runGraphOfThoughts(
  harness: BaseAgenticHarness,
): Promise<{ messages: ConversationMessage[] }> {
  const context = harness["context"];
  const state: AgenticLoopState = harness["state"];
  const tools = harness["tools"];
  const { options, project, username, agent, workspaceRoot, emit, signal } =
    context;

  const initialBranchCount = Math.min(
    Math.max(1, options.branchCount || DEFAULT_BRANCH_COUNT),
    5,
  );
  const valueThreshold = options.valueThreshold ?? DEFAULT_VALUE_THRESHOLD;

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
        state.iterations === 1
          ? initialBranchCount
          : Math.max(2, Math.ceil(initialBranchCount * 0.6));

      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.ITERATION_PROGRESS,
        iteration: state.iterations,
        maxIterations: resolvedMaxIterations,
        harness: "graph_of_thoughts",
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
        "GraphOfThoughts",
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
            [],
            LOG_LABEL,
          ),
        ),
      );

      if (signal?.aborted) break;

      state.branchesExplored += adaptiveBranchCount;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 2: Multi-criteria score branches
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      const scoredBranches = await scoreBranchesMultiCriteria(
        harness,
        branchResults,
        LOG_LABEL,
      );

      scoredBranches.sort((branchA, branchB) => branchB.score - branchA.score);

      state.selectedBranchScores.push(scoredBranches[0]?.score ?? 0);

      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.BRANCH_SELECTED,
        branchCount: adaptiveBranchCount,
        scores: scoredBranches.map((branch) => ({
          index: branch.branchIndex,
          score: branch.score,
          criteria: branch.criteriaScores,
        })),
        synthesizing: true,
      });

      logger.info(
        `[GraphOfThoughts] Iteration ${state.iterations}: scored ${adaptiveBranchCount} branches — ` +
          `scores: [${scoredBranches.map((branch) => branch.score.toFixed(1)).join(", ")}]`,
      );

      // ── Proactive value-threshold pruning & filtering ──
      const activeBranches = scoredBranches.filter(
        (branch) => branch.score >= valueThreshold,
      );

      if (
        activeBranches.length === 0 &&
        state.iterations > 1 &&
        state.proactiveBacktracks < MAX_PROACTIVE_BACKTRACKS
      ) {
        state.proactiveBacktracks++;
        state.branchesBacktracked++;

        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
          branchIndex: -1,
          reason: "proactive_value_threshold",
          bestScore: scoredBranches[0]?.score ?? 0,
          threshold: valueThreshold,
          proactiveBacktracks: state.proactiveBacktracks,
          maxProactiveBacktracks: MAX_PROACTIVE_BACKTRACKS,
        });

        logger.info(
          `[GraphOfThoughts] Proactive backtrack — best score ${(scoredBranches[0]?.score ?? 0).toFixed(1)} ` +
            `< threshold ${valueThreshold}. Re-branching (${state.proactiveBacktracks}/${MAX_PROACTIVE_BACKTRACKS}).`,
        );

        currentMessages.push({
          role: "system",
          content: wrapSystemMessage(
            SYSTEM_MESSAGE_TAGS.BACKTRACK,
            PromptLocaleService.get(
              (options?.locale as string | undefined) ||
                PromptLocaleService.getDefaultLocale(),
              "harness.graphOfThoughts.proactiveBacktrack",
              {
                bestScore: (scoredBranches[0]?.score ?? 0).toFixed(1),
                threshold: String(valueThreshold),
              },
            ),
          ),
        });

        continue;
      }

      const branchesToSynthesize =
        activeBranches.length > 0 ? activeBranches : [scoredBranches[0]];

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 3: Synthesize branches into merged output
      //  (GoT differentiator — aggregation instead of pick-winner)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      const synthesizedPass = await synthesizeBranches(
        harness,
        branchesToSynthesize,
        currentMessages,
        passOptions,
        allowedToolNames,
      );

      if (signal?.aborted) break;

      state.finalStreamedText = synthesizedPass.finalStreamedText;
      state.streamedThinking = synthesizedPass.streamedThinking;

      finalizePassTracker(synthesizedPass, synthesizedPass.requestId || "");

      for (const branch of branchesToSynthesize) {
        if (branch.pass.requestId) {
          finalizePassTracker(branch.pass, branch.pass.requestId);
          harness.logIteration(branch.pass, currentMessages);
        }
      }

      logKVCacheHitRate(
        synthesizedPass.usage,
        state.iterations,
        "GraphOfThoughts",
      );
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

      // ── Tool execution from synthesized output ──────────────
      if (synthesizedPass.pendingToolCalls.length > 0) {
        const { results, sandboxCheckpointReference } =
          await executeApprovedToolBatch(
            harness,
            synthesizedPass,
            currentMessages,
            standardHooks,
          );

        // ── Validation ──────────────────────────────────────────
        const validationFeedback = await validateAfterToolExecution(
          synthesizedPass.pendingToolCalls,
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

          // Restore sandbox checkpoint on validation failure
          if (sandboxCheckpointReference) {
            restoreSandboxCheckpoint(
              workspaceRoot,
              sandboxCheckpointReference,
              emit,
            );
          }

          currentMessages.push({
            role: "system",
            content: wrapSystemMessage(
              SYSTEM_MESSAGE_TAGS.VALIDATION_ERRORS,
              PromptLocaleService.get(
                (options?.locale as string | undefined) ||
                  PromptLocaleService.getDefaultLocale(),
                "harness.graphOfThoughts.synthesizedValidationError",
                {
                  errorCount: String(validationFeedback.length),
                  errorBlock,
                  branchCount: String(scoredBranches.length),
                },
              ),
            ),
          });

          harness.logIteration(synthesizedPass, currentMessages);
          continue;
        }

        // ── No validation errors — commit ──────────────────────
        harness.logIteration(synthesizedPass, currentMessages);

        const commitResult = await commitToolCallResults(
          harness,
          synthesizedPass,
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
        synthesizedPass,
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
        `${state.branchesBacktracked} backtracked`,
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Synthesis pass — merges branch outputs into a unified response
//  (The core GoT differentiator vs ToT's pick-winner)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function synthesizeBranches(
  harness: BaseAgenticHarness,
  scoredBranches: ScoredBranch[],
  currentMessages: ConversationMessage[],
  passOptions: IterationPassOptions,
  allowedToolNames: Set<string>,
): Promise<PassState> {
  const state: AgenticLoopState = harness["state"];
  const context = harness["context"];
  const { emit } = context;

  // If only one branch, skip synthesis — use it directly (same as ToT)
  if (scoredBranches.length <= 1) {
    logger.info(
      `[GraphOfThoughts] Single branch — skipping synthesis, using directly.`,
    );
    return scoredBranches[0].pass;
  }

  // Build a synthesis prompt that presents all branch outputs with their scores
  const branchSummaries = scoredBranches
    .map((branch) => {
      const textContent = (branch.text || branch.thinking || "(no output)")
        .slice(0, 1500)
        .trim();
      const toolCallDescriptions = branch.pass.pendingToolCalls
        .map((toolCall) => {
          const argumentsSummary =
            typeof toolCall.args === "string"
              ? (toolCall.args as string).slice(0, 300)
              : JSON.stringify(toolCall.args).slice(0, 300);
          return `  - ${toolCall.name}(${argumentsSummary})`;
        })
        .join("\n");

      return (
        `── Branch ${branch.branchIndex + 1} ` +
        `(score: ${branch.score.toFixed(1)} — ` +
        `correctness=${branch.criteriaScores.correctness}, ` +
        `risk=${branch.criteriaScores.risk}, ` +
        `efficiency=${branch.criteriaScores.efficiency}, ` +
        `completeness=${branch.criteriaScores.completeness}) ──\n` +
        `Reasoning:\n${textContent}\n` +
        (toolCallDescriptions
          ? `Tool calls:\n${toolCallDescriptions}`
          : "(no tool calls)")
      );
    })
    .join("\n\n");

  const synthesisInstruction: ConversationMessage = {
    role: "user",
    content:
      `[GRAPH-OF-THOUGHTS SYNTHESIS PASS]\n\n` +
      `${scoredBranches.length} parallel reasoning branches were generated and scored. ` +
      `Your task is to produce a single, optimal response that SYNTHESIZES the best ` +
      `aspects of all branches — combining the strongest tool calls, the safest ` +
      `approaches, and the most complete coverage into one unified action.\n\n` +
      `RULES:\n` +
      `1. Do NOT simply repeat the highest-scoring branch. Merge complementary strengths.\n` +
      `2. If multiple branches propose different tool calls that are COMPLEMENTARY ` +
      `   (non-conflicting), include all of them.\n` +
      `3. If branches disagree on approach, prefer the one with highest CORRECTNESS ` +
      `   score, then RISK score.\n` +
      `4. Incorporate defensive measures (error handling, validation) from the ` +
      `   THOROUGH branch even if using a MINIMAL branch's core approach.\n` +
      `5. Produce your merged response with tool calls as if you are executing the task.\n\n` +
      `── BRANCH OUTPUTS ──\n\n` +
      branchSummaries,
  };

  const synthesisMessages = [...currentMessages, synthesisInstruction];

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.SYNTHESIS_STARTED,
    branchCount: scoredBranches.length,
    iteration: state.iterations,
  });

  logger.info(
    `[GraphOfThoughts] Starting synthesis pass from ${scoredBranches.length} branches.`,
  );

  const synthesisPass = harness.createPassState(passOptions);
  const { agentConversationId } = context;
  const resolvedAgentConversationId = agentConversationId || "";
  const requestIdBase =
    context.requestId || resolvedAgentConversationId || crypto.randomUUID();
  const passRequestId = `${requestIdBase}-iter-${state.iterations}-synthesis`;
  synthesisPass.requestId = passRequestId;
  harness.registerTrackerRequest(passRequestId);

  const synthesisStream = await harness.createProviderStream(
    synthesisMessages,
    passOptions,
  );

  // Context exhaustion guard — skip synthesis if budget is critically low
  if (synthesisStream === null) {
    logger.warn(
      `[GraphOfThoughts] Context exhaustion during synthesis — skipping.`,
    );
    return synthesisPass;
  }

  await harness.consumeStream(synthesisStream, synthesisPass, allowedToolNames);

  logger.info(
    `[GraphOfThoughts] Synthesis complete — ` +
      `${synthesisPass.pendingToolCalls.length} tool call(s), ` +
      `${(synthesisPass.streamedText || "").length} chars text output.`,
  );

  return synthesisPass;
}
