import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import logger from "../../utils/logger.ts";
import { SSE_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";

import { createStandardHooks } from "./lifecycle/HookInitializer.ts";
import { executeToolBatch } from "./lifecycle/ToolExecutor.ts";
import { checkAndWaitForApproval } from "./lifecycle/ApprovalGate.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "./lifecycle/PostExecutionEmitter.ts";
import { runExhaustionRecoveryPass } from "./lifecycle/ExhaustionRecovery.ts";
import { reloadIfCustomToolsMutated } from "./lifecycle/ToolHotReloader.ts";
import { validateAfterToolExecution } from "./lifecycle/ValidationInterceptor.ts";
import {
  isOutputTruncated,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  buildProviderErrorMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "./lifecycle/OutputTruncationRecovery.ts";

import SessionGenerationTracker from "../SessionGenerationTracker.ts";
import AutoCompactionTrigger from "../compact/AutoCompactionTrigger.ts";
import CompactionService from "../compact/CompactionService.ts";
import ContextWindowManager from "../../utils/ContextWindowManager.ts";

import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  PassState,
} from "./types.ts";

const MAX_TOOL_ITERATIONS = 25;
const MAX_CONSECUTIVE_TOOL_ERRORS = 3;
const DEFAULT_BRANCH_COUNT = 3;

interface ScoredBranch {
  branchIndex: number;
  text: string;
  thinking: string;
  thinkingSignature: string;
  score: number;
  pass: PassState;
}

/**
 * TreeOfThoughtHarness — Non-linear graph-state harness with branching,
 * scoring, and backtracking.
 *
 * Instead of a linear Reason→Act→Observe loop, this harness explores
 * multiple reasoning branches in parallel, scores them via self-evaluation,
 * and commits the best one. When execution of the selected branch fails
 * validation, it backtracks to the next-best candidate.
 *
 * Based on the Tree of Thoughts framework (Yao et al., 2023) adapted
 * for agentic tool-use loops.
 *
 * Control flow:
 *   1. Generate N candidate reasoning branches in parallel
 *   2. Score candidates via self-evaluation (single fast LLM call)
 *   3. Select the highest-scoring branch
 *   4. Execute tools from the selected branch (standard ReAct iteration)
 *   5. If validation fails: backtrack to next-best branch
 *   6. If text only (and not in plan mode): break → finalize
 *   7. Exhaustion recovery if iteration limit hit
 *
 * Lifecycle modules (ToolExecutor, ApprovalGate, PostExecutionEmitter,
 * ValidationInterceptor, ExhaustionRecovery) are reused from the shared
 * lifecycle/ directory.
 */
export default class TreeOfThoughtHarness extends BaseAgenticHarness {
  static id = "tree_of_thought";
  static label = "Tree of Thought";
  static description =
    "Non-linear branching harness with parallel candidate generation, scoring, and backtracking.";

  async run(): Promise<{ messages: ConversationMessage[] }> {
    const context = this.ctx;
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

    const branchCount = Math.min(
      (options as Record<string, unknown>).branchCount as number || DEFAULT_BRANCH_COUNT,
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

    const { hooks, approvalEngine } = createStandardHooks({
      workspaceRoot: workspaceRoot || undefined,
      autoApprove: options.autoApprove === true,
      policies: options.policies,
      enableCriticGate: options.enableCriticGate === true,
      criticModel: options.criticModel || undefined,
    });

    // ── beforePrompt hook (once) ──────────────────────────
    const hookContext: Record<string, unknown> & { messages: ConversationMessage[]; _injectedSkills?: string[] } = {
      messages: currentMessages,
      project,
      username,
      agent,
      traceId,
      agentSessionId,
      agentContext: options.agentContext,
      enabledTools: this.tools.resolvedEnabledTools,
      workspaceRoot: workspaceRoot || undefined,
    };
    await hooks.run("beforePrompt" as Parameters<typeof hooks.run>[0], hookContext as Parameters<typeof hooks.run>[1]);

    const assembledSystemMessage = currentMessages.find((message) => message.role === "system");
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
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.SKILLS_INJECTED,
        skills: hookContext._injectedSkills,
      });
    }

    // ── Main loop ────────────────────────────────────────────
    // Wrapped in try/catch for error-path message persistence.
    try {
    while (state.iterations < resolvedMaxIterations) {
      state.iterations++;

      emit({
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.ITERATION_PROGRESS,
        iteration: state.iterations,
        maxIterations: resolvedMaxIterations,
        harness: "tree_of_thought",
      });

      const passOptions: Record<string, unknown> = {
        ...options,
        project,
        agent,
        username,
        tools: this.tools.finalTools,
      };

      // ── Auto-compaction trigger ─────────────────────────────
      const contextWindowSize = context.modelDef?.maxInputTokens || 128_000;
      const maxOutputTokens = options.maxTokens || 8192;
      const preEnforceTokenEstimate = ContextWindowManager.estimateTokens(
        currentMessages as Parameters<typeof ContextWindowManager.estimateTokens>[0],
      );

      const autoCompactEvaluation = AutoCompactionTrigger.evaluate(
        preEnforceTokenEstimate,
        contextWindowSize,
        maxOutputTokens,
        currentMessages.length,
      );

      if (autoCompactEvaluation.shouldCompact) {
        const compactionResult = await CompactionService.compactConversation(
          currentMessages as Parameters<typeof CompactionService.compactConversation>[0],
          {
            project: project || "",
            username: username || "",
            agentSessionId,
            traceId: traceId || null,
            agent: agent || null,
            emit,
            signal: signal || undefined,
          },
        );

        if (compactionResult) {
          currentMessages = compactionResult.compactedMessages as ConversationMessage[];
          state.originalMessageCount = currentMessages.length;
          state.compactionPerformed = true;
          state.preCompactTokenCount = compactionResult.preCompactTokenCount;
          state.postCompactTokenCount = compactionResult.postCompactTokenCount;
        }
      }

      // ── Context window enforcement ─────────────────────────
      currentMessages = this.enforceContextWindow(
        currentMessages,
        this.tools.finalTools.length,
      );

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 1: Generate candidate branches
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      emit({
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.BRANCHING_STARTED,
        branchCount,
        iteration: state.iterations,
      });

      const branchPassOptions: Record<string, unknown> = {
        ...passOptions,
        tools: this.tools.finalTools,
      };

      const allowedToolNames = new Set(
        this.tools.finalTools.map((tool: ToolSchema) => tool.name),
      );

      const branchResults = await Promise.all(
        Array.from({ length: branchCount }, (_, branchIndex) =>
          this.generateBranch(
            branchIndex,
            branchCount,
            currentMessages,
            branchPassOptions,
            allowedToolNames,
          ),
        ),
      );

      if (signal?.aborted) break;

      // Track branch exploration stats
      state.branchesExplored += branchCount;

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 2: Score and rank branches
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      const scoredBranches = await this.scoreBranches(
        branchResults,
        currentMessages,
      );

      // Sort by score descending
      scoredBranches.sort((branchA, branchB) => branchB.score - branchA.score);

      const selectedBranch = scoredBranches[0];
      state.selectedBranchScores.push(selectedBranch.score);

      emit({
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.BRANCH_SELECTED,
        branchIndex: selectedBranch.branchIndex,
        score: selectedBranch.score,
        branchCount,
        scores: scoredBranches.map((branch) => ({
          index: branch.branchIndex,
          score: branch.score,
        })),
      });

      logger.info(
        `[TreeOfThought] Iteration ${state.iterations}: selected branch ${selectedBranch.branchIndex + 1}/${branchCount} ` +
          `(score: ${selectedBranch.score}), scores: [${scoredBranches.map((branch) => branch.score.toFixed(1)).join(", ")}]`,
      );

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  PHASE 3: Execute selected branch (standard ReAct step)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

      const selectedPass = selectedBranch.pass;

      // Finalize tracker for the selected pass
      if (selectedPass.usage.outputTokens > 0 && selectedPass.requestId) {
        SessionGenerationTracker.update(selectedPass.requestId, {
          outputTokens: selectedPass.usage.outputTokens,
        });
      }
      const finalInputTokens =
        selectedPass.usage.inputTokens || selectedPass.usage.promptTokens || 0;
      if (finalInputTokens > 0 && selectedPass.requestId) {
        SessionGenerationTracker.update(selectedPass.requestId, {
          inputTokens: finalInputTokens,
        });
      }
      this.emitGenerationProgress();
      if (selectedPass.requestId) {
        SessionGenerationTracker.complete(selectedPass.requestId);
      }

      emit({
        type: SSE_EVENT_TYPES.USAGE_UPDATE,
        usage: { ...state.overallUsage, requests: state.iterations },
      });

      // ── Tool execution from selected branch ─────────────────
      if (selectedPass.pendingToolCalls.length > 0) {
        const { approved, approveAll } = await checkAndWaitForApproval(
          selectedPass.pendingToolCalls,
          context,
          approvalEngine,
        );

        let results: ToolResult[] = [];
        if (!approved) {
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
          if (approveAll) {
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
        );

        trackToolErrors(
          selectedPass.pendingToolCalls,
          results,
          state,
          MAX_CONSECUTIVE_TOOL_ERRORS,
          emit,
        );

        emitPostExecutionStatus(selectedPass.pendingToolCalls, emit);

        await reloadIfCustomToolsMutated(
          selectedPass.pendingToolCalls,
          this.tools,
          project,
          username,
          emit,
        );

        // ── Validation + backtracking ─────────────────────────
        const validationFeedback = await validateAfterToolExecution(
          selectedPass.pendingToolCalls,
          results,
          context,
          state,
        );

        if (validationFeedback.length > 0 && scoredBranches.length > 1) {
          state.branchesBacktracked++;
          emit({
            type: SSE_EVENT_TYPES.STATUS,
            message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
            branchIndex: selectedBranch.branchIndex,
            validationErrors: validationFeedback.length,
          });

          logger.info(
            `[TreeOfThought] Branch ${selectedBranch.branchIndex + 1} failed validation. ` +
              `Injecting error feedback for self-correction.`,
          );

          // Inject validation errors as feedback for next iteration
          const errorBlock = validationFeedback
            .map(
              (feedback) =>
                `### ${feedback.filePath} (${feedback.validatorType})\n${feedback.rawOutput}`,
            )
            .join("\n\n");

          currentMessages.push({
            role: "assistant",
            content: selectedPass.streamedText || "",
            ...(selectedPass.streamedThinking && { thinking: selectedPass.streamedThinking }),
            toolCalls: selectedPass.pendingToolCalls.map((toolCall: ToolCall) => {
              const matchingResult = results.find((result) => result.id === toolCall.id);
              return {
                id: toolCall.id || null,
                name: toolCall.name,
                args: toolCall.args,
                result: matchingResult ? matchingResult.result : null,
              };
            }),
          });

          currentMessages.push({
            role: "user",
            content:
              `[VALIDATION ERROR — BRANCH ${selectedBranch.branchIndex + 1} FAILED]\n\n` +
              `${errorBlock}\n\n` +
              `Fix these issues. Consider an alternative approach.`,
          });

          this.logIteration(selectedPass, currentMessages);
          continue;
        }

        this.logIteration(selectedPass, currentMessages);

        // ── Append to context for next pass ───────────────────
        const assistantMessage: ConversationMessage = {
          role: "assistant",
          content: selectedPass.streamedText || "",
          ...(selectedPass.streamedThinking && {
            thinking: selectedPass.streamedThinking,
          }),
          ...(selectedPass.thinkingSignature && {
            thinkingSignature: selectedPass.thinkingSignature,
          }),
          toolCalls: selectedPass.pendingToolCalls.map((toolCall: ToolCall) => {
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
            };
          }),
        };
        currentMessages.push(assistantMessage);

        currentMessages = currentMessages.filter(
          (message) =>
            !(
              message.role === "assistant" &&
              !message.content?.trim() &&
              (!message.toolCalls || message.toolCalls.length === 0)
            ),
        );
        continue;
      }

      // ── No tools — final text response ──────────────────────
      if (selectedPass.streamedText || selectedPass.streamedThinking) {
        this.logIteration(selectedPass, currentMessages);
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
        injectErrorAsConversationMessage(currentMessages, exhaustionMessage, context);
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
      state.iterations >= resolvedMaxIterations &&
      !state.finalStreamedText?.trim() &&
      state.streamedToolCalls.length === 0
    ) {
      await runExhaustionRecoveryPass(this, context, state, currentMessages);
    }

    // ── Finalization (happy path) ──────────────────────────────
    logger.info(
      `[TreeOfThought] Session complete: ${state.iterations} iterations, ` +
        `${state.branchesExplored} branches explored, ` +
        `${state.branchesBacktracked} backtracked`,
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
  //  PRIVATE — Branch generation and scoring
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * Generate a single reasoning branch by streaming an LLM response
   * with a diversity prompt injection.
   */
  private async generateBranch(
    branchIndex: number,
    totalBranches: number,
    currentMessages: ConversationMessage[],
    passOptions: Record<string, unknown>,
    allowedToolNames: Set<string>,
  ): Promise<ScoredBranch> {
    const branchMessages = [...currentMessages];

    // Inject branch-diversity instruction for branches after the first
    if (branchIndex > 0) {
      branchMessages.push({
        role: "user",
        content:
          `[BRANCH ${branchIndex + 1}/${totalBranches}] ` +
          `Consider an alternative approach to the task. ` +
          `Think carefully about trade-offs and choose a different strategy ` +
          `than you might have initially considered.`,
      });
    }

    const pass = this.createPassState(passOptions);
    const passRequestId = `${this.ctx.requestId || this.ctx.agentSessionId}-iter-${this.state.iterations}-branch-${branchIndex}`;
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
      pass,
    };
  }

  /**
   * Score branches using self-evaluation via a single LLM call.
   *
   * The model rates each candidate on correctness, completeness, and risk.
   * This is cheaper than running a separate critic model because it reuses
   * the same provider and model, and only generates ~50 tokens.
   */
  private async scoreBranches(
    branches: ScoredBranch[],
    _currentMessages: ConversationMessage[],
  ): Promise<ScoredBranch[]> {
    // If only 1 branch, skip scoring entirely
    if (branches.length <= 1) {
      if (branches[0]) branches[0].score = 10;
      return branches;
    }

    try {
      const candidateSummaries = branches
        .map((branch, index) => {
          const textPreview = (branch.text || branch.thinking || "(no output)")
            .slice(0, 400)
            .trim();
          const toolCallCount = branch.pass.pendingToolCalls.length;
          return `[Candidate ${index + 1}] ${toolCallCount} tool call(s). Output: ${textPreview}`;
        })
        .join("\n\n");

      const scoringPrompt = [
        "Rate each candidate approach (1-10) for correctness, completeness, and safety.",
        "Higher is better. Respond ONLY with scores in format: 1:8, 2:6",
        "",
        candidateSummaries,
      ].join("\n");

      const scoringMessages = [
        { role: "user" as const, content: scoringPrompt },
      ];

      const scoringOptions = {
        maxTokens: 100,
        temperature: 0,
        signal: AbortSignal.timeout(15_000),
      };

      let scoreResponseText = "";
      const scoringStream = this.ctx.provider.generateTextStream(
        scoringMessages,
        this.ctx.resolvedModel,
        scoringOptions,
      );

      for await (const chunk of scoringStream) {
        if (typeof chunk === "string") {
          scoreResponseText += chunk;
        }
      }

      // Parse scores from response like "1:8, 2:6, 3:7"
      const scorePattern = /(\d+)\s*:\s*(\d+(?:\.\d+)?)/g;
      let scoreMatch: RegExpExecArray | null;
      while ((scoreMatch = scorePattern.exec(scoreResponseText)) !== null) {
        const candidateIndex = parseInt(scoreMatch[1], 10) - 1;
        const candidateScore = parseFloat(scoreMatch[2]);
        if (candidateIndex >= 0 && candidateIndex < branches.length && candidateScore >= 0 && candidateScore <= 10) {
          branches[candidateIndex].score = candidateScore;
        }
      }

      // Ensure all branches have a score (default to 5 if parsing missed them)
      for (const branch of branches) {
        if (branch.score === 0) branch.score = 5;
      }

      logger.info(
        `[TreeOfThought] Branch scores: ${branches.map((branch, index) => `${index + 1}:${branch.score}`).join(", ")}`,
      );
    } catch (scoringError: unknown) {
      // On scoring failure, assign equal scores (first branch wins via stable sort)
      logger.warn(
        `[TreeOfThought] Scoring failed: ${getErrorMessage(scoringError)}. Using equal scores.`,
      );
      for (const branch of branches) {
        branch.score = 5;
      }
    }

    return branches;
  }
}
