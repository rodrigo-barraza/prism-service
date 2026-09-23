import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import { runTreeOfThoughts } from "./strategies/TreeOfThoughtsStrategy.ts";
import { runGraphOfThoughts } from "./strategies/GraphOfThoughtsStrategy.ts";
import { persistLoopError } from "./strategies/branchingCommon.ts";
import { roundMilliseconds } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
} from "#src/utils/SystemMessageTags";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
  TOOL_NAMES,
  THOUGHT_STRUCTURES,
  MAX_TOOL_ITERATIONS,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import {
  createStandardHooks,
  attachConfiguredHooks,
} from "./lifecycle/HookInitializer.ts";
import { executeToolBatch } from "./lifecycle/ToolExecutor.ts";
import {
  approvalRecordFor,
  checkAndWaitForApproval,
  orderResultsLikeCalls,
} from "./lifecycle/ApprovalGate.ts";
import {
  buildStopContinuationMessage,
  closeTurnHooks,
  fireInstructionsLoaded,
  flushHookContext,
  openTurnHooks,
  runPostToolBatchStage,
  runPreToolUseStage,
  runStopStage,
  type LoadedInstruction,
  type TurnHookHandle,
} from "./lifecycle/TurnHooks.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
} from "./lifecycle/PostExecutionEmitter.ts";
import { runExhaustionRecoveryPass } from "./lifecycle/ExhaustionRecovery.ts";
import {
  handleExitPlanMode,
  checkForPlanModeEntry,
} from "./lifecycle/PlanModeController.ts";
import {
  flushPlanModeNotice,
  gatePlanModeCalls,
  planModeNotice,
} from "./lifecycle/PlanModeGate.ts";
import {
  transcriptCallOf,
  unwrapBridgedToolCalls,
} from "./lifecycle/ToolSurface.ts";
import { validateAfterToolExecution } from "./lifecycle/ValidationInterceptor.ts";
import {
  applyWorkspaceRules,
  rememberWorkspaceInstructions,
} from "./lifecycle/WorkspaceRuleStage.ts";
import { buildToolRetryGuidance } from "./lifecycle/ToolRetryInterceptor.ts";
import {
  isOutputTruncated,
  isAtOutputCeiling,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES,
} from "./lifecycle/OutputTruncationRecovery.ts";
import { manageContextPressure } from "./lifecycle/ContextPressureManager.ts";
import ContextWindowManager from "#src/services/ContextWindowManager";
import type { ChatMessage } from "#src/types/admin";
import { buildContextExhaustedMessage } from "./lifecycle/ContextExhaustionGuard.ts";
import { logKVCacheHitRate } from "./lifecycle/KVCacheReporter.ts";
import { injectToolDiscoveryNudge } from "./lifecycle/ToolDiscoveryNudge.ts";
import { finalizePassTracker } from "./lifecycle/TrackerFinalizer.ts";
import { handleCodexPlanningResponse } from "./lifecycle/CodexPlanningDetector.ts";
import { buildPlanSubmissionContinuation } from "./lifecycle/PlanSubmissionContinuation.ts";
import { recordRefusal } from "./lifecycle/RefusalHandler.ts";
import {
  drainTurnInput,
  hasPendingTurnInput,
  recordNativeTurnInput,
  sealTurnInput,
} from "./lifecycle/TurnInputDrain.ts";
import { resolveLoopKey } from "#src/services/LoopKey";
import {
  maybeInjectSystemReminder,
  cleanupReminderCache,
} from "./lifecycle/SystemReminderInjector.ts";
import { enforceCostBudget } from "./lifecycle/CostBudgetEnforcer.ts";
import { recordBudgetPause } from "./lifecycle/TurnRunRecorder.ts";
import {
  partitionResumedCalls,
  replayPassStream,
  stampResumedCalls,
} from "./lifecycle/ResumedPass.ts";
import { recordPassInFlight } from "./lifecycle/TurnRunRecorder.ts";
import { endTurnAfterToolsOf, endsTurnWithReply } from "./lifecycle/EndTurnAfterTools.ts";
import { GoalRun } from "./lifecycle/GoalGate.ts";
import SemanticStallDetector from "./lifecycle/SemanticStallDetector.ts";

import PromptLocaleService from "#src/services/PromptLocaleService";
import ConversationStatusRegistry from "#src/services/ConversationStatusRegistry";
import { HARNESS, AGENT_DIRECTIVES } from "#src/constants";

import type {
  ConversationMessage,
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
  profileId?: string | null;
}

/**
 * Provider-native state a pass produced (OpenAI Responses: message phase,
 * reasoning items no tool call claimed, response.id; Anthropic: thinking
 * blocks) — spread onto the assistant message so it persists and is
 * replayed next turn.
 */
function providerNativeState(pass: PassState) {
  return {
    ...(pass.phase !== undefined && { phase: pass.phase }),
    ...(pass.reasoningItems &&
      pass.reasoningItems.length > 0 && { reasoningItems: pass.reasoningItems }),
    ...(pass.providerResponseId && {
      providerResponseId: pass.providerResponseId,
    }),
    ...(pass.responsesEffort && { responsesEffort: pass.responsesEffort }),
    ...(pass.geminiParts && pass.geminiParts.length > 0 && { geminiParts: pass.geminiParts }),
    ...(pass.citations && { citations: pass.citations }),
    // Anthropic: the pass's thinking blocks, verbatim and in order
    ...(pass.thinkingBlocks &&
      pass.thinkingBlocks.length > 0 && { thinkingBlocks: pass.thinkingBlocks }),
  };
}

