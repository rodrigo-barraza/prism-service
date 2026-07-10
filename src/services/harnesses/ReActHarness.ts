import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import { runTreeOfThoughts } from "./strategies/TreeOfThoughtsStrategy.ts";
import { runGraphOfThoughts } from "./strategies/GraphOfThoughtsStrategy.ts";
import { roundMilliseconds } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  type StatusMessage,
  TOOL_NAMES,
  THOUGHT_STRUCTURES,
  MAX_TOOL_ITERATIONS,
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
  isAtOutputCeiling,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  buildProviderErrorMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "./lifecycle/OutputTruncationRecovery.ts";
import { manageContextPressure } from "./lifecycle/ContextPressureManager.ts";
import { buildContextExhaustedMessage } from "./lifecycle/ContextExhaustionGuard.ts";
import { logKVCacheHitRate } from "./lifecycle/KVCacheReporter.ts";
import { injectToolDiscoveryNudge } from "./lifecycle/ToolDiscoveryNudge.ts";
import { finalizePassTracker } from "./lifecycle/TrackerFinalizer.ts";
import { handleCodexPlanningResponse } from "./lifecycle/CodexPlanningDetector.ts";
import {
  maybeInjectSystemReminder,
  cleanupReminderCache,
} from "./lifecycle/SystemReminderInjector.ts";
import { checkCostBudget } from "./lifecycle/CostBudgetEnforcer.ts";
import {
  createSandboxCheckpoint,
  restoreSandboxCheckpoint,
} from "./lifecycle/SandboxExecutor.ts";
import SemanticStallDetector from "./lifecycle/SemanticStallDetector.ts";

import PlanningModeService from "#src/services/PlanningModeService";
import PromptLocaleService from "#src/services/PromptLocaleService";
import ConversationStatusRegistry from "#src/services/ConversationStatusRegistry";
import { HARNESS } from "#src/constants";

import type {
  ConversationMessage,
  ToolCall,
  ToolSchema,
  ToolResult,
  AgenticOptions,
  BeforePromptHookContext,
  PassState,
} from "./types.ts";

/**
 * Per-iteration pass options combining the user's AgenticOptions with
 * runtime context fields needed by the provider and lifecycle modules.
 */
interface IterationPassOptions extends AgenticOptions {
  project: string;
  agent?: string | null;
  username: string;
}

/** Compute thinking and content phase durations from a PassState's timestamps. */
function computePassPhaseDurations(pass: PassState) {
  // Seal thinking phase with generationEnd if thinking was active but never sealed
  // (thinking-only response with no text/tools to trigger the seal).
  const effectiveThinkingEnd = pass.thinkingEndTime ?? pass.generationEnd;
  return {
    ...(pass.thinkingStartTime != null && effectiveThinkingEnd != null && {
      thinkingDurationSeconds: roundMilliseconds(
        (effectiveThinkingEnd - pass.thinkingStartTime) / 1000,
      ),
    }),
    ...(pass.thinkingEndTime != null && pass.generationEnd != null && {
      contentDurationSeconds: roundMilliseconds(
        (pass.generationEnd - pass.thinkingEndTime) / 1000,
      ),
    }),
  };
}

const {
  MAX_CONSECUTIVE_TOOL_ERRORS,
  MAX_REPETITION_RETRIES,
  REPETITION_TEMPERATURE_BUMP,
  REPETITION_PENALTY_BUMP,
  MAX_POST_WARNING_STALL_ITERATIONS,
  MAX_EMPTY_OUTPUT_RETRIES,
  EMPTY_OUTPUT_TEMPERATURE_BUMP,
} = HARNESS;

