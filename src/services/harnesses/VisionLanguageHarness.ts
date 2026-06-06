import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import logger from "../../utils/logger.ts";
import { SSE_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";
import LiveFrameService from "../LiveFrameService.ts";

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

import type { ConversationMessage, ToolCall, ToolSchema, ToolResult } from "./types.ts";

const MAX_TOOL_ITERATIONS = 25;
const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

/**
 * VisionLanguageHarness — Reason→Act→Observe tool-use loop with live webcam/video streaming.
 *
 * Control flow:
 *   1. Inject live camera frames rolling buffer into the last user message.
 *   2. Stream LLM response (Reason)
 *   3. If tool calls: execute → append results → loop (Act → Observe)
 *   4. If text only: break → finalize
 */
export default class VisionLanguageHarness extends BaseAgenticHarness {
  static id = "vision_language";
  static label = "Vision-Language Harness";
  static description =
    "Reason→Act→Observe tool-use loop with real-time rolling webcam/screen streaming injection.";

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

    // ── Inject live vision system instruction ─────────────────
    const systemMessage = currentMessages.find((message) => message.role === "system");
    const visionInstruction = `

## 🎥 LIVE VISION FEED ACTIVE
You are equipped with a live visual feed (webcam or screen stream). The last 3 frames of this feed are automatically captured and attached to the user's latest message (ordered from oldest to newest).
Use these images to observe the environment, notice changes, animations, or user gestures, and refer to them naturally in your conversation.
`;
    if (systemMessage) {
      if (!systemMessage.content?.includes("LIVE VISION FEED ACTIVE")) {
        systemMessage.content = (systemMessage.content || "") + visionInstruction;
      }
    } else {
      currentMessages.unshift({
        role: "system",
        content: visionInstruction.trim(),
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
        const assembledSystemMessage = currentMessages.find(
          (message) => message.role === "system",
        );
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

          logger.info(
            `[VisionLanguageHarness] Auto-compacted: ${compactionResult.preCompactTokenCount} → ` +
              `${compactionResult.postCompactTokenCount} tokens ` +
              `(${currentMessages.length} messages remain)`,
          );
        }
      }

      // ── Live Vision Frame Injection ────────────────────────
      const liveFrames = LiveFrameService.getFrames(context.conversationId);
      if (liveFrames && liveFrames.length > 0) {
        const lastUserMessage = [...currentMessages]
          .reverse()
          .find((message) => message.role === "user");
        if (lastUserMessage) {
          if (!lastUserMessage.images) {
            lastUserMessage.images = [];
          }
          lastUserMessage.images = [...liveFrames];
          logger.info(
            `[VisionLanguageHarness] Injected ${liveFrames.length} live frames into last user message for session ${agentSessionId}`,
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
                durationMs: matchingResult?.durationMs,
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
        this.logIteration(pass, currentMessages);
        break;
      }

      // ── Empty output — check for truncation recovery ─────────
      if (isOutputTruncated(pass)) {
        truncationRecoveryCount++;
        const configuredMaxTokens = context.options.maxTokens || "default";
        logger.warn(
          `[VisionLanguageHarness] Max tokens truncation detected on iteration ${state.iterations} — ` +
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

        const exhaustionMessage = buildExhaustedRecoveryMessage(
          MAX_OUTPUT_TRUNCATION_RECOVERIES,
          configuredMaxTokens,
        );
        injectErrorAsConversationMessage(currentMessages, exhaustionMessage, context);
        this.logIteration(pass, currentMessages);
        break;
      }

      logger.warn(
        `[VisionLanguageHarness] Empty model output on iteration ${state.iterations} — ` +
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

    // ── Finalization (happy path) ──────────────────────────────
    await this.finalize(currentMessages, hooks);
    return { messages: currentMessages };

    } catch (loopError: unknown) {
      logger.error(
        `[VisionLanguageHarness] Loop error on iteration ${state.iterations}: ${loopError instanceof Error ? loopError.message : String(loopError)}. Persisting ${currentMessages.length - state.originalMessageCount} accumulated message(s).`,
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
          `[VisionLanguageHarness] Failed to persist messages on error path: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
        );
      }
      throw loopError;
    }
  }
}
