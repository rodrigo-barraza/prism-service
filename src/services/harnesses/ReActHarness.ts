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
import {
  blockUnauthorizedToolCalls,
  handleExitPlanMode,
  checkForPlanModeEntry,
} from "./lifecycle/PlanModeController.ts";
import { validateAfterToolExecution } from "./lifecycle/ValidationInterceptor.ts";

import PlanningModeService from "../PlanningModeService.ts";
import SessionGenerationTracker from "../SessionGenerationTracker.ts";
import AutoCompactionTrigger from "../compact/AutoCompactionTrigger.ts";
import CompactionService from "../compact/CompactionService.ts";
import ContextWindowManager from "../../utils/ContextWindowManager.ts";

import type { ConversationMessage, ToolCall, ToolSchema, ToolResult } from "./types.ts";

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
 *   - Coordinator (multi-agent) worker tracking
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

    // ── Resolve max iterations ────────────────────────────────
    const clientMaxIterations = options.maxIterations;
    const resolvedMaxIterations =
      clientMaxIterations === 0
        ? Infinity
        : clientMaxIterations
          ? Math.min(100, Math.max(1, clientMaxIterations))
          : MAX_TOOL_ITERATIONS;

    let currentMessages: ConversationMessage[] = [...context.messages];

    // ── Initialize lifecycle hooks ──────────────────────────
    const { hooks, approvalEngine } = createStandardHooks({
      workspaceRoot: workspaceRoot || undefined,
      autoApprove: options.autoApprove === true,
      policies: options.policies,
      enableCriticGate: options.enableCriticGate === true,
      criticModel: options.criticModel || undefined,
    });

    if (options.planFirst) {
      emit({ type: SSE_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.PLAN_MODE_ENTERED });
    }

    // ── Main loop ────────────────────────────────────────────
    while (state.iterations < resolvedMaxIterations) {
      state.iterations++;

      emit({
        type: SSE_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.ITERATION_PROGRESS,
        iteration: state.iterations,
        maxIterations: resolvedMaxIterations,
      });

      // ── beforePrompt hook (iteration 1 only) ──────────────
      if (state.iterations === 1) {
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

        // ── Persist assembled system prompt to conversationMeta ──
        // SystemPromptAssembler prepends the system message at runtime
        // but never stores it on the conversation doc. Extract it here
        // so the Finalizer persists it for the admin chat viewer.
        const assembledSystemMsg = currentMessages.find(
          (m) => m.role === "system",
        );
        if (assembledSystemMsg?.content) {
          context.conversationMeta = {
            ...(context.conversationMeta || {}),
            systemPrompt: assembledSystemMsg.content,
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

        if (state.planModeActive) {
          PlanningModeService.injectPlanningInstruction(currentMessages);
        }
      }

      // ── Build pass options ─────────────────────────────────
      const passOptions: Record<string, unknown> = {
        ...options,
        project,
        agent,
        username,
      };
      if (state.planModeActive) {
        passOptions.tools = this.tools.finalTools.filter(
          (tool: ToolSchema) => tool.name === "exit_plan_mode",
        );
        logger.info(
          `[PlanningMode] Sending ${(passOptions.tools as ToolSchema[]).length} tools to provider: ${(passOptions.tools as ToolSchema[]).map((tool: ToolSchema) => tool.name).join(", ")}`,
        );
      } else {
        passOptions.tools = this.tools.finalTools;
      }

      const allowedToolNames = new Set(
        ((passOptions.tools as ToolSchema[]) || []).map((tool: ToolSchema) => tool.name),
      );

      // ── Auto-compaction trigger ─────────────────────────────
      // Before mechanical truncation, check if we should run LLM-powered
      // compaction. This produces an intelligent summary instead of
      // just dropping messages. Modeled after Claude Code's autoCompact.ts.
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
          // Recalculate originalMessageCount to match the compacted array
          // so finalize() only persists new messages from this point on.
          state.originalMessageCount = currentMessages.length;
          state.compactionPerformed = true;
          state.preCompactTokenCount = compactionResult.preCompactTokenCount;
          state.postCompactTokenCount = compactionResult.postCompactTokenCount;

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
      const passRequestId = `${context.requestId || agentSessionId}-iter-${state.iterations}`;
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

      emit({
        type: SSE_EVENT_TYPES.USAGE_UPDATE,
        usage: { ...state.overallUsage, requests: state.iterations },
      });

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
        const { approved, approveAll } = await checkAndWaitForApproval(
          pass.pendingToolCalls,
          context,
          approvalEngine,
        );

        let results: ToolResult[] = [];
        if (!approved) {
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
          if (approveAll) {
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
        );

        trackToolErrors(
          pass.pendingToolCalls,
          results,
          state,
          MAX_CONSECUTIVE_TOOL_ERRORS,
          emit,
        );

        emitPostExecutionStatus(pass.pendingToolCalls, emit);

        // ── Hot-reload custom tools mid-session ──────────────
        await reloadIfCustomToolsMutated(
          pass.pendingToolCalls,
          this.tools,
          project,
          username,
          emit,
        );

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
            ...(pass.streamedThinking && { thinking: pass.streamedThinking }),
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
              };
            }),
          });

          currentMessages.push({
            role: "user",
            content:
              `[VALIDATION ERROR] Your recent edit(s) introduced ${validationFeedback.length} error(s):\n\n` +
              `${errorBlock}\n\n` +
              `Fix these issues before proceeding. Do not move on to other tasks until validation passes.`,
          });

          emit({
            type: SSE_EVENT_TYPES.STATUS,
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
          (toolCall) => toolCall.name === "exit_plan_mode",
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
          ...(pass.streamedThinking && { thinking: pass.streamedThinking }),
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
        this.logIteration(pass, currentMessages);
        continue;
      }

      // ── No tools — check if we should break ─────────────────
      if (pass.streamedText || pass.streamedThinking) {
        if (state.planModeActive) {
          currentMessages.push({
            role: "assistant",
            content: pass.streamedText,
            ...(pass.streamedThinking && { thinking: pass.streamedThinking }),
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
            lastMessage.role === "user" &&
            typeof lastMessage.content === "string" &&
            lastMessage.content.includes("If you have fully completed");

          if (!isAlreadyPrompted) {
            logger.info(
              `[ReActHarness] Codex model planning/update detected in iteration ${state.iterations}. Continuing to action phase.`,
            );
            currentMessages.push({
              role: "assistant",
              content: pass.streamedText,
              ...(pass.streamedThinking && { thinking: pass.streamedThinking }),
            });
            currentMessages.push({
              role: "user",
              content: "[System Context: Please proceed with the next step using the appropriate tools to implement your plan. If you have fully completed the user's request, please output a final message stating that you are done without calling any tools.]",
            });
            this.logIteration(pass, currentMessages);
            continue;
          }
        }

        this.logIteration(pass, currentMessages);
        break;
      }

      // ── Empty output — break ────────────────────────────────
      logger.warn(
        `[AgenticLoop] Empty model output on iteration ${state.iterations} — ` +
          `text=${pass.streamedText.length}, thinking=${pass.streamedThinking.length}, ` +
          `toolCalls=${pass.pendingToolCalls.length}. Breaking.`,
      );
      this.logIteration(pass, currentMessages);
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

    // ── Finalization ─────────────────────────────────────────
    await this.finalize(currentMessages, hooks);
    return { messages: currentMessages };
  }
}
