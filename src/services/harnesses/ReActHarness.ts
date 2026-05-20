import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import logger from "../../utils/logger.ts";

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

import PlanningModeService from "../PlanningModeService.ts";
import SessionGenerationTracker from "../SessionGenerationTracker.ts";

import type { ConversationMessage, ToolSchema } from "./types.ts";

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
    });

    if (options.planFirst) {
      emit({ type: "status", message: "plan_mode_entered" });
    }

    // ── Main loop ────────────────────────────────────────────
    while (state.iterations < resolvedMaxIterations) {
      state.iterations++;

      emit({
        type: "status",
        message: "iteration_progress",
        iteration: state.iterations,
        maxIterations: resolvedMaxIterations,
      });

      // ── beforePrompt hook (iteration 1 only) ──────────────
      if (state.iterations === 1) {
        // @ts-ignore - TODO: strict typing
        interface HookContextType extends any {
          _injectedSkills?: any[];
        }
        const hookContext: HookContextType = {
          // @ts-ignore - TODO: strict typing
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
                await hooks.run(("beforePrompt" as any), (hookContext as any));

        if (
          Array.isArray(hookContext._injectedSkills) &&
          hookContext._injectedSkills.length > 0
        ) {
          emit({
            type: "status",
            message: "skills_injected",
            skills: hookContext._injectedSkills,
          });
        }

        if (state.planModeActive) {
                    PlanningModeService.injectPlanningInstruction((currentMessages as any));
        }
      }

      // ── Build pass options ─────────────────────────────────
      const passOptions: any = {
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
          `[PlanningMode] Sending ${(passOptions.tools as ToolSchema[]).length} tools to provider: ${(passOptions.tools as ToolSchema[]).map((tool: any) => (tool as any).name).join(", ")}`,
        );
      } else {
        passOptions.tools = this.tools.finalTools;
      }

      const allowedToolNames = new Set(
        ((passOptions.tools as ToolSchema[]) || []).map((tool: any) => (tool as any).name),
      );

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
      await this.consumeStream(stream, pass, (allowedToolNames as any as Set<string>));

      // ── Finalize tracker for this pass ─────────────────────
      if (pass.usage.outputTokens > 0) {
                (SessionGenerationTracker as any).update((passRequestId as any), {
          outputTokens: pass.usage.outputTokens,
        });
      }
      const finalInputTokens =
        pass.usage.inputTokens || pass.usage.promptTokens || 0;
      if (finalInputTokens > 0) {
                (SessionGenerationTracker as any).update((passRequestId as any), {
          inputTokens: finalInputTokens,
        });
      }
      this.emitGenerationProgress();
            (SessionGenerationTracker as any).complete((passRequestId as any));

      if (signal?.aborted) break;

      emit({
        type: "usage_update",
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

        if (!approved) {
          this.logIteration(pass, currentMessages);
          break;
        }

        if (approveAll) {
          options.autoApprove = true;
        }

        // ── Execute tools in parallel ─────────────────────────
        // Attach currentMessages to context so ToolExecutor can pass them
        // to tools-api (needed by tools like generate_image that inspect conversation)
        context._currentMessages = currentMessages;

        const results = await executeToolBatch(
          pass.pendingToolCalls,
          context,
          this.tools,
          hooks,
          state,
        );

        // ── Post-execution: media, errors, status ─────────────
        processToolResultMedia(
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

        // ── Plan mode toggling ────────────────────────────────
        checkForPlanModeEntry(
          pass.pendingToolCalls,
          currentMessages,
          state,
          emit,
        );

        const exitPlanToolCall = pass.pendingToolCalls.find(
          (toolCall: any) => (toolCall as any).name === "exit_plan_mode",
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

        this.logIteration(pass, currentMessages);

        // ── Append to context for next pass ───────────────────
        const assistantMessage: ConversationMessage = {
          role: "assistant",
          content: pass.streamedText || "",
          ...(pass.streamedThinking && { thinking: pass.streamedThinking }),
          ...(pass.thinkingSignature && {
            thinkingSignature: pass.thinkingSignature,
          }),
          toolCalls: pass.pendingToolCalls.map((toolCall: any) => {
            const matchingResult = results.find(
              (result: any) => (result as any).id === (toolCall as any).id,
            );
            return {
              id: (toolCall as any).id || null,
              responsesItemId: (toolCall as any).responsesItemId || undefined,
              name: (toolCall as any).name,
              args: (toolCall as any).args,
              thoughtSignature: (toolCall as any).thoughtSignature || undefined,
              result: matchingResult ? matchingResult.result : null,
            };
          }),
        };
        currentMessages.push(assistantMessage);

        currentMessages = currentMessages.filter(
          (message: any) =>
            !(
              (message as any).role === "assistant" &&
              !(message as any).content?.trim() &&
              (!(message as any).toolCalls || (message as any).toolCalls.length === 0)
            ),
        );
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
