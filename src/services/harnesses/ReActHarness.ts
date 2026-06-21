import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import { runTreeOfThoughts } from "./strategies/TreeOfThoughtsStrategy.ts";
import { runGraphOfThoughts } from "./strategies/GraphOfThoughtsStrategy.ts";
import logger from "../../utils/logger.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
  THOUGHT_STRUCTURES,
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
  blockUnauthorizedToolCalls,
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
import { maybeInjectSystemReminder, cleanupReminderCache } from "./lifecycle/SystemReminderInjector.ts";
import { checkCostBudget } from "./lifecycle/CostBudgetEnforcer.ts";
import { createSandboxCheckpoint, restoreSandboxCheckpoint } from "./lifecycle/SandboxExecutor.ts";

import PlanningModeService from "../PlanningModeService.ts";

import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  AgenticOptions,
} from "./types.ts";

/**
 * Context object passed to the beforePrompt lifecycle hook.
 * Carries all the data the hook pipeline needs to assemble the system prompt,
 * inject skills, and mutate the message array before the first LLM call.
 */
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

/**
 * Per-iteration pass options combining the user's AgenticOptions with
 * runtime context fields needed by the provider and lifecycle modules.
 */
interface IterationPassOptions extends AgenticOptions {
  project: string;
  agent?: string | null;
  username: string;
}

const MAX_TOOL_ITERATIONS = 25;
const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

/**
 * ReActHarness — Reason→Act→Observe tool-use loop with pluggable thought structures.
 *
 * Papers:
 *   - "ReAct: Synergizing Reasoning and Acting in Language Models"
 *     (arxiv.org/abs/2210.03629) — Yao et al., 2022
 *   - "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models"
 *     (arxiv.org/abs/2201.11903) — Wei et al., 2022
 *
 * The default path (Chain of Thought strategy) implements a standard ReAct
 * loop: single-pass sequential reasoning per iteration. While named after
 * CoT prompting, it relies on the model's native reasoning rather than
 * injecting few-shot exemplar chains.
 *
 * Thought structures (dispatched at run()):
 *   - Chain of Thought (default): single-pass sequential reasoning per iteration
 *   - Tree of Thoughts: parallel branching, multi-criteria scoring, reflexion backtracking
 *   - Graph of Thoughts: parallel branching, scoring, synthesis/aggregation
 *
 * See ThoughtStructureRegistry.ts → THOUGHT_STRUCTURE_DEFINITIONS
 * for full paper-alignment metadata and config option documentation.
 *
 * Control flow (Chain of Thought):
 *   1. Stream LLM response (Reason)
 *   2. If tool calls: execute → append results → loop (Act → Observe)
 *   3. If text only (and not plan mode): break → finalize
 *   4. Exhaustion recovery pass if iteration limit hit
 *
 * Supports:
 *   - Plan mode (planFirst / enter_plan_mode / exit_plan_mode)
 *   - Auto-approval engine
 *   - Orchestrator (multi-agent) sub-agent tracking
 *   - Streaming tool output (shell, python, js)
 *
 * Lifecycle phases are delegated to composable modules in ./lifecycle/
 * so future harnesses can reuse individual phases without inheriting
 * the entire ReActHarness.
 */
export default class ReActHarness extends BaseAgenticHarness {
  static id = "standard";
  static label = "ReAct Loop";
  static description =
    "Reason→Act→Observe tool-use loop with plan mode, approval gating, and exhaustion recovery.";