/**
 * The tool calls of a pass as the transcript keeps them: what the model
 * sent (a bridged call stays `tool_call`, with `bridgedName` for display),
 * each with its result.
 */
function transcriptToolCalls(pass: PassState, results: ToolResult[]) {
  return pass.pendingToolCalls.map((toolCall) => {
    const result = results.find((entry) => entry.id === toolCall.id);
    const sent = transcriptCallOf(toolCall);
    return {
      id: toolCall.id || null,
      responsesItemId: toolCall.responsesItemId,
      name: sent.name,
      args: sent.args,
      ...(sent.bridgedName && { bridgedName: sent.bridgedName }),
      thoughtSignature: toolCall.thoughtSignature,
      reasoningItem: toolCall.reasoningItem,
      result: result ? result.result : null,
      durationMilliseconds: result?.durationMilliseconds,
      ...approvalRecordFor(toolCall),
    };
  });
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
  MAX_DEVIATION_RETRIES,
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
      profileId,
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
    let droppedToolFeedbackCount = 0;
    let hasCleanTextBreak = false;
    let hasNonBlockingDispatchBreak = false;
    // A turn re-driven after a restart plays back the pass the restart
    // interrupted instead of asking the model again (ResumedPass).
    let replayPass = context.resume?.pass ?? null;

    // ── Semantic stall detector ──────────────────────────────
    const semanticStallDetector = new SemanticStallDetector();

    // Tools whose result the model never needs to read (Persona.endTurnAfterTools).
    const fireAndForgetTools = endTurnAfterToolsOf(agent);

    // ── Initialize lifecycle hooks ──────────────────────────
    const standardHooks = createStandardHooks({
      workspaceRoot: workspaceRoot || undefined,
      autoApprove: options.autoApprove === true,
      policies: options.policies,
      permissionRules: options._permissionRules,
      permissionMode: options._permissionMode,
      capabilityScope: options._capabilityScope,
      untrustedSpans: options._untrustedSpans,
      evaluation: options.evaluation === true,
    });
    const { hooks, approvalEngine } = standardHooks;

    // ── User-configured hooks ────────────────────────────────
    // Layered on top of the built-ins. Sub-agents build their own AgentHooks
    // instance, so this runs per sub-agent too rather than being inherited —
    // which is what lets a hook scoped to one agent stay scoped to it.
    await attachConfiguredHooks(hooks, {
      project: context.project,
      username: context.username,
      agent: context.agent,
      conversationId: context.conversationId,
      agentConversationId: context.agentConversationId as string,
      workspaceRoot,
      hookDepth: context.parentAgentConversationId ? 1 : 0,
      emit: emit as (event: Record<string, unknown>) => void,
      evaluation: options.evaluation === true,
    });

    // ── Turn-open hook events ────────────────────────────────
    // SessionStart (new session only), SubagentStart, TurnStart,
    // UserPromptSubmit and the model-switch pair. A UserPromptSubmit or
    // PreModelSwitch refusal ends the run before a single token is spent.
    const turnHooks: TurnHookHandle = await openTurnHooks(context, hooks, currentMessages, {
      getMessages: () => currentMessages,
      toolSchemas: this.tools.finalTools,
    });
    if (turnHooks.blocked) {
      await closeTurnHooks(context, hooks, state, turnHooks, {
        blocked: true,
        reason: turnHooks.reason,
      });
      return { messages: currentMessages };
    }

    if (options.planFirst) {
      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.PLAN_MODE_ENTERED,
      });
    }
    // The plan-mode notice is never persisted (PlanModeGate), and a
    // re-driven turn skips the first-iteration block that appends it: it
    // gets it again here.
    if (context.resume && state.planModeActive) {
      currentMessages.push(
        planModeNotice("entered", options.locale as string | undefined),
      );
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
        estimatedCost: 0,
        subAgents: {},
      });
    }

    // ── Conversation goal ─────────────────────────────────────
    // A root turn of a conversation with a goal keeps working until the
    // goal's verifier is satisfied (lifecycle/GoalGate.ts).
    const goalRun = await GoalRun.open(context, state);

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

        // ── Mid-turn input (steering / answers / completions) ───
        // Anything that reached the TurnInputMailbox since the last
        // boundary goes in front of this iteration's model call. A replayed
        // pass was made before it arrived: it goes in after that batch.
        if (!replayPass) drainTurnInput(currentMessages, state, context, "iteration_start");

        // ── beforePrompt hook (iteration 1 only) ──────────────
        // Not for a re-driven turn: its system prompt was assembled (and its
        // context injected into the checkpointed messages) before the restart.
        if (state.iterations === 1 && !context.resume) {
          const hookContext: BeforePromptHookContext = {
            messages: currentMessages,
            project,
            username,
            profileId,
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
            activeRuleNames: options.activeRuleNames as string[] | undefined,
            // A sub-agent's loop never runs under its parent's preset.
            routingPreset: options.isSubAgent
              ? undefined
              : (options.routingPreset as string | undefined),
            evaluation: options.evaluation === true,
          };
          await hooks.run("beforePrompt", hookContext);
          await fireInstructionsLoaded(
            context,
            hooks,
            hookContext._loadedInstructions as LoadedInstruction[] | undefined,
          );
          rememberWorkspaceInstructions(state, hookContext);

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

          // Expose the skill highlight and catalog to the context budget
          // tracker so skill tokens are reported as their own category.
          if (typeof hookContext._skillsText === "string") {
            options._skillsText = hookContext._skillsText;
          }
          if (typeof hookContext._skillCatalogText === "string") {
            options._skillCatalogText = hookContext._skillCatalogText;
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

          // Plan mode is announced after the user message, never spliced
          // into the history the previous turn's requests sent.
          if (state.planModeActive) {
            currentMessages.push(
              planModeNotice("entered", options.locale as string | undefined),
            );
          }

          // ── Re-snapshot after hook mutations ────────────────────
          // SystemPromptAssembler may splice context messages into
          // currentMessages, shifting indices. Update originalMessageCount
          // so computeNewTurnMessages slices from the correct boundary —
          // without this, the assistant message with tool results can fall
          // outside the persistence slice and tool results are lost.
          state.originalMessageCount = currentMessages.length;

          // Pre-flight picks the loop routes through activation
          // (Persona.activatePreflightTools): the system prompt above was
          // assembled from the declared tools alone, and the picks arrive
          // here, after the user's message, as one tool-update message.
          this.checkAndApplyToolSetChanges(currentMessages);
        }

        // ── Build pass options ─────────────────────────────────
        // The same tool block on every request of the turn — plan mode and
        // tools activated mid-loop never change it (lifecycle/ToolSurface.ts).
        const passOptions: IterationPassOptions = {
          ...options,
          project,
          agent,
          username,
          profileId,
          ...this.requestToolOptions(),
        };
        const allowedToolNames = this.callableToolNames();

        // ── Context pressure management ──────────────────────────
        const pressureResult = await manageContextPressure(
          currentMessages,
          context,
          state,
          "ReActHarness",
          hooks,
          this.estimateRequestOverheadTokens(),
        );
        currentMessages = pressureResult.messages;

        // ── Context window enforcement ─────────────────────────
        currentMessages = this.enforceContextWindow(
          currentMessages,
          this.tools.finalTools.length,
        );

        // ── Cost cap, before the model is asked again ──────────
        // Spend that crossed the cap since the last pass's check (a pass
        // that called no tool, a sub-agent's) pauses the turn here, before
        // another request is bought. Checkpointed first, and marked, so a
        // restart re-drives the turn from this point.
        if (
          !replayPass &&
          (await enforceCostBudget(context, state, {
            beforePause: async () => {
              await this.checkpointTurnProgress(currentMessages);
              await recordBudgetPause(context, state.iterations);
            },
          }))
        ) {
          break;
        }

        // ── Create per-iteration pass state ────────────────────
        const pass = this.createPassState(passOptions, { replayed: !!replayPass });
        const requestIdBase =
          context.requestId || agentConversationId || crypto.randomUUID();
        const passRequestId = `${requestIdBase}-iter-${state.iterations}`;
        pass.requestId = passRequestId;

        this.registerTrackerRequest(passRequestId);

        // ── Crash-safety checkpoint ────────────────────────────
        // Shadow-persist everything accumulated so far (user message on
        // iteration 1, tool-call/result messages afterward) so a process
        // crash or restart mid-iteration cannot wipe the turn from MongoDB.
        await this.checkpointTurnProgress(currentMessages);

        // ── Stream LLM response ────────────────────────────────
        // Snapshot loop state first: a mid-stream deviation abort rolls
        // back to this point so aborted partial content never reaches
        // the final transcript.
        const streamStateSnapshot = this.captureStreamStateSnapshot();
        const stream = replayPass
          ? replayPassStream(replayPass)
          : await this.createProviderStream(currentMessages, passOptions);

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
        if (replayPass) {
          // Which of its calls finished, which were cut off (ResumedPass).
          stampResumedCalls(pass, replayPass, approvalEngine);
          replayPass = null;
        }

        // ── Mid-stream deviation recovery ──────────────────────
        // A deviation rule (repetition, pre-emptive semantic stall, ...)
        // fired mid-stream and aborted the provider pass. Roll back the
        // aborted partial content, inject the rule's reminder as a
        // system message, and regenerate the SAME iteration from the
        // same message state — bounded, then fall through to the
        // existing post-hoc failure handling. Input the provider applied
        // natively during the pass is recorded first, so a regenerated
        // pass still carries it.
        recordNativeTurnInput(currentMessages, pass);
        if (pass.deviation) {
          finalizePassTracker(pass, passRequestId);
          this.emitGenerationProgress();

          const activeLocale =
            (options.locale as string | undefined) ||
            PromptLocaleService.getDefaultLocale();
          let activeDeviation = pass.deviation;
          let retrySucceeded = false;

          for (
            let deviationRetry = 1;
            deviationRetry <= MAX_DEVIATION_RETRIES;
            deviationRetry++
          ) {
            // Discard the aborted pass's partial content from loop state
            // so it never reaches display segments or the final text.
            this.rollbackStreamStateToSnapshot(streamStateSnapshot);

            emit({
              type: SERVER_SENT_EVENT_TYPES.STATUS,
              message: activeDeviation.statusMessage,
              iteration: state.iterations,
              rule: activeDeviation.ruleId,
              retry: deviationRetry,
            });
            logger.warn(
              `[ReActHarness] Deviation recovery attempt ${deviationRetry}/${MAX_DEVIATION_RETRIES} ` +
                `for rule "${activeDeviation.ruleId}" on iteration ${state.iterations}: ${activeDeviation.detail}`,
            );

            currentMessages.push({
              role: "system",
              content: wrapSystemMessage(
                SYSTEM_MESSAGE_TAGS.DEVIATION_REMINDER,
                this.deviationEngine.buildReminder(
                  activeDeviation,
                  activeLocale,
                ),
              ),
              turnScoped: true,
            });

            const retryPassOptions = this.deviationEngine.perturbRetryOptions(
              activeDeviation.ruleId,
              { ...passOptions },
              deviationRetry,
            );

            const retryPass = this.createPassState(retryPassOptions);
            const retryRequestId = `${requestIdBase}-iter-${state.iterations}-dev-${deviationRetry}`;
            retryPass.requestId = retryRequestId;
            this.registerTrackerRequest(retryRequestId);

            const retryStream = await this.createProviderStream(
              currentMessages,
              retryPassOptions,
            );

            // Context exhaustion can also fire during deviation retries
            if (retryStream === null) {
              logger.warn(
                `[ReActHarness] Context exhaustion during deviation retry ${deviationRetry} — ` +
                  `aborting deviation recovery.`,
              );
              break;
            }

            await this.consumeStream(retryStream, retryPass, allowedToolNames);
            recordNativeTurnInput(currentMessages, retryPass);

            finalizePassTracker(retryPass, retryRequestId);

            if (!retryPass.deviation) {
              logger.info(
                `[ReActHarness] Deviation recovery succeeded on attempt ${deviationRetry} ` +
                  `(rule "${activeDeviation.ruleId}")`,
              );
              Object.assign(pass, retryPass);
              pass.deviation = undefined;
              retrySucceeded = true;
              break;
            }
            activeDeviation = retryPass.deviation;
          }

          if (!retrySucceeded) {
            // Post-hoc fall-through: discard the final aborted partial and
            // end the turn with an explicit error message, exactly like the
            // pre-existing exhausted-repetition path.
            this.rollbackStreamStateToSnapshot(streamStateSnapshot);
            logger.error(
              `[ReActHarness] All deviation recovery attempts exhausted (rule "${activeDeviation.ruleId}")`,
            );
            injectErrorAsConversationMessage(
              currentMessages,
              PromptLocaleService.get(
                activeLocale,
                "harness.deviationRules.recoveryFailed",
                { ruleId: activeDeviation.ruleId },
              ),
              context,
            );
            this.logIteration(pass, currentMessages);
            break;
          }
        }

        // ── Finalize tracker for this pass ─────────────────────
        finalizePassTracker(pass, passRequestId);
        logKVCacheHitRate(pass.usage, state.iterations, "ReActHarness");
        // What this call really cost in input tokens (cache included), next
        // to the size of what it carried — the next compaction trigger's
        // baseline. Recorded before this pass's tool results are appended.
        state.recordProviderInput(
          pass.usage,
          ContextWindowManager.estimateTokens(currentMessages as ChatMessage[]),
        );
        this.emitGenerationProgress();

        // ── Safety-classifier refusal ──────────────────────────
        // Checked before anything reads the pass as output: a refusal is
        // not an empty response (no retry nudge), its partial text,
        // thinking and tool calls are discarded, and the turn ends.
        if (pass.refusal) {
          this.rollbackStreamStateToSnapshot(streamStateSnapshot);
          recordRefusal(pass.refusal, state, emit, "ReActHarness");
          this.logIteration(pass, currentMessages);
          hasCleanTextBreak = true;
          break;
        }

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

        // ── Tool execution ─────────────────────────────────────
        if (pass.pendingToolCalls.length > 0) {
          // A `tool_call(name, args)` bridge call becomes the call it names
          // before anything below sees it, so hooks, rules and approval judge
          // the real tool. Plan mode then lets only read-only calls through.
          // Neither step touches the request: the transcript keeps what the
          // model sent, and a call that does not run gets an error result.
          const bridge = unwrapBridgedToolCalls(
            pass.pendingToolCalls,
            this.tools.finalTools,
          );

          // On record before any card or tool sees the calls, so a restart
          // can re-drive this batch (TurnRunRecorder).
          await recordPassInFlight(context, state, pass);

          // ── Cost cap ─────────────────────────────────────────
          // The pass that crossed the cap runs nothing: the turn pauses
          // until its user raises the cap (or stops at it — see
          // CostBudgetEnforcer). A pass with no tool call is not stopped
          // here; its answer stands, and the next model call is checked.
          if (await enforceCostBudget(context, state)) break;

          // Calls of a replayed pass that finished before the restart
          // already ran: their recorded result stands, unasked (ResumedPass)
          // — the plan gate below judges only the calls still to run.
          const { finished: resumedFinished, remaining: callsToGate } =
            partitionResumedCalls(bridge.callable);
          const planGate = state.planModeActive
            ? gatePlanModeCalls(
                callsToGate,
                this.context.options?.locale as string | undefined,
              )
            : { callable: callsToGate, rejected: [] };

          // PreToolUse runs BEFORE the approval gate (hooks → rules → mode →
          // ask): a hook deny never reaches a human, a hook `ask` becomes an
          // approval request. The gate itself fires PermissionRequest and —
          // only when a person is actually asked — Notification.
          const preToolUse = await runPreToolUseStage(
            planGate.callable,
            context,
            hooks,
            state,
          );

          // The transcript so far — what auto mode's classifier reads (its
          // tool calls, never their results) and what history-aware tools use.
          context._currentMessages = currentMessages;
          const { executableToolCalls, blockedResults, shouldApproveAll, stopTurnReason } =
            await checkAndWaitForApproval(
              preToolUse.executable,
              context,
              approvalEngine,
              { toolSchemas: this.tools.finalTools, hooks, resume: pass.replayed === true },
            );
          if (shouldApproveAll) options.autoApprove = true;

          // Denied calls (rule, PreToolUse or PermissionRequest hook, the
          // classifier, the user) never run; every call the gate cleared
          // runs in one batch. Results keep the model's order.
          const callsToRun = [...executableToolCalls, ...resumedFinished];
          const executedResults =
            callsToRun.length > 0
              ? await executeToolBatch(
                  callsToRun,
                  context,
                  this.tools,
                  hooks,
                  state,
                )
              : [];
          const results: ToolResult[] = orderResultsLikeCalls(
            pass.pendingToolCalls,
            [
              ...executedResults,
              ...blockedResults,
              ...preToolUse.blocked,
              ...bridge.rejected,
              ...planGate.rejected,
            ],
          );

          await processToolResultMedia(
            pass.pendingToolCalls,
            results,
            state,
            pass,
            emit,
            context,
          );

          emitPostExecutionStatus(pass.pendingToolCalls, emit);

          // The batch has resolved; the next model call has not been made.
          await runPostToolBatchStage(
            context,
            hooks,
            state,
            pass.pendingToolCalls,
            results,
          );

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
              ...providerNativeState(pass),
              toolCalls: transcriptToolCalls(pass, results),
            });
            flushHookContext(currentMessages, state);
            await applyWorkspaceRules(currentMessages, context, hooks, state, pass.pendingToolCalls, results);

            currentMessages.push({
              role: "system",
              content: wrapSystemMessage(
                SYSTEM_MESSAGE_TAGS.VALIDATION_ERRORS,
                `Validation Errors:\n\n${errorBlock}`,
              ),
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
          let isPlanRejected = false;
          if (exitPlanToolCall) {
            const { shouldContinueLoop } = await handleExitPlanMode(
              exitPlanToolCall, pass, results, currentMessages, context, state,
            );
            isPlanRejected = !shouldContinueLoop;
            if (shouldContinueLoop && !state.planModeActive) {
              state.pendingPlanModeNotice = "exited";
            }
          }

          // The reply came with nothing but fire-and-forget calls
          // (Persona.endTurnAfterTools, EndTurnAfterTools.ts): once they have
          // run, the turn ends with that reply instead of another model call —
          // unless input is waiting for an answer in this same turn.
          const endsWithReply =
            !stopTurnReason &&
            !isPlanRejected &&
            !state.planModeActive &&
            !signal?.aborted &&
            endsTurnWithReply({
              calls: bridge.callable,
              rejectedCount: bridge.rejected.length,
              replyText: pass.finalStreamedText,
              fireAndForget: fireAndForgetTools,
            }) &&
            !hasPendingTurnInput(context);

          const assistantMessage: ConversationMessage = {
            role: "assistant",
            // Ending here, the reply is the turn's final message (finalize
            // appends it and records it as the turn's text): not kept twice.
            content: endsWithReply ? "" : pass.finalStreamedText || "",
            thinking: pass.streamedThinking.trim(),
            thinkingSignature: pass.thinkingSignature,
            ...computePassPhaseDurations(pass),
            ...providerNativeState(pass),
            toolCalls: transcriptToolCalls(pass, results),
          };
          currentMessages.push(assistantMessage);
          flushHookContext(currentMessages, state);
          await applyWorkspaceRules(currentMessages, context, hooks, state, pass.pendingToolCalls, results);
          flushPlanModeNotice(
            currentMessages,
            state,
            this.context.options?.locale as string | undefined,
          );

          for (const tc of pass.pendingToolCalls) {
            const res = results.find(r => r.id === tc.id);
            const stc = state.streamedToolCalls.find(s => s.id === tc.id);
            if (stc && res) {
              stc.result = res.result;
              stc.durationMilliseconds = res.durationMilliseconds;
            }
          }

          // Auto mode's breaker tripped and nobody is watching to answer: the
          // turn ends here, and the summary pass (ExhaustionRecovery) tells
          // the user what was refused and what they would have to allow.
          if (stopTurnReason) {
            state.conversationOutcome = "auto_mode_stopped";
            emit({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: `Auto mode stopped this run: ${stopTurnReason}` });
            this.logIteration(pass, currentMessages);
            break;
          }

          if (endsWithReply) {
            // Where the turn would end, Stop hooks have their say, as after
            // a text answer.
            const stopOutcome = await runStopStage(
              context,
              hooks,
              state,
              pass.finalStreamedText,
              currentMessages,
            );
            if (!stopOutcome.continueWith || signal?.aborted) {
              logger.info(
                `[ReActHarness] ${pass.pendingToolCalls.map((toolCall) => toolCall.name).join(", ")} came with the reply — ` +
                  `the turn ends on iteration ${state.iterations} without another model call`,
              );
              state.finalStreamedText = pass.finalStreamedText;
              this.logIteration(pass, currentMessages);
              this.deviationEngine.recordCompletedIteration(pass.pendingToolCalls);
              hasCleanTextBreak = true;
              break;
            }
            // A Stop hook keeps the turn going: the reply goes back into the
            // history as the model's own words, then the hook's reason.
            currentMessages.push({ role: "assistant", content: pass.finalStreamedText });
            currentMessages.push(buildStopContinuationMessage(stopOutcome.continueWith));
          }

          // A rejected (or timed-out) plan ends the turn, but the turn still
          // happened: the plan and the verdict are in the assistant message
          // just pushed, and finalize() persists them, clears isGenerating
          // and emits `done`. Nothing is left to recover.
          if (isPlanRejected) {
            this.logIteration(pass, currentMessages);
            hasCleanTextBreak = true;
            break;
          }

          const retryGuidance = buildToolRetryGuidance(
            pass.pendingToolCalls, results, state, MAX_CONSECUTIVE_TOOL_ERRORS, this.context.options?.locale as string,
          );
          if (retryGuidance) currentMessages.push({ ...retryGuidance, turnScoped: true });

          // Empty assistant messages stay where they are: history is only
          // ever appended to, so every request starts with the previous one
          // (adapters send them as a placeholder).

          injectToolDiscoveryNudge(pass.pendingToolCalls, results, currentMessages, context);
          this.checkAndApplyToolSetChanges(currentMessages, pass.usage, pass.pendingToolCalls);
          this.logIteration(pass, currentMessages);

          // Feed the completed iteration to the mid-stream deviation
          // engine (its stall rule compares future streamed tool calls
          // against these fingerprints) and the post-hoc stall detector.
          this.deviationEngine.recordCompletedIteration(pass.pendingToolCalls);
          const stallVerdict = semanticStallDetector.recordIteration(pass.pendingToolCalls);
          if (stallVerdict.isStalled) {
            if (semanticStallDetector.hasWarningBeenIssued && semanticStallDetector.postWarningStalls >= MAX_POST_WARNING_STALL_ITERATIONS) {
              injectErrorAsConversationMessage(currentMessages, `Behavioral loop detected.`, context);
              break;
            }
            if (!semanticStallDetector.hasWarningBeenIssued) {
              semanticStallDetector.markWarningIssued();
              // Stamp the warning iteration — CompactionDeferralGuard
              // suppresses compaction while the model recovers from a stall
              state.lastStallWarningIteration = state.iterations;
              currentMessages.push({
                role: "system",
                content: wrapSystemMessage(
                  SYSTEM_MESSAGE_TAGS.BEHAVIORAL_LOOP,
                  "You are in a behavioral loop. Try a different approach.",
                ),
                turnScoped: true,
              });
            }
          }

          // Model-invoked compaction (compact_context) — consume at the
          // next iteration boundary via ContextPressureManager
          const hasCompactionRequest = results.some(r => (r.result as any)?._directive === AGENT_DIRECTIVES.REQUEST_COMPACTION);
          if (hasCompactionRequest) {
            state.compactionRequested = true;
          }

          // Background work dispatched while THIS turn keeps going
          // (run_async_task continueWorking, non-blocking ask_user). Only
          // recorded here; the completion arrives through the mailbox.
          if (results.some(r => (r.result as any)?._directive === AGENT_DIRECTIVES.DETACHED_WORK)) {
            state.detachedWorkDispatched = true;
          }

          const hasNonBlockingDispatch = results.some(r => (r.result as any)?._directive === AGENT_DIRECTIVES.NON_BLOCKING_DISPATCH);
          if (hasNonBlockingDispatch) {
            hasCleanTextBreak = true;
            hasNonBlockingDispatchBreak = true;
            break;
          }

          // Native async calls only (OpenAI async tools): the model already
          // worked past them inside its response and ended it, so another
          // model call would have nothing new to answer. Unless input is
          // waiting, the turn ends here like a text answer — the pass's text
          // is already on the message just pushed — and each result comes
          // back later as its call's output (mailbox or a new turn).
          if (
            results.length > 0 &&
            results.every((r) => (r.result as { nativeAsyncCallId?: string } | null)?.nativeAsyncCallId) &&
            !hasPendingTurnInput(context)
          ) {
            state.finalStreamedText = "";
            hasCleanTextBreak = true;
            break;
          }

          // Input that arrived during the tool batch is observed together
          // with the tool results, before the next model call.
          drainTurnInput(currentMessages, state, context, "after_tools");
          continue;
        }

        // ── Dropped tool calls, nothing else usable ─────────────
        // The model emitted tool calls that were dropped for not being in
        // the native schema, and produced no surviving calls or text. A
        // silent drop looks like a no-op to the model — it will retry the
        // same call forever. Name the unavailable tools explicitly, then
        // let normal recovery take over if the model keeps insisting.
        if (
          pass.droppedToolCallNames?.length &&
          pass.pendingToolCalls.length === 0 &&
          !(pass.finalStreamedText || "").trim()
        ) {
          droppedToolFeedbackCount++;
          if (droppedToolFeedbackCount > MAX_EMPTY_OUTPUT_RETRIES) {
            logger.warn(
              `[AgenticLoop] Model kept calling unavailable tools after ${droppedToolFeedbackCount - 1} corrections — breaking.`,
            );
            injectErrorAsConversationMessage(
              currentMessages,
              `Requested tools are not available: ${[...new Set(pass.droppedToolCallNames)].join(", ")}.`,
              context,
            );
            break;
          }
          const droppedNames = [...new Set(pass.droppedToolCallNames)];
          const discoveryAvailable = this.tools.finalTools.some(
            (tool: ToolSchema) => tool.name === TOOL_NAMES.DISCOVER_AND_ENABLE_TOOLS,
          );
          currentMessages.push({
            role: "assistant",
            content: pass.finalStreamedText || "",
            thinking: pass.streamedThinking.trim(),
            thinkingSignature: pass.thinkingSignature,
            ...computePassPhaseDurations(pass),
            ...providerNativeState(pass),
          });
          currentMessages.push({
            role: "system",
            content: wrapSystemMessage(
              SYSTEM_MESSAGE_TAGS.VALIDATION_ERRORS,
              `The following tool(s) are NOT available in this conversation and the call was discarded: ${droppedNames.join(", ")}. ` +
                (discoveryAvailable
                  ? `Only call tools present in your tool definitions. To activate additional capabilities, call ${TOOL_NAMES.DISCOVER_AND_ENABLE_TOOLS} with a descriptive query.`
                  : `Only call tools present in your tool definitions. Tool discovery is not available here — work with your current tools, or tell the user this capability is unavailable.`),
            ),
          });
          this.logIteration(pass, currentMessages);
          continue;
        }

        // ── No tools — check if we should break ─────────────────
        if (pass.streamedText) {
          const hasCleanResponse = (pass.finalStreamedText || "").trim().length > 0;
          if (hasCleanResponse) {
            if (state.planModeActive) {
              currentMessages.push({
                role: "assistant",
                content: pass.finalStreamedText || pass.streamedText,
                thinking: pass.streamedThinking.trim(),
                thinkingSignature: pass.thinkingSignature,
                ...computePassPhaseDurations(pass),
                ...providerNativeState(pass),
              });
              // Keep the plan, then ask for it to be submitted — the next
              // request must not end on the assistant turn (no prefill).
              currentMessages.push(
                buildPlanSubmissionContinuation(
                  this.context.options?.locale as string | undefined,
                ),
              );
              this.logIteration(pass, currentMessages);
              continue;
            }

            const codexResult = handleCodexPlanningResponse(pass, currentMessages, context, state, this.tools.finalTools, "ReActHarness");
            if (codexResult.shouldContinueLoop) {
              this.logIteration(pass, currentMessages);
              continue;
            }

            // The model is done, but the user (or a completion) got here
            // first: keep the answer as a mid-history assistant message,
            // apply the input, and let the model respond to it in the
            // same turn instead of ending and replaying it as a new one.
            if (hasPendingTurnInput(context) && !signal?.aborted) {
              currentMessages.push({
                role: "assistant",
                content: pass.finalStreamedText || pass.streamedText,
                thinking: pass.streamedThinking.trim(),
                thinkingSignature: pass.thinkingSignature,
                ...computePassPhaseDurations(pass),
                ...providerNativeState(pass),
              });
              drainTurnInput(currentMessages, state, context, "before_end");
              this.logIteration(pass, currentMessages);
              this.deviationEngine.recordCompletedIteration([]);
              continue;
            }

            // Stop hooks are awaited here, where the turn would end: a
            // `block` keeps the agent going with the hook's reason (capped).
            const stopOutcome = await runStopStage(
              context,
              hooks,
              state,
              pass.finalStreamedText || pass.streamedText,
              currentMessages,
            );
            if (stopOutcome.continueWith && !signal?.aborted) {
              currentMessages.push({
                role: "assistant",
                content: pass.finalStreamedText || pass.streamedText,
                thinking: pass.streamedThinking.trim(),
                thinkingSignature: pass.thinkingSignature,
                ...computePassPhaseDurations(pass),
                ...providerNativeState(pass),
              });
              currentMessages.push(buildStopContinuationMessage(stopOutcome.continueWith));
              this.logIteration(pass, currentMessages);
              this.deviationEngine.recordCompletedIteration([]);
              continue;
            }

            // Input that arrived while the Stop hooks ran (a sub-agent
            // completion, a user update) still gets its answer in this turn.
            if (hasPendingTurnInput(context) && !signal?.aborted) {
              currentMessages.push({
                role: "assistant",
                content: pass.finalStreamedText || pass.streamedText,
                thinking: pass.streamedThinking.trim(),
                thinkingSignature: pass.thinkingSignature,
                ...computePassPhaseDurations(pass),
                ...providerNativeState(pass),
              });
              drainTurnInput(currentMessages, state, context, "before_end");
              this.logIteration(pass, currentMessages);
              this.deviationEngine.recordCompletedIteration([]);
              continue;
            }

            // A sub-agent's turn is its whole run: an async task it started
            // and did not wait for would complete after it ends, and be
            // dropped. It waits for its own tasks here, then answers them.
            if (options.isSubAgent && agentConversationId && !signal?.aborted) {
              const { holdSubAgentForOwnTasks } = await import(
                "#src/services/tool-definitions/AsyncTaskTools"
              );
              await holdSubAgentForOwnTasks({ conversationId, agentConversationId }, signal ?? undefined);
              if (hasPendingTurnInput(context) && !signal?.aborted) {
                currentMessages.push({
                  role: "assistant",
                  content: pass.finalStreamedText || pass.streamedText,
                  thinking: pass.streamedThinking.trim(),
                  thinkingSignature: pass.thinkingSignature,
                  ...computePassPhaseDurations(pass),
                  ...providerNativeState(pass),
                });
                drainTurnInput(currentMessages, state, context, "before_end");
                this.logIteration(pass, currentMessages);
                this.deviationEngine.recordCompletedIteration([]);
                continue;
              }
            }

            // The conversation's goal is done when its verifier says so: a
            // verdict that finds gaps sends them back and the loop goes on.
            const goalOutcome = goalRun
              ? await goalRun.atTextEnd(currentMessages, pass.finalStreamedText || pass.streamedText)
              : null;
            if (goalRun && goalOutcome?.action === "continue" && !signal?.aborted) {
              currentMessages.push({
                role: "assistant",
                content: pass.finalStreamedText || pass.streamedText,
                thinking: pass.streamedThinking.trim(),
                thinkingSignature: pass.thinkingSignature,
                ...computePassPhaseDurations(pass),
                ...providerNativeState(pass),
              });
              goalRun.deliver(currentMessages, goalOutcome.input);
              this.logIteration(pass, currentMessages);
              this.deviationEngine.recordCompletedIteration([]);
              continue;
            }

            this.logIteration(pass, currentMessages);
            this.deviationEngine.recordCompletedIteration([]);
            semanticStallDetector.recordIteration([], pass.streamedText);
            hasCleanTextBreak = true;
            break;
          }
        }

        if (!pass.streamedText && pass.streamedThinking.trim()) {
          logger.warn(`[AgenticLoop] Thinking-only response.`);
          currentMessages.push({
            role: "assistant",
            content: "",
            thinking: pass.streamedThinking.trim(),
            thinkingSignature: pass.thinkingSignature,
            ...computePassPhaseDurations(pass),
            ...providerNativeState(pass),
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
          currentMessages.push({
            role: "system",
            content: wrapSystemMessage(
              SYSTEM_MESSAGE_TAGS.EMPTY_OUTPUT,
              "Your previous response was empty. Please provide output.",
            ),
            turnScoped: true,
          });
          this.logIteration(pass, currentMessages);
          continue;
        }

        logger.warn(`[AgenticLoop] Empty output recovery exhausted.`);
        break;
      }

      // The turn is ending: from here on, input takes its after-the-turn
      // path (a completion wakes a new turn instead of being accepted and
      // then dropped while this one finalizes).
      sealTurnInput(currentMessages, state, context);

      if (!hasCleanTextBreak && state.streamedToolCalls.length > 0 && !signal?.aborted) {
        if (state.conversationOutcome === "completed") state.conversationOutcome = "exhausted";
        await runExhaustionRecoveryPass(this, context, state, currentMessages);
      }

      cleanupReminderCache(agentConversationId);

      // Detached work whose result has NOT come back when the turn ends:
      // count it so the conversation stays "active" until the result wakes
      // a new turn. Async tasks (continueWorking) count one unit for the
      // turn; each sub-agent dispatch counts its own. Work whose result
      // already came back through the mailbox needs no counter.
      let hasDetachedWorkStillRunning = false;
      let undeliveredSubAgentDispatches = 0;
      if (state.detachedWorkDispatched && !hasNonBlockingDispatchBreak && agentConversationId) {
        try {
          const { default: AsyncTaskRegistry } = await import("#src/services/AsyncTaskRegistry");
          hasDetachedWorkStillRunning = AsyncTaskRegistry.countRunningTasks(agentConversationId) > 0;
        } catch {
          /* registry unavailable — treat as nothing running */
        }
        try {
          // Marked as counted here, so whichever path delivers the result
          // pays its unit back exactly once.
          const { default: OrchestratorService } = await import("#src/services/OrchestratorService");
          undeliveredSubAgentDispatches =
            OrchestratorService.markUndeliveredDispatchesAsCounted(agentConversationId);
        } catch {
          /* orchestrator unavailable — nothing counted */
        }
      }

      const pendingBackgroundDelta =
        (hasNonBlockingDispatchBreak || hasDetachedWorkStillRunning ? 1 : 0) +
        undeliveredSubAgentDispatches;
      if (pendingBackgroundDelta > 0 && agentConversationId && conversationId) {
        try {
          const { default: ConversationService } = await import("#src/services/conversation/ConversationService");
          const { COLLECTIONS } = await import("#src/constants");
          await ConversationService.adjustPendingBackgroundTasks(conversationId, project, username, pendingBackgroundDelta, { collection: COLLECTIONS.AGENT_CONVERSATIONS });
          if (hasDetachedWorkStillRunning) {
            // The tasks remember the count so whichever path delivers the
            // completion (mailbox in a later turn, wait_for_tasks, or an
            // auto-response) pays it back exactly once.
            const { default: AsyncTaskRegistry } = await import("#src/services/AsyncTaskRegistry");
            AsyncTaskRegistry.markRunningAsCounted(agentConversationId);
          }
        } catch {
          /* best-effort counter adjustment — ignore failures */
        }
      }

      if (hasNonBlockingDispatchBreak && agentConversationId) {
        await this.finalize(currentMessages, hooks, { deferDoneEmission: true });
      } else {
        await this.finalize(currentMessages, hooks);
      }

      return { messages: currentMessages };
    } catch (loopError: unknown) {
      // Ending on an error is still ending: seal, and keep what was accepted.
      sealTurnInput(currentMessages, state, context);
      // ── Error-path persistence ─────────────────────────────
      // Persist whatever messages accumulated before the error so
      // the conversation isn't left as an empty stub in MongoDB.
      // Also inject the error as a conversation message so the LLM
      // has context about the failure on the next turn.
      // `persistLoopError` also fires the StopFailure and Error hooks — for
      // this loop and the branching strategies alike. Observation only: it
      // still owns recovery; a hook cannot swallow the failure.
      return await persistLoopError(
        this,
        currentMessages,
        standardHooks,
        loopError,
        "ReActHarness",
      );
    } finally {
      // Every exit converges here — clean break, budget stop, user abort, or
      // a throw already handled above: SubagentStop, TurnEnd, and the session
      // bookkeeping that later fires SessionEnd when the conversation idles.
      await goalRun?.close();
      await closeTurnHooks(context, hooks, state, turnHooks);
    }
  }

  /** The mailbox key: input applied natively mid-stream is recorded by this loop. */
  protected nativeTurnInputKey(): string | undefined {
    return resolveLoopKey(this.context) || undefined;
  }
}
