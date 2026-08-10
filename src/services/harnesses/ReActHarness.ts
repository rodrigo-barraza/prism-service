import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import { runTreeOfThoughts } from "./strategies/TreeOfThoughtsStrategy.ts";
import { runGraphOfThoughts } from "./strategies/GraphOfThoughtsStrategy.ts";
import { persistLoopError } from "./strategies/branchingCommon.ts";
import {
  roundMilliseconds,
  errorMessage as getErrorMessage,
} from "@rodrigo-barraza/utilities-library";
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
import { buildHookPayload } from "#src/services/hooks/buildPayload";
import { HOOK_EVENTS } from "#src/services/hooks/types";
import { extractLatestUserMessageText } from "#src/utils/ConversationUtilities";
import { executeToolBatch } from "./lifecycle/ToolExecutor.ts";
import { checkAndWaitForApproval } from "./lifecycle/ApprovalGate.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
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
import SemanticStallDetector from "./lifecycle/SemanticStallDetector.ts";

import PlanningModeService from "#src/services/PlanningModeService";
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

    // ── Semantic stall detector ──────────────────────────────
    const semanticStallDetector = new SemanticStallDetector();

    // ── Initialize lifecycle hooks ──────────────────────────
    const standardHooks = createStandardHooks({
      workspaceRoot: workspaceRoot || undefined,
      autoApprove: options.autoApprove === true,
      policies: options.policies,
      enableCriticGate: options.enableCriticGate === true,
      criticModel: options.criticModel || undefined,
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
    });

    // ── Session-level hook events ────────────────────────────
    // `sessionStart` fires once per agentic run, before any provider call.
    // `userPromptSubmit` follows with the text that opened the turn, and is
    // one of only two events allowed to block — a deny here aborts the run
    // before a single token is spent.
    await hooks.run(
      "sessionStart",
      buildHookPayload(HOOK_EVENTS.SESSION_START, {
        conversationId: context.conversationId,
        agentConversationId: context.agentConversationId as string,
        parentAgentConversationId: context.parentAgentConversationId as string,
        project: context.project,
        username: context.username,
        agent: context.agent,
        workspaceRoot,
      }),
    );

    // A sub-agent runs its own harness, so its loop already knows it is one —
    // no OrchestratorService plumbing needed to say so. `subagentStart` fires
    // here rather than at the spawn site so it lands in the sub-agent's own
    // scope, which is what a hook filtering by agent expects.
    const isSubAgentRun = Boolean(context.parentAgentConversationId);
    if (isSubAgentRun) {
      await hooks.run(
        "subagentStart",
        buildHookPayload(HOOK_EVENTS.SUBAGENT_START, {
          conversationId: context.conversationId,
          agentConversationId: context.agentConversationId as string,
          parentAgentConversationId: context.parentAgentConversationId as string,
          project: context.project,
          username: context.username,
          agent: context.agent,
          workspaceRoot,
        }),
      );
    }

    const submittedPrompt = extractLatestUserMessageText(currentMessages);
    const promptVerdict = await hooks.run(
      "userPromptSubmit",
      buildHookPayload(HOOK_EVENTS.USER_PROMPT_SUBMIT, {
        conversationId: context.conversationId,
        agentConversationId: context.agentConversationId as string,
        parentAgentConversationId: context.parentAgentConversationId as string,
        project: context.project,
        username: context.username,
        agent: context.agent,
        workspaceRoot,
      }, { prompt: submittedPrompt }),
    );
    if (promptVerdict && promptVerdict.isApproved === false) {
      const blockReason =
        typeof promptVerdict.reason === "string"
          ? promptVerdict.reason
          : "blocked by a UserPromptSubmit hook";
      logger.warn(`[ReActHarness] Prompt blocked before generation: ${blockReason}`);
      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: `Prompt blocked: ${blockReason}`,
      });
      await hooks.run(
        "sessionEnd",
        buildHookPayload(HOOK_EVENTS.SESSION_END, {
          conversationId: context.conversationId,
          agentConversationId: context.agentConversationId as string,
          project: context.project,
          username: context.username,
          agent: context.agent,
          workspaceRoot,
        }, { blocked: true, reason: blockReason }),
      );
      return { messages: currentMessages };
    }
    if (typeof promptVerdict?.additionalContext === "string" && promptVerdict.additionalContext) {
      currentMessages.push({
        role: "system",
        content: wrapSystemMessage(
          SYSTEM_MESSAGE_TAGS.HOOK_CONTEXT,
          promptVerdict.additionalContext,
        ),
      } as ConversationMessage);
    }

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
        estimatedCost: 0,
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
            activeRuleNames: options.activeRuleNames as string[] | undefined,
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

          // Expose injected skills text to the context budget tracker so
          // skill tokens can be reported as their own budget category.
          if (typeof hookContext._skillsText === "string") {
            options._skillsText = hookContext._skillsText;
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
          hooks,
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

        // ── Mid-stream deviation recovery ──────────────────────
        // A deviation rule (repetition, pre-emptive semantic stall, ...)
        // fired mid-stream and aborted the provider pass. Roll back the
        // aborted partial content, inject the rule's reminder as a
        // system message, and regenerate the SAME iteration from the
        // same message state — bounded, then fall through to the
        // existing post-hoc failure handling.
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

        if (checkCostBudget(state, context.resolvedModel, options.maxCostDollars, emit, { budget: options._sharedCostBudget, loopId: agentConversationId })) {
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

          // `notification` covers the out-of-band moments a user would want
          // pushed somewhere — an agent stopping to ask for approval is the
          // main one, and it is the moment a hook can actually be useful
          // (ping a phone, post to a channel) because the loop is now idle
          // waiting on a human.
          {
            await hooks.run(
              "notification",
              buildHookPayload(HOOK_EVENTS.NOTIFICATION, {
                conversationId: context.conversationId,
                agentConversationId: context.agentConversationId as string,
                parentAgentConversationId:
                  context.parentAgentConversationId as string,
                project: context.project,
                username: context.username,
                agent: context.agent,
                workspaceRoot,
              }, {
                notification_type: "approval_required",
                notification_message: `Approval requested for ${pass.pendingToolCalls.length} tool call(s)`,
                tool_names: pass.pendingToolCalls.map((call) => call.name),
              }),
            );
          }

          const { isApproved, shouldApproveAll, deniedToolCalls = [] } =
            await checkAndWaitForApproval(
              pass.pendingToolCalls,
              context,
              approvalEngine,
            );

          // Policy-denied calls are terminal — never executed, never approvable.
          const deniedIds = new Set(deniedToolCalls.map((toolCall) => toolCall.id));
          const deniedResults: ToolResult[] = deniedToolCalls.map((toolCall) => ({
            name: toolCall.name,
            id: toolCall.id,
            result: {
              success: false,
              error: "POLICY_DENIED",
              message: `Tool execution denied by policy: ${toolCall._approval?.reason || "policy rule"}`,
            },
          }));
          const executableToolCalls = pass.pendingToolCalls.filter(
            (toolCall) => !deniedIds.has(toolCall.id),
          );

          let results: ToolResult[] = [];
          if (!isApproved) {
            results = [
              ...executableToolCalls.map((toolCall) => ({
                name: toolCall.name,
                id: toolCall.id,
                result: {
                  success: false,
                  error: "USER_REJECTED",
                  message: "Tool execution was manually rejected by the user.",
                },
              })),
              ...deniedResults,
            ];
          } else {
            if (shouldApproveAll) options.autoApprove = true;
            context._currentMessages = currentMessages;
            results = [
              ...(await executeToolBatch(
                executableToolCalls,
                context,
                this.tools,
                hooks,
                state,
              )),
              ...deniedResults,
            ];
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

          // Drop empty assistant messages — but NEVER thinking-only ones.
          // Deleting a mid-history thinking message orphans its
          // "[System: Reasoning preserved…]" nudge, loses the thinking
          // signature, and mutates the prompt prefix (full re-prefill,
          // busting the provider prompt cache).
          currentMessages = currentMessages.filter(m => !(m.role === "assistant" && !m.content?.trim() && !m.thinking?.trim() && (!m.toolCalls || m.toolCalls.length === 0)));

          injectToolDiscoveryNudge(pass.pendingToolCalls, results, currentMessages, context);
          this.checkAndApplyToolSetChanges(currentMessages, pass.usage);
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
              });
            }
          }

          // Model-invoked compaction (compact_context) — consume at the
          // next iteration boundary via ContextPressureManager
          const hasCompactionRequest = results.some(r => (r.result as any)?._directive === AGENT_DIRECTIVES.REQUEST_COMPACTION);
          if (hasCompactionRequest) {
            state.compactionRequested = true;
          }

          const hasNonBlockingDispatch = results.some(r => (r.result as any)?._directive === AGENT_DIRECTIVES.NON_BLOCKING_DISPATCH);
          if (hasNonBlockingDispatch) {
            hasCleanTextBreak = true;
            hasNonBlockingDispatchBreak = true;
            break;
          }
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
          });
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
        } catch {
          /* best-effort counter adjustment — ignore failures */
        }
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
      // `onError` was declared on AgentHooks from the start but never fired
      // anywhere — this is the only path that can raise, so it is the one
      // seam that makes the event real. Inspect-only: persistLoopError still
      // owns recovery, a hook must not be able to swallow the failure.
      await hooks.run(
        "onError",
        buildHookPayload(HOOK_EVENTS.ERROR, {
          conversationId: context.conversationId,
          agentConversationId: context.agentConversationId as string,
          parentAgentConversationId: context.parentAgentConversationId as string,
          project: context.project,
          username: context.username,
          agent: context.agent,
          workspaceRoot,
        }, { error_message: getErrorMessage(loopError) }),
      );
      return await persistLoopError(
        this,
        currentMessages,
        standardHooks,
        loopError,
        "ReActHarness",
      );
    } finally {
      if (isSubAgentRun) {
        await hooks.run(
          "subagentStop",
          buildHookPayload(HOOK_EVENTS.SUBAGENT_STOP, {
            conversationId: context.conversationId,
            agentConversationId: context.agentConversationId as string,
            parentAgentConversationId:
              context.parentAgentConversationId as string,
            project: context.project,
            username: context.username,
            agent: context.agent,
            workspaceRoot,
          }, { iterations: state.iterations }),
        );
      }
      // Every exit converges here — clean break, budget stop, user abort, or
      // a throw already handled above. `sessionEnd` is observation-only by
      // construction: there is nothing left to block.
      await hooks.run(
        "sessionEnd",
        buildHookPayload(HOOK_EVENTS.SESSION_END, {
          conversationId: context.conversationId,
          agentConversationId: context.agentConversationId as string,
          parentAgentConversationId: context.parentAgentConversationId as string,
          project: context.project,
          username: context.username,
          agent: context.agent,
          workspaceRoot,
        }, { iterations: state.iterations }),
      );
    }
  }
}