  async run(): Promise<{ messages: ConversationMessage[] }> {
    // ── Strategy dispatch ──────────────────────────────────
    const resolvedStructure = this.context.options.thoughtStructure;
    if (resolvedStructure === THOUGHT_STRUCTURES.TREE_OF_THOUGHTS) {
      logger.info(
        `[ReActHarness] Delegating to Tree of Thoughts thought structure`,
      );
      return runTreeOfThoughts(this);
    }
    if (resolvedStructure === THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS) {
      logger.info(
        `[ReActHarness] Delegating to Graph of Thoughts thought structure`,
      );
      return runGraphOfThoughts(this);
    }

    const context = this.context;
    const state = this.state;
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

    // ── Resolve max iterations ────────────────────────────────
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

    // ── Initialize lifecycle hooks ──────────────────────────
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

    // ── Main loop ────────────────────────────────────────────
    // Wrapped in try/catch to persist accumulated messages on error.
    // Without this, a provider timeout mid-loop leaves the conversation
    // document as an empty stub (messages: []) in MongoDB — the
    // "disappearing messages" bug.
    try {
      while (state.iterations < resolvedMaxIterations) {
        state.iterations++;

        emit({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.ITERATION_PROGRESS,
          iteration: state.iterations,
          maxIterations: resolvedMaxIterations,
        });

        // ── Instruction fade-out countermeasure ─────────────────
        await maybeInjectSystemReminder(
          currentMessages,
          state,
          context,
        );

        // ── beforePrompt hook (iteration 1 only) ──────────────
        if (state.iterations === 1) {
          const hookContext: BeforePromptHookContext = {
            messages: currentMessages,
            project,
            username,
            agent,
            traceId,
            agentConversationId,
            agentContext: options.agentContext,
            enabledTools: this.tools.resolvedEnabledTools,
            resolvedToolNames: this.tools.finalTools.map(
              (tool: ToolSchema) => tool.name,
            ),
            workspaceRoot: workspaceRoot || undefined,
            workspaceEnabled: options.workspaceEnabled as boolean | undefined,
          };
          await hooks.run("beforePrompt", hookContext);

          // ── Persist assembled system prompt to conversationMeta ──
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

          if (state.planModeActive) {
            PlanningModeService.injectPlanningInstruction(currentMessages);
          }
        }

        // ── Build pass options ─────────────────────────────────
        const passOptions: IterationPassOptions = {
          ...options,
          project,
          agent,
          username,
        };
        if (state.planModeActive) {
          const planModeTools = this.tools.finalTools.filter(
            (tool: ToolSchema) => tool.name === TOOL_NAMES.EXIT_PLAN_MODE,
          );
          passOptions.tools = planModeTools;
          logger.info(
            `[PlanningMode] Sending ${planModeTools.length} tools to provider: ${planModeTools.map((tool: ToolSchema) => tool.name).join(", ")}`,
          );
        } else {
          passOptions.tools = this.tools.finalTools;
        }

        const resolvedPassTools = passOptions.tools || [];
        const allowedToolNames = new Set(
          resolvedPassTools.map((tool: ToolSchema) => tool.name),
        );

        // ── Context pressure management ──────────────────────────
        // Micro-compaction (pressure-gated) → auto-compaction → summary persistence
        const pressureResult = await manageContextPressure(
          currentMessages,
          context,
          state,
          "ReActHarness",
        );
        currentMessages = pressureResult.messages;

        // ── Context window enforcement ─────────────────────────
        currentMessages = this.enforceContextWindow(
          currentMessages,
          this.tools.finalTools.length,
        );

        // ── Create per-iteration pass state ────────────────────
        const pass = this.createPassState(passOptions);
        const requestIdBase =
          context.requestId || agentConversationId || crypto.randomUUID();
        const passRequestId = `${requestIdBase}-iter-${state.iterations}`;
        pass.requestId = passRequestId;

        this.registerTrackerRequest(passRequestId);

        // ── Stream LLM response ────────────────────────────────
        const stream = this.createProviderStream(currentMessages, passOptions);
        await this.consumeStream(stream, pass, allowedToolNames);

        // ── Finalize tracker for this pass ─────────────────────
        finalizePassTracker(pass, passRequestId);
        logKVCacheHitRate(pass.usage, state.iterations, "ReActHarness");
        this.emitGenerationProgress();

        if (signal?.aborted) break;

        this.emitUsageUpdate();

        // ── Cost budget enforcement ────────────────────────────
        if (checkCostBudget(state, context.resolvedModel, options.maxCostDollars, emit)) {
          break;
        }

        // ── Tool execution ─────────────────────────────────────
        if (pass.pendingToolCalls.length > 0) {
          // Plan mode enforcement
          if (state.planModeActive) {
            const { allBlocked } = blockUnauthorizedToolCalls(
              pass.pendingToolCalls,
              currentMessages,
              pass,
              state,
            );
            if (allBlocked) {
              this.logIteration(pass, currentMessages);
              continue;
            }
          }

          // ── Approval gating ───────────────────────────────────
          const { isApproved, shouldApproveAll } =
            await checkAndWaitForApproval(
              pass.pendingToolCalls,
              context,
              approvalEngine,
            );

          let results: ToolResult[] = [];
          let sandboxCheckpointReference: string | null = null;
          if (!isApproved) {
            results = pass.pendingToolCalls.map((toolCall) => ({
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

            // ── Execute tools in parallel ─────────────────────────
            // Attach currentMessages to context so ToolExecutor can pass them
            // to tools-api (needed by tools like generate_image that inspect conversation)
            context._currentMessages = currentMessages;

            // ── Sandbox checkpoint (git-based rollback) ────────────
            sandboxCheckpointReference = options.enableSandbox
              ? createSandboxCheckpoint(workspaceRoot, emit)
              : null;

            results = await executeToolBatch(
              pass.pendingToolCalls,
              context,
              this.tools,
              hooks,
              state,
            );
          }

          // ── Post-execution: media, errors, status ─────────────
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

          // ── Validation intercept (linter auto-remediation) ──────
          // Must run BEFORE plan mode toggling — no point entering plan
          // mode if validation will inject error feedback and continue.
          const validationFeedback = await validateAfterToolExecution(
            pass.pendingToolCalls,
            results,
            context,
            state,
          );

          if (validationFeedback.length > 0) {
            const errorBlock = validationFeedback
              .map(
                (feedback) =>
                  `### ${feedback.filePath} (${feedback.validatorType})\n${feedback.rawOutput}`,
              )
              .join("\n\n");

            currentMessages.push({
              role: "assistant",
              content: pass.streamedText || "",
              ...(pass.streamedThinking.trim() && {
                thinking: pass.streamedThinking.trim(),
              }),
              ...(pass.thinkingSignature && {
                thinkingSignature: pass.thinkingSignature,
              }),
              toolCalls: pass.pendingToolCalls.map((toolCall: ToolCall) => {
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
              }),
            });

            // Restore sandbox checkpoint on validation failure
            if (sandboxCheckpointReference) {
              restoreSandboxCheckpoint(workspaceRoot, sandboxCheckpointReference, emit);
            }

            currentMessages.push({
              role: "system",
              content:
                `[VALIDATION ERROR] Your recent edit(s) introduced ${validationFeedback.length} error(s):\n\n` +
                `${errorBlock}\n\n` +
                `Before fixing, ANALYZE what went wrong:\n` +
                `1. What assumption in your approach caused the failure?\n` +
                `2. What is fundamentally different about a correct solution?\n` +
                `3. What specific change would avoid this class of error?\n\n` +
                `Apply your analysis and fix these issues before proceeding. Do not move on to other tasks until validation passes.`,
            });

            emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: STATUS_MESSAGES.VALIDATION_ERRORS_DETECTED,
              count: validationFeedback.length,
            });
            this.logIteration(pass, currentMessages);
            continue;
          }

          // ── Plan mode toggling ────────────────────────────────
          checkForPlanModeEntry(
            pass.pendingToolCalls,
            currentMessages,
            state,
            emit,
          );

          const exitPlanToolCall = pass.pendingToolCalls.find(
            (toolCall) => toolCall.name === TOOL_NAMES.EXIT_PLAN_MODE,
          );
          if (exitPlanToolCall) {
            const { shouldContinueLoop } = await handleExitPlanMode(
              exitPlanToolCall,
              pass,
              results,
              currentMessages,
              context,
              state,
            );
            if (!shouldContinueLoop) return { messages: currentMessages };
          }

          // ── Append to context for next pass ───────────────────
          const assistantMessage: ConversationMessage = {
            role: "assistant",
            content: pass.streamedText || "",
            ...(pass.streamedThinking.trim() && {
              thinking: pass.streamedThinking.trim(),
            }),
            ...(pass.thinkingSignature && {
              thinkingSignature: pass.thinkingSignature,
            }),
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
                durationMs: matchingResult?.durationMs,
              };
            }),
          };
          currentMessages.push(assistantMessage);

          // ── Structured retry guidance on tool failure ──────────
          // When tool calls fail, inject a system message prompting the
          // model to analyze which arguments caused the failure and retry
          // with corrections (Fission-GRPO pattern, arXiv 2026).
          const retryGuidanceMessage = buildToolRetryGuidance(
            pass.pendingToolCalls,
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
            pass.pendingToolCalls,
            results,
            currentMessages,
            context,
          );

          this.checkAndApplyToolSetChanges(currentMessages);

          this.logIteration(pass, currentMessages);
          continue;
        }

        // ── No tools — check if we should break ─────────────────
        if (pass.streamedText || pass.streamedThinking.trim()) {
          if (state.planModeActive) {
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
            this.logIteration(pass, currentMessages);
            continue;
          }

          // Handle Codex/planning models that separate planning and action
          const codexResult = handleCodexPlanningResponse(
            pass,
            currentMessages,
            context,
            state,
            this.tools.finalTools,
            "ReActHarness",
          );
          if (codexResult.shouldContinueLoop) {
            this.logIteration(pass, currentMessages);
            continue;
          }

          this.logIteration(pass, currentMessages);
          hasCleanTextBreak = true;
          break;
        }

        // ── Empty output — check for truncation recovery ─────────
        if (isOutputTruncated(pass)) {
          truncationRecoveryCount++;
          const configuredMaxTokens = context.options.maxTokens || "default";
          logger.warn(
            `[AgenticLoop] Max tokens truncation detected on iteration ${state.iterations} — ` +
              `stopReason=${pass.stopReason}, maxTokens=${configuredMaxTokens}. ` +
              `Recovery attempt ${truncationRecoveryCount}/${MAX_OUTPUT_TRUNCATION_RECOVERIES}.`,
          );

          if (truncationRecoveryCount <= MAX_OUTPUT_TRUNCATION_RECOVERIES) {
            const escalatedMaxTokens = injectContinuationContext(
              currentMessages,
              pass,
              context,
              truncationRecoveryCount,
            );
            context.options.maxTokens = escalatedMaxTokens;
            this.logIteration(pass, currentMessages);
            continue;
          }

          // All recovery attempts exhausted — inject error as conversation context
          const exhaustionMessage = buildExhaustedRecoveryMessage(
            MAX_OUTPUT_TRUNCATION_RECOVERIES,
            configuredMaxTokens,
          );
          injectErrorAsConversationMessage(
            currentMessages,
            exhaustionMessage,
            context,
          );
          this.logIteration(pass, currentMessages);
          break;
        }

        // Genuinely empty output (not truncation)
        logger.warn(
          `[AgenticLoop] Empty model output on iteration ${state.iterations} — ` +
            `text=${pass.streamedText.length}, thinking=${pass.streamedThinking.length}, ` +
            `toolCalls=${pass.pendingToolCalls.length}. Breaking.`,
        );
        this.logIteration(pass, currentMessages);
        break;
      }

