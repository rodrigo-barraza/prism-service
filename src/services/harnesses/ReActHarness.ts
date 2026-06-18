import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import logger from "../../utils/logger.ts";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES, TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import ToolContext from "../ToolContext.ts";
import ConversationEmbeddingService from "../ConversationEmbeddingService.ts";

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
import {
  isOutputTruncated,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  buildProviderErrorMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "./lifecycle/OutputTruncationRecovery.ts";

import PlanningModeService from "../PlanningModeService.ts";
import SessionGenerationTracker from "../SessionGenerationTracker.ts";
import AutoCompactionTrigger from "../compact/AutoCompactionTrigger.ts";
import CompactionService from "../compact/CompactionService.ts";
import ContextWindowManager from "../../utils/ContextWindowManager.ts";

import type { ChatMessage } from "../../types/admin.ts";
import type { ConversationMessage, ToolCall, ToolSchema, ToolResult, AgenticOptions } from "./types.ts";

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
  agentSessionId: string;
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
 * ReActHarness — Reason→Act→Observe tool-use loop.
 *
 * Based on the ReAct pattern (Yao et al., 2022).
 *
 * Control flow:
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
      emit({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.PLAN_MODE_ENTERED });
    }

    // ── Main loop ────────────────────────────────────────────
    // Wrapped in try/catch to persist accumulated messages on error.
    // Without this, a provider timeout mid-loop leaves the session
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

      // ── beforePrompt hook (iteration 1 only) ──────────────
      if (state.iterations === 1) {
        const hookContext: BeforePromptHookContext = {
          messages: currentMessages,
          project,
          username,
          agent,
          traceId,
          agentSessionId,
          agentContext: options.agentContext,
          enabledTools: this.tools.resolvedEnabledTools,
          resolvedToolNames: this.tools.finalTools.map((tool: ToolSchema) => tool.name),
          workspaceRoot: workspaceRoot || undefined,
        };
        await hooks.run("beforePrompt", hookContext);

        // ── Persist assembled system prompt to conversationMeta ──
        const assembledSystemMessage =
          currentMessages.find(
            (message) => message.role === "system" && message._isIdentityPrompt === true,
          ) ||
          currentMessages.find((message) => message.role === "system");
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

      // ── Auto-compaction trigger ─────────────────────────────
      // Before mechanical truncation, check if we should run LLM-powered
      // compaction. This produces an intelligent summary instead of
      // just dropping messages. Modeled after Claude Code's autoCompact.ts.
      const contextWindowSize = context.modelDefinition?.maxInputTokens || 128_000;
      const maxOutputTokens = options.maxTokens || 8192;
      const preEnforceTokenEstimate = ContextWindowManager.estimateTokens(
        currentMessages as ChatMessage[],
      );

      const autoCompactEvaluation = AutoCompactionTrigger.evaluate(
        preEnforceTokenEstimate,
        contextWindowSize,
        maxOutputTokens,
        currentMessages.length,
      );

      if (autoCompactEvaluation.shouldCompact) {
        const compactionResult = await CompactionService.compactConversation(
          currentMessages as ChatMessage[],
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
          // Recalculate originalMessageCount to match the compacted array
          // so finalize() only persists new messages from this point on.
          state.originalMessageCount = currentMessages.length;
          state.compactionPerformed = true;
          state.preCompactTokenCount = compactionResult.preCompactTokenCount;
          state.postCompactTokenCount = compactionResult.postCompactTokenCount;

          // Persist compaction summary on the conversation document (fire-and-forget).
          // ConversationEmbeddingService will use this as a free embedding source
          // during afterResponse — no additional LLM call needed.
          if (compactionResult.summaryText && context.conversationId) {
            ConversationEmbeddingService.persistCompactionSummary(
              context.conversationId,
              project || "",
              username || "",
              compactionResult.summaryText,
            ).catch((error: unknown) =>
              logger.error(
                `[ReActHarness] Failed to persist compaction summary: ${errorMessage(error)}`,
              ),
            );
          }

          logger.info(
            `[ReActHarness] Auto-compacted: ${compactionResult.preCompactTokenCount} → ` +
              `${compactionResult.postCompactTokenCount} tokens ` +
              `(${currentMessages.length} messages remain)`,
          );
        }
      }

      // ── Context window enforcement ─────────────────────────
      currentMessages = this.enforceContextWindow(
        currentMessages,
        this.tools.finalTools.length,
      );

      // ── Create per-iteration pass state ────────────────────
      const pass = this.createPassState(passOptions);
      const requestIdBase = context.requestId || agentSessionId || crypto.randomUUID();
      const passRequestId = `${requestIdBase}-iter-${state.iterations}`;
      pass.requestId = passRequestId;

      this.registerTrackerRequest(passRequestId);

      // ── Stream LLM response ────────────────────────────────
      const stream = this.createProviderStream(currentMessages, passOptions);
      await this.consumeStream(stream, pass, allowedToolNames);

      // ── Finalize tracker for this pass ─────────────────────
      if (pass.usage.outputTokens > 0) {
        SessionGenerationTracker.update(passRequestId, {
          outputTokens: pass.usage.outputTokens,
        });
      }
      const finalInputTokens =
        pass.usage.inputTokens || pass.usage.promptTokens || 0;
      if (finalInputTokens > 0) {
        SessionGenerationTracker.update(passRequestId, {
          inputTokens: finalInputTokens,
        });
      }
      this.emitGenerationProgress();
      SessionGenerationTracker.complete(passRequestId);

      if (signal?.aborted) break;

      this.emitUsageUpdate();

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
        const { isApproved, shouldApproveAll } = await checkAndWaitForApproval(
          pass.pendingToolCalls,
          context,
          approvalEngine,
        );

        let results: ToolResult[] = [];
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
            ...(pass.streamedThinking.trim() && { thinking: pass.streamedThinking.trim() }),
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

          currentMessages.push({
            role: "system",
            content:
              `[VALIDATION ERROR] Your recent edit(s) introduced ${validationFeedback.length} error(s):\n\n` +
              `${errorBlock}\n\n` +
              `Fix these issues before proceeding. Do not move on to other tasks until validation passes.`,
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
          ...(pass.streamedThinking.trim() && { thinking: pass.streamedThinking.trim() }),
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

        currentMessages = currentMessages.filter(
          (message) =>
            !(
              message.role === "assistant" &&
              !message.content?.trim() &&
              (!message.toolCalls || message.toolCalls.length === 0)
            ),
        );

        // ── Post-search nudge for tool discovery chain ─────────
        // When search_tools returns results with disabled tools, inject
        // an explicit instruction so weaker models don't stall after
        // the search step. For lower-tier models (nano/mini/flash/haiku/lite),
        // auto-enable the tools directly via ToolContext — the subsequent
        // checkAndApplyToolSetChanges() call picks up the dirty flag.
        for (const toolCall of pass.pendingToolCalls) {
          if (toolCall.name !== TOOL_NAMES.SEARCH_TOOLS) continue;
          const matchingResult = results.find(
            (result) => result.id === toolCall.id,
          );
          const toolResultData = matchingResult?.result as Record<string, unknown> | undefined;
          const searchMatches = toolResultData?.matches as Array<{ name?: string; isEnabled?: boolean }> | undefined;
          if (!Array.isArray(searchMatches)) continue;

          const disabledToolNames = searchMatches
            .filter((matchEntry) => matchEntry.isEnabled === false)
            .map((matchEntry) => matchEntry.name)
            .filter(Boolean) as string[];

          if (disabledToolNames.length === 0) continue;

          // Heuristic: models with nano/mini/flash/haiku/lite in the name
          // are lower-tier and benefit from auto-enable (skip the enable_tools step)
          const modelNameLower = (context.resolvedModel || "").toLowerCase();
          const isLowerTierModel = /\b(nano|mini|flash|haiku|lite)\b/.test(modelNameLower);

          if (isLowerTierModel) {
            const sessionId = context.agentSessionId;
            const toolContextStore = ToolContext.getStore(sessionId);
            const currentDynamic = (toolContextStore.get("dynamicEnabledTools") as string[]) || [];
            const mergedSet = new Set(currentDynamic);
            for (const name of disabledToolNames) mergedSet.add(name);
            toolContextStore.set("dynamicEnabledTools", [...mergedSet]);
            toolContextStore.set("toolSetDirty", true);

            currentMessages.push({
              role: "system",
              content:
                `<tool-update>\n` +
                `Your search found ${disabledToolNames.length} tool(s): ` +
                `${disabledToolNames.join(", ")}. ` +
                `They have been automatically enabled and are available now — call them directly.` +
                `\n</tool-update>`,
            });
            logger.info(
              `[ReActHarness] Auto-enabled ${disabledToolNames.length} tools for lower-tier model "${context.resolvedModel}": [${disabledToolNames.join(", ")}]`,
            );
          } else {
            currentMessages.push({
              role: "system",
              content:
                `<tool-update>\n` +
                `Your search found ${disabledToolNames.length} tool(s) that are not yet enabled: ` +
                `${disabledToolNames.join(", ")}. ` +
                `To use them, call enable_tools with these tool names now. ` +
                `After enabling, you can call them on the next iteration.` +
                `\n</tool-update>`,
            });
            logger.info(
              `[ReActHarness] Injected post-search nudge for ${disabledToolNames.length} disabled tools: [${disabledToolNames.join(", ")}]`,
            );
          }
        }

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
            ...(pass.streamedThinking.trim() && { thinking: pass.streamedThinking.trim() }),
            ...(pass.thinkingSignature && {
              thinkingSignature: pass.thinkingSignature,
            }),
          });
          this.logIteration(pass, currentMessages);
          continue;
        }

        // Handle Codex/planning models that separate planning and action in multi-turn agentic flows
        const isCodexModel = context.resolvedModel?.toLowerCase().includes("codex");
        const hasToolsAvailable = this.tools.finalTools && this.tools.finalTools.length > 0;
        if (isCodexModel && hasToolsAvailable) {
          const lastMessage = currentMessages[currentMessages.length - 1];
          const isAlreadyPrompted =
            lastMessage &&
            lastMessage.role === "system" &&
            typeof lastMessage.content === "string" &&
            lastMessage.content.includes("If you have fully completed");

          if (!isAlreadyPrompted) {
            logger.info(
              `[ReActHarness] Codex model planning/update detected in iteration ${state.iterations}. Continuing to action phase.`,
            );
            currentMessages.push({
              role: "assistant",
              content: pass.streamedText,
              ...(pass.streamedThinking.trim() && { thinking: pass.streamedThinking.trim() }),
            });
            currentMessages.push({
              role: "system",
              content: "Please proceed with the next step using the appropriate tools to implement your plan. If you have fully completed the user's request, please output a final message stating that you are done without calling any tools.",
            });
            this.logIteration(pass, currentMessages);
            continue;
          }
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
        injectErrorAsConversationMessage(currentMessages, exhaustionMessage, context);
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
    if (!hasCleanTextBreak && state.streamedToolCalls.length > 0 && !signal?.aborted) {
      await runExhaustionRecoveryPass(this, context, state, currentMessages);
    }

    // ── Finalization (happy path) ──────────────────────────────
    await this.finalize(currentMessages, hooks);
    return { messages: currentMessages };

    } catch (loopError: unknown) {
      // ── Error-path persistence ─────────────────────────────
      // Persist whatever messages accumulated before the error so
      // the session isn't left as an empty stub in MongoDB.
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