/**
 * ReActHarness — Reason→Act→Observe tool-use loop with pluggable thought structures.
 *
 * Two orthogonal axes govern agent reasoning:
 *   1. Execution pattern (this harness): ReAct — interleaved reasoning and acting
 *   2. Reasoning shape (thought structure): CoT / ToT / GoT — how thoughts connect
 *
 * Papers:
 *   Execution pattern:
 *   - "ReAct: Synergizing Reasoning and Acting in Language Models"
 *     (arxiv.org/abs/2210.03629) — Yao et al., 2022
 *
 *   Reasoning shapes:
 *   - "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models"
 *     (arxiv.org/abs/2201.11903) — Wei et al., 2022  [CoT — linear chain]
 *   - "Tree of Thoughts: Deliberate Problem Solving with Large Language Models"
 *     (arxiv.org/abs/2305.10601) — Yao et al., 2023  [ToT — branching tree]
 *   - "Graph of Thoughts: Solving Elaborate Problems with Large Language Models"
 *     (arxiv.org/abs/2308.09687) — Besta et al., 2023  [GoT — merging graph]
 *   - "Reflexion: Language Agents with Verbal Reinforcement Learning"
 *     (arxiv.org/abs/2303.11366) — Shinn et al., 2023  [backtracking self-correction in ToT]
 *
 * Thought structures (dispatched at run()):
 *   - Chain of Thought (default): linear chain — one reasoning step per iteration
 *   - Tree of Thoughts: branching tree — parallel branches, score, select best
 *   - Graph of Thoughts: merging graph — parallel branches, score, synthesize all
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
      conversationId,
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
    let emptyOutputRetryCount = 0;
    let hasCleanTextBreak = false;
    let hasNonBlockingDispatchBreak = false;

    // ── Semantic stall detector ──────────────────────────────
    const semanticStallDetector = new SemanticStallDetector();

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

    // ── Register initial live status in the registry ──────────
    // So clients recovering from a page refresh or conversation switch
    // can read the current generation state from the REST endpoint.
    const registryConversationId = context.agentConversationId as string;
    if (registryConversationId) {
      ConversationStatusRegistry.set(registryConversationId, {
        phase: options.planFirst ? "thinking" : "generating",
        label: options.planFirst ? "Planning..." : null,
        iteration: 0,
        maxIterations: Number.isFinite(resolvedMaxIterations) ? resolvedMaxIterations : 0,
        startedAt: new Date().toISOString(),
        phaseStartedAt: new Date().toISOString(),
        tokensPerSecond: null,
        activeRequests: 0,
        outputTokens: 0,
        inputTokens: 0,
        totalTokens: 0,
        subAgents: {},
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

        // Mirror iteration progress to the live status registry
        if (registryConversationId) {
          ConversationStatusRegistry.patch(registryConversationId, {
            iteration: state.iterations,
            maxIterations: Number.isFinite(resolvedMaxIterations) ? resolvedMaxIterations : 0,
          });
        }

        // ── Instruction fade-out countermeasure ─────────────────
        await maybeInjectSystemReminder(currentMessages, state, context);

        // ── beforePrompt hook (iteration 1 only) ──────────────
        if (state.iterations === 1) {
          const hookContext: BeforePromptHookContext = {
            messages: currentMessages,
            project,
            username,
            agent,
            traceId,
            conversationId,
            agentConversationId,
            parentAgentConversationId: context.parentAgentConversationId,
            agentContext: options.agentContext,
            enabledTools: this.tools.resolvedEnabledTools,
            resolvedToolNames: this.tools.finalTools.map(
              (tool: ToolSchema) => tool.name,
            ),
            workspaceRoot: workspaceRoot || undefined,
            workspaceEnabled: options.workspaceEnabled as boolean | undefined,
            locale: options.locale as string | undefined,
          };
          await hooks.run("beforePrompt", hookContext);

          // ── Persist assembled system prompt to conversationMeta ──
          if (hookContext._assembledSystemPrompt) {
            const assembledPrompt =
              hookContext._assembledSystemPrompt as string;
            context.conversationMeta = {
              ...(context.conversationMeta || {}),
              systemPrompt: assembledPrompt,
            };
            // Feed the identity prompt to providers as a first-class parameter
            // (Google → systemInstruction, Anthropic → payload.system, etc.)
            // so it never needs to exist in the messages array.
            if (!options.systemPrompt) {
              options.systemPrompt = assembledPrompt;
            }
          }

          // ── Persist newly injected memory IDs to conversationMeta ──
          // The Finalizer will $addToSet these onto the agent_conversations
          // document so subsequent turns can exclude already-seen memories.
          if (
            Array.isArray(hookContext._injectedMemoryIds) &&
            (hookContext._injectedMemoryIds as string[]).length > 0
          ) {
            context.conversationMeta = {
              ...(context.conversationMeta || {}),
              _newInjectedMemoryIds: hookContext._injectedMemoryIds as string[],
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
            await PlanningModeService.injectPlanningInstruction(
              currentMessages,
            );
          }

          // ── Re-snapshot after hook mutations ────────────────────
          // SystemPromptAssembler may splice context messages into
          // currentMessages, shifting indices. Update originalMessageCount
          // so computeNewTurnMessages slices from the correct boundary —
          // without this, the assistant message with tool results can fall
          // outside the persistence slice and tool results are lost.
          state.originalMessageCount = currentMessages.length;
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
        } else {
          passOptions.tools = this.tools.finalTools;
        }

        const resolvedPassTools = passOptions.tools || [];
        const allowedToolNames = new Set(
          resolvedPassTools.map((tool: ToolSchema) => tool.name),
        );

        // ── Context pressure management ──────────────────────────
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
        const stream = await this.createProviderStream(currentMessages, passOptions);

        // ── Context exhaustion pre-flight ──────────────────────
        // When the output budget is critically low, createProviderStream
        // returns null instead of a stream. Break to the exhaustion
        // recovery path below the loop.
        if (stream === null) {
          logger.warn(
            `[ReActHarness] Context exhaustion guard fired on iteration ${state.iterations} — ` +
              `skipping provider call, triggering exhaustion recovery.`,
          );
          injectErrorAsConversationMessage(
            currentMessages,
            buildContextExhaustedMessage(
              0,
              this.context.modelDefinition?.maxInputTokens || 0,
              state.iterations,
              this.context.options?.locale as string | undefined,
            ),
            context,
          );
          state.conversationOutcome = "exhausted";
          break;
        }

        await this.consumeStream(stream, pass, allowedToolNames);

        // ── Repetition detection recovery ──────────────────────
        if (pass.repetitionDetected) {
          finalizePassTracker(pass, passRequestId);
          this.emitGenerationProgress();

          emit({
            type: SERVER_SENT_EVENT_TYPES.STATUS,
            message: "repetition_detected",
            iteration: state.iterations,
          });

          let retrySucceeded = false;
          for (
            let repetitionRetry = 1;
            repetitionRetry <= MAX_REPETITION_RETRIES;
            repetitionRetry++
          ) {
            logger.warn(
              `[ReActHarness] Repetition recovery attempt ${repetitionRetry}/${MAX_REPETITION_RETRIES} — ` +
                `bumping temperature and penalty`,
            );

            const perturbedPassOptions = { ...passOptions };
            const currentTemperature =
              typeof perturbedPassOptions.temperature === "number"
                ? perturbedPassOptions.temperature
                : 0.7;
            perturbedPassOptions.temperature = Math.min(
              1.0,
              currentTemperature + REPETITION_TEMPERATURE_BUMP * repetitionRetry,
            );
            (perturbedPassOptions as Record<string, unknown>).repeatPenalty =
              1.0 + REPETITION_PENALTY_BUMP * repetitionRetry;

            const retryPass = this.createPassState(perturbedPassOptions);
            const retryRequestId = `${requestIdBase}-iter-${state.iterations}-rep-${repetitionRetry}`;
            retryPass.requestId = retryRequestId;
            this.registerTrackerRequest(retryRequestId);

            const retryStream = await this.createProviderStream(
              currentMessages,
              perturbedPassOptions,
            );

            // Context exhaustion can also fire during repetition retries
            if (retryStream === null) {
              logger.warn(
                `[ReActHarness] Context exhaustion during repetition retry ${repetitionRetry} — ` +
                  `aborting repetition recovery.`,
              );
              break;
            }

            await this.consumeStream(retryStream, retryPass, allowedToolNames);

            finalizePassTracker(retryPass, retryRequestId);

            if (!retryPass.repetitionDetected) {
              logger.info(
                `[ReActHarness] Repetition recovery succeeded on attempt ${repetitionRetry}`,
              );
              Object.assign(pass, retryPass);
              pass.repetitionDetected = false;
              retrySucceeded = true;
              break;
            }
          }

          if (!retrySucceeded) {
            logger.error(
              `[ReActHarness] All repetition recovery attempts exhausted`,
            );
            injectErrorAsConversationMessage(
              currentMessages,
              `Repetition recovery failed.`,
              context,
            );
            this.logIteration(pass, currentMessages);
            break;
          }
        }

        // ── Finalize tracker for this pass ─────────────────────
        finalizePassTracker(pass, passRequestId);
        logKVCacheHitRate(pass.usage, state.iterations, "ReActHarness");
        this.emitGenerationProgress();

        // ── Truncation recovery ────────────────────────────────
        if (isOutputTruncated(pass)) {
          truncationRecoveryCount++;
          const configuredMaxTokens = context.options.maxTokens || "default";
          const modelOutputCeiling = context.modelDefinition
            ?.maxOutputTokens as number | undefined;

          const alreadyAtCeiling =
            typeof configuredMaxTokens === "number" &&
            isAtOutputCeiling(configuredMaxTokens, modelOutputCeiling);

          if (
            !alreadyAtCeiling &&
            truncationRecoveryCount <= MAX_OUTPUT_TRUNCATION_RECOVERIES
          ) {
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

          if (alreadyAtCeiling) {
            logger.warn(`[AgenticLoop] Already at ceiling — no truncation recovery.`);
          }
          injectErrorAsConversationMessage(
            currentMessages,
            buildExhaustedRecoveryMessage(
              alreadyAtCeiling ? 0 : MAX_OUTPUT_TRUNCATION_RECOVERIES,
              configuredMaxTokens,
              this.context.options?.locale as string | undefined,
            ),
            context,
          );
          this.logIteration(pass, currentMessages);
          break;
        }

        if (signal?.aborted) break;
        this.emitUsageUpdate();

        if (checkCostBudget(state, context.resolvedModel, options.maxCostDollars, emit)) {
          break;
        }

        // ── Tool execution ─────────────────────────────────────
        if (pass.pendingToolCalls.length > 0) {
          if (state.planModeActive) {
            const { allBlocked } = blockUnauthorizedToolCalls(
              pass.pendingToolCalls,
              currentMessages,
              pass,
              state,
              this.context.options?.locale as string | undefined,
            );
            if (allBlocked) {
              this.logIteration(pass, currentMessages);
              continue;
            }
          }

          const { isApproved, shouldApproveAll } =
            await checkAndWaitForApproval(
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
            if (shouldApproveAll) options.autoApprove = true;
            context._currentMessages = currentMessages;
            results = await executeToolBatch(
              pass.pendingToolCalls,
              context,
              this.tools,
              hooks,
              state,
            );
          }

          await processToolResultMedia(
            pass.pendingToolCalls,
            results,
            state,
            pass,
            emit,
            context,
          );

          emitPostExecutionStatus(pass.pendingToolCalls, emit);

          const validationFeedback = await validateAfterToolExecution(
            pass.pendingToolCalls,
            results,
            context,
            state,
          );

          if (validationFeedback.length > 0) {
            const errorBlock = validationFeedback
              .map(f => `### ${f.filePath} (${f.validatorType})\n${f.rawOutput}`)
              .join("\n\n");

            currentMessages.push({
              role: "assistant",
              content: pass.finalStreamedText || "",
              thinking: pass.streamedThinking.trim(),
              thinkingSignature: pass.thinkingSignature,
              ...computePassPhaseDurations(pass),
              toolCalls: pass.pendingToolCalls.map(tc => {
                const res = results.find(r => r.id === tc.id);
                return {
                  id: tc.id || null,
                  name: tc.name,
                  args: tc.args,
                  result: res ? res.result : null,
                  durationMilliseconds: res?.durationMilliseconds,
                };
              }),
            });

            currentMessages.push({
              role: "system",
              content: `Validation Errors:\n\n${errorBlock}`,
            });

            this.logIteration(pass, currentMessages);
            continue;
          }

          await checkForPlanModeEntry(
            pass.pendingToolCalls,
            currentMessages,
            state,
            emit,
            this.context.options?.locale as string | undefined,
          );

          const exitPlanToolCall = pass.pendingToolCalls.find(tc => tc.name === TOOL_NAMES.EXIT_PLAN_MODE);
          if (exitPlanToolCall) {
            const { shouldContinueLoop } = await handleExitPlanMode(
              exitPlanToolCall, pass, results, currentMessages, context, state,
            );
            if (!shouldContinueLoop) return { messages: currentMessages };
          }

          const assistantMessage: ConversationMessage = {
            role: "assistant",
            content: pass.finalStreamedText || "",
            thinking: pass.streamedThinking.trim(),
            thinkingSignature: pass.thinkingSignature,
            ...computePassPhaseDurations(pass),
            toolCalls: pass.pendingToolCalls.map(tc => {
              const res = results.find(r => r.id === tc.id);
              return {
                id: tc.id || null,
                responsesItemId: tc.responsesItemId,
                name: tc.name,
                args: tc.args,
                thoughtSignature: tc.thoughtSignature,
                reasoningItem: tc.reasoningItem,
                result: res ? res.result : null,
                durationMilliseconds: res?.durationMilliseconds,
              };
            }),
          };
          currentMessages.push(assistantMessage);

          for (const tc of pass.pendingToolCalls) {
            const res = results.find(r => r.id === tc.id);
            const stc = state.streamedToolCalls.find(s => s.id === tc.id);
            if (stc && res) {
              stc.result = res.result;
              stc.durationMilliseconds = res.durationMilliseconds;
            }
          }

          const retryGuidance = buildToolRetryGuidance(
            pass.pendingToolCalls, results, state, MAX_CONSECUTIVE_TOOL_ERRORS, this.context.options?.locale as string,
          );
          if (retryGuidance) currentMessages.push(retryGuidance);

          currentMessages = currentMessages.filter(m => !(m.role === "assistant" && !m.content?.trim() && (!m.toolCalls || m.toolCalls.length === 0)));

          injectToolDiscoveryNudge(pass.pendingToolCalls, results, currentMessages, context);
          this.checkAndApplyToolSetChanges(currentMessages);
          this.logIteration(pass, currentMessages);

          const stallVerdict = semanticStallDetector.recordIteration(pass.pendingToolCalls);
          if (stallVerdict.isStalled) {
            if (semanticStallDetector.hasWarningBeenIssued && semanticStallDetector.postWarningStalls >= MAX_POST_WARNING_STALL_ITERATIONS) {
              injectErrorAsConversationMessage(currentMessages, `Behavioral loop detected.`, context);
              break;
            }
            if (!semanticStallDetector.hasWarningBeenIssued) {
              semanticStallDetector.markWarningIssued();
              currentMessages.push({ role: "system", content: "You are in a behavioral loop. Try a different approach." });
            }
          }

          const hasNonBlockingDispatch = results.some(r => (r.result as any)?._directive === "NON_BLOCKING_DISPATCH");
          if (hasNonBlockingDispatch) {
            hasCleanTextBreak = true;
            hasNonBlockingDispatchBreak = true;
            break;
          }
          continue;
        }

        // ── No tools — check if we should break ─────────────────
        if (pass.streamedText) {
          if (state.planModeActive) {
            currentMessages.push({
              role: "assistant",
              content: pass.finalStreamedText || pass.streamedText,
              thinking: pass.streamedThinking.trim(),
              thinkingSignature: pass.thinkingSignature,
              ...computePassPhaseDurations(pass),
            });
            this.logIteration(pass, currentMessages);
            continue;
          }

          const codexResult = handleCodexPlanningResponse(pass, currentMessages, context, state, this.tools.finalTools, "ReActHarness");
          if (codexResult.shouldContinueLoop) {
            this.logIteration(pass, currentMessages);
            continue;
          }

          this.logIteration(pass, currentMessages);
          semanticStallDetector.recordIteration([], pass.streamedText);
          hasCleanTextBreak = true;
          break;
        }

        if (!pass.streamedText && pass.streamedThinking.trim()) {
          logger.warn(`[AgenticLoop] Thinking-only response.`);
          currentMessages.push({
            role: "assistant",
            content: "",
            thinking: pass.streamedThinking.trim(),
            thinkingSignature: pass.thinkingSignature,
            ...computePassPhaseDurations(pass),
          });
          currentMessages.push({
            role: "user",
            content: "[System: Reasoning preserved. Please provide actual output now.]",
          });
          this.logIteration(pass, currentMessages);
          continue;
        }

        // ── Empty output recovery ──────────────────────────────
        emptyOutputRetryCount++;
        if (emptyOutputRetryCount <= MAX_EMPTY_OUTPUT_RETRIES) {
          const curTemp = context.options.temperature ?? 0.7;
          context.options.temperature = Math.min(curTemp + EMPTY_OUTPUT_TEMPERATURE_BUMP, 1.5);
          currentMessages.push({ role: "system", content: "Your previous response was empty. Please provide output." });
          this.logIteration(pass, currentMessages);
          continue;
        }

        logger.warn(`[AgenticLoop] Empty output recovery exhausted.`);
        break;
      }

      if (!hasCleanTextBreak && state.streamedToolCalls.length > 0 && !signal?.aborted) {
        state.conversationOutcome = "exhausted";
        await runExhaustionRecoveryPass(this, context, state, currentMessages);
      }

      cleanupReminderCache(agentConversationId);

      if (hasNonBlockingDispatchBreak && agentConversationId && conversationId) {
        try {
          const { default: ConversationService } = await import("#src/services/conversation/ConversationService");
          const { COLLECTIONS } = await import("#src/constants");
          await ConversationService.adjustPendingBackgroundTasks(conversationId, project, username, 1, { collection: COLLECTIONS.AGENT_CONVERSATIONS });
        } catch (e) {}
      }

      if (hasNonBlockingDispatchBreak && agentConversationId) {
        await this.finalize(currentMessages, hooks, { deferDoneEmission: true });
        const { default: OrchestratorService } = await import("#src/services/OrchestratorService");
        await OrchestratorService.awaitPendingDispatches(agentConversationId);
      } else {
        await this.finalize(currentMessages, hooks);
      }

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
        buildProviderErrorMessage(
          loopError,
          state.iterations,
          this.context.options?.locale as string | undefined,
        ),
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