      // ── Exhaustion Recovery Pass ─────────────────────────────
      // Triggers when the agent used tools but never produced a clean text-only
      // break — regardless of how the loop exited (max iterations, empty output,
      // truncation exhaustion). In all these cases, state.finalStreamedText
      // contains stale per-pass planning text ("Let me search for...") instead
      // of a synthesized final summary.
      // Skipped when signal is aborted (provider would reject the call).
      if (
        !hasCleanTextBreak &&
        state.streamedToolCalls.length > 0 &&
        !signal?.aborted
      ) {
        state.conversationOutcome = "exhausted";
        await runExhaustionRecoveryPass(this, context, state, currentMessages);
      }

      // ── Finalization (happy path) ──────────────────────────────
      cleanupReminderCache(agentConversationId);
      await this.finalize(currentMessages, hooks);
      return { messages: currentMessages };
    } catch (loopError: unknown) {
      // ── Error-path persistence ─────────────────────────────
      // Persist whatever messages accumulated before the error so
      // the conversation isn't left as an empty stub in MongoDB.
      // Also inject the error as a conversation message so the LLM
      // has context about the failure on the next turn.
      logger.error(
        `[ReActHarness] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
      );

      injectErrorAsConversationMessage(
        currentMessages,
        buildProviderErrorMessage(loopError, state.iterations),
        context,
      );

      state.conversationOutcome = "error";

      try {
        await this.finalize(currentMessages, hooks);
      } catch (persistError: unknown) {
        logger.error(
          `[ReActHarness] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
        );
      }
      throw loopError;
    }
  }
}
