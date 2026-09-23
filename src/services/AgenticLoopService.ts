import {
  DEFAULT_TOPOLOGY,
  DEFAULT_THOUGHT_STRUCTURE,
  THOUGHT_STRUCTURES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import AgenticToolResolver from "./AgenticToolResolver.ts";
import AgenticLoopState from "./AgenticLoopState.ts";
import HarnessRegistry from "./harnesses/HarnessRegistry.ts";
import {
  ApprovalRegistry,
  type ApprovalDecisionInput,
  type ApprovalDecisionOutcome,
  type PendingToolCallSummary,
  type QuestionDefinition,
  type QuestionAnswer,
} from "./ApprovalRegistry.ts";
import ConversationApprovalSettings from "./ConversationApprovalSettings.ts";
import { resolveLoopKey } from "./LoopKey.ts";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import ConversationGenerationTracker from "./ConversationGenerationTracker.ts";
import ConversationStatusRegistry from "./ConversationStatusRegistry.ts";
import ToolContext from "./ToolContext.ts";
import { recordAgentTurnOutcome, traceAgentTurn } from "./Tracing.ts";
import type { Span } from "@opentelemetry/api";
import QuestionRegistry, {
  type PendingQuestionSummary,
  type QuestionAnswerOutcome,
} from "./QuestionRegistry.ts";
import type { DecisionOwner } from "./PendingDecisionStore.ts";
import { decisionOwnerOf } from "./conversation/ConversationRunState.ts";
import { endTurnRun } from "./harnesses/lifecycle/TurnRunRecorder.ts";
import { runPreflightToolDiscovery } from "./harnesses/lifecycle/PreflightToolDiscovery.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { TURN_RESUME } from "#src/constants";
import logger from "#src/utils/logger";

import type { AgenticContext, ConversationMessage } from "./harnesses/types.ts";

/**
 * AgenticLoopService — public façade for agentic loop execution.
 *
 * Orchestrates:
 *   1. Tool resolution (AgenticToolResolver)
 *   2. State initialization (AgenticLoopState)
 *   3. Harness selection and instantiation (HarnessRegistry)
 *   4. Thought structure resolution (Chain of Thought / Tree of Thoughts / Graph of Thoughts)
 *   5. Cleanup (approvals, questions, session tracking)
 *
 * Also exposes approval/question resolution APIs used by AgentRoutes.
 */
export default class AgenticLoopService {
  /**
   * Run an agentic loop using the specified (or default) harness, as one
   * `invoke_agent` span (Tracing) — every entry point comes through here.
   */
  static async runAgenticLoop(
    context: AgenticContext,
  ): Promise<{ messages: ConversationMessage[] }> {
    return traceAgentTurn(context, (turnSpan) =>
      AgenticLoopService.runTurn(context, turnSpan),
    );
  }

  private static async runTurn(
    context: AgenticContext,
    turnSpan: Span,
  ): Promise<{ messages: ConversationMessage[] }> {
    const {
      options,
      agent,
      project,
      username,
      modelDefinition,
      messages,
      agentConversationId,
      conversationId,
      parentAgentConversationId,
    } = context;

    const resolvedAgentConversationId = agentConversationId || "";
    const resolvedParentAgentConversationId = parentAgentConversationId || null;

    // Load any persisted tool state from MongoDB (e.g. after server restart or previous turn)
    await ToolContext.ensureLoaded(resolvedAgentConversationId);

    // Permission rules resolve here, inside the loop, so every entry point —
    // the chat route, scheduled tasks, conversation timers, sub-agents and
    // auto-responses — is checked against them. A sub-agent arrives with its
    // parent's rule set already on the options and keeps it.
    if (!options._permissionRules) {
      const { default: PermissionRuleSet } = await import(
        "./permissions/PermissionRuleSet.ts"
      );
      options._permissionRules = await PermissionRuleSet.load({
        username,
        profileId: context.profileId,
        project,
        agent,
        conversationId,
        workspaceRoot: context.workspaceRoot,
      });
    }

    // 1. Resolve tools (passing agentConversationId so dynamicEnabledTools is merged)
    let resolvedTools = await AgenticToolResolver.resolve({
      options,
      agent: agent || undefined,
      project,
      username,
      profileId: context.profileId,
      modelDefinition: modelDefinition || undefined,
      agentConversationId: resolvedAgentConversationId,
      providerName: context.providerName,
      resolvedModel: context.resolvedModel,
    });

    // If dynamicEnabledTools is not in ToolContext, populate it with the resolved tools
    const toolContextStore = ToolContext.getStore(resolvedAgentConversationId);
    const baselineNames =
      resolvedTools.resolvedEnabledTools ||
      resolvedTools.finalTools.map((tool) => tool.name);
    if (!toolContextStore.has("dynamicEnabledTools")) {
      ToolContext.set(
        resolvedAgentConversationId,
        "dynamicEnabledTools",
        baselineNames,
      );
    }
    // Record the seeded baseline once, so discovery caps count only the tools
    // discovery ADDED, not the baseline itself (a >30-tool client baseline
    // used to trip MAX_PREFLIGHT_DYNAMIC_TOOL_TOTAL and permanently disable
    // preflight). Pre-existing conversations get today's resolved set as a
    // stand-in seed — over-counting the seed only errs toward keeping
    // preflight alive.
    if (!toolContextStore.has("dynamicSeedTools")) {
      ToolContext.set(
        resolvedAgentConversationId,
        "dynamicSeedTools",
        baselineNames,
      );
    }

    // 1.5. Pre-flight tool discovery: search the catalog against the user's
    // message and pre-enable the top matches BEFORE the first provider call,
    // so the tool set stays stable across the loop (prompt-cache friendly)
    // and the model skips the discover_and_enable_tools round-trip in the
    // common case. Runs AFTER the seeding block above so the merge preserves
    // the full resolved base set (dynamicEnabledTools now holds it).
    // Fail-open — any error and the loop proceeds with the original tools.
    // A re-driven turn already discovered what it needed: its tool set was
    // persisted (ToolContext) before the restart.
    const preflight = context.resume
      ? { enabledTools: [] as string[] }
      : await runPreflightToolDiscovery({
          context,
          resolvedTools,
        });
    if (preflight.enabledTools.length > 0) {
      // Re-resolve so the enlarged dynamic set flows through the exact same
      // filter pipeline (blocked/disabled/native-collision/sub-agent rules).
      // The client's disabledTools list is a snapshot of "not enabled when
      // the request was sent" — it necessarily still lists the tools
      // preflight just enabled, so prune them from the copy passed to the
      // re-resolve or Mode 1's client-disabled filter would immediately
      // strip every preflight enablement.
      const preflightEnabledSet = new Set(preflight.enabledTools);
      const reResolveOptions =
        Array.isArray(options.disabledTools) && options.disabledTools.length > 0
          ? {
              ...options,
              disabledTools: options.disabledTools.filter(
                (toolName: string) => !preflightEnabledSet.has(toolName),
              ),
            }
          : options;
      resolvedTools = await AgenticToolResolver.resolve({
        options: reResolveOptions,
        agent: agent || undefined,
        project,
        username,
        profileId: context.profileId,
        modelDefinition: modelDefinition || undefined,
        agentConversationId: resolvedAgentConversationId,
        providerName: context.providerName,
        resolvedModel: context.resolvedModel,
      });
      context.emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.TOOL_SET_CHANGED,
        enabledCount: resolvedTools.finalTools.length,
        dynamicTools: preflight.enabledTools,
        preflight: true,
      });
    }

    // If this is a top-level agent request with an existing conversation,
    // all messages except the last one (the triggering input) are already
    // persisted in the database. For new conversations (e.g. Discord channel
    // history passed as ephemeral context), nothing has been persisted yet.
    // A re-driven turn arrives marked: its history is persisted, the
    // messages its checkpoint carried are not (TurnResumeService).
    if (
      !options.isSubAgent &&
      !context.isNewConversation &&
      !context.resume &&
      messages.length > 0
    ) {
      for (let i = 0; i < messages.length - 1; i++) {
        messages[i]._alreadyPersisted = true;
      }
    }

    // Persona-level policies (a custom agent's DENY/ASK_USER/APPROVE rules)
    // are resolved HERE, for every entry point — the HTTP route, scheduled
    // tasks, conversation timers and sub-agents. Those other entry points run
    // with autoApprove, so a policy that only the route injected was a DENY
    // that silently did not apply. Policies already on the options (e.g.
    // inherited from a parent orchestrator) win.
    if (agent && !options.policies) {
      const { default: AgentPersonaRegistry } = await import(
        "./AgentPersonaRegistry.ts"
      );
      const persona = AgentPersonaRegistry.get(agent);
      if (persona?.policies && persona.policies.length > 0) {
        options.policies = persona.policies;
      }
    }

    // "Auto-approve this conversation" (an approval card's conversation
    // scope) is persisted on the conversation, so it holds for every later
    // turn of it — and of no other. Root turns only: a sub-agent inherits
    // its parent's approval mode through its options.
    if (
      !options.autoApprove &&
      !options.isSubAgent &&
      !context.isNewConversation &&
      conversationId &&
      (await ConversationApprovalSettings.isAutoApproveEnabled(
        conversationId,
        project,
        username,
      ))
    ) {
      options.autoApprove = true;
    }

    // The turn's permission mode. A sub-agent arrives with its parent's
    // handle and keeps it; a root turn resolves one and registers it, so the
    // selector can switch the mode while the turn runs.
    const permissionModeCleanup = options._permissionMode
      ? null
      : await AgenticLoopService.openPermissionMode(context);

    // 2. Initialize shared state
    const state = new AgenticLoopState({
      originalMessageCount: messages.length,
      planModeActive: context.resume ? context.resume.planModeActive : !!options.planFirst,
    });

    // Cost ceiling: create the tree-wide accumulator at the root loop.
    // Sub-agents receive the SAME object through their options, so spend
    // anywhere in the delegation tree counts against one budget.
    if (
      typeof options.maxCostDollars === "number" &&
      options.maxCostDollars > 0 &&
      !options._sharedCostBudget
    ) {
      const { SharedCostBudget } = await import(
        "./harnesses/lifecycle/CostBudgetEnforcer.ts"
      );
      options._sharedCostBudget = new SharedCostBudget(options.maxCostDollars);
    }

    // 3. Select harness, topology, and thought structure
    let harnessId = options.harness;
    let topologyId = options.topology;
    let thoughtStructure = options.thoughtStructure;
    if (
      !harnessId ||
      !topologyId ||
      !thoughtStructure ||
      options.enableCriticGate === undefined
    ) {
      try {
        const { default: SettingsService } =
          await import("./SettingsService.ts");
        const agentSettings = await SettingsService.getSection("agents");
        if (!harnessId) harnessId = agentSettings?.harness || "standard";
        if (!topologyId)
          topologyId = agentSettings?.topology || DEFAULT_TOPOLOGY;
        if (!thoughtStructure)
          thoughtStructure =
            (agentSettings?.thoughtStructure as string) ||
            DEFAULT_THOUGHT_STRUCTURE;

        // CriticGate: auto-enable from settings when a critic model is configured
        // and the request didn't explicitly set enableCriticGate.
        if (
          options.enableCriticGate === undefined &&
          agentSettings?.criticModel
        ) {
          options.enableCriticGate = true;
          options.criticModel =
            options.criticModel || agentSettings.criticModel;
        }

        // SystemReminderInjector: auto-populate from settings when a reminder model is configured
        if (agentSettings?.reminderModel) {
          options.reminderModel =
            (options.reminderModel as string) || agentSettings.reminderModel;
          options.reminderProvider =
            (options.reminderProvider as string) ||
            agentSettings.reminderProvider;
        }
      } catch {
        if (!harnessId) harnessId = "standard";
        if (!topologyId) topologyId = DEFAULT_TOPOLOGY;
        if (!thoughtStructure) thoughtStructure = DEFAULT_THOUGHT_STRUCTURE;
      }
    }

    options.harness = harnessId;
    options.topology = topologyId;
    options.thoughtStructure = thoughtStructure;
    const HarnessClass = HarnessRegistry.get(harnessId)!;
    logger.info(
      `[AgenticLoop] Using harness: "${HarnessClass.id}" (${HarnessClass.label}), thoughtStructure: "${thoughtStructure}"`,
    );

    // Only the ReAct chain of thought replays a stored pass; any other
    // shape starts the interrupted step over (and supersedes its cards).
    if (
      context.resume &&
      (HarnessClass.id !== "standard" ||
        thoughtStructure === THOUGHT_STRUCTURES.TREE_OF_THOUGHTS ||
        thoughtStructure === THOUGHT_STRUCTURES.GRAPH_OF_THOUGHTS)
    ) {
      logger.info(
        `[AgenticLoop] ${conversationId}: harness "${HarnessClass.id}" / "${thoughtStructure}" cannot replay a pass — the interrupted step starts over`,
      );
      context.resume = null;
    }

    // 4. Instantiate and run
    const harness = new HarnessClass(context, state, resolvedTools);
    const loopKey = resolveLoopKey(context);
    if (context.resume) {
      // Picks up where the restart interrupted it: the pass is replayed at
      // its own iteration, and its decisions are its own — not orphans. The
      // loop state a checkpoint does not carry comes back with it.
      state.iterations = context.resume.pass.iteration - 1;
      if (context.resume.autoApprove) options.autoApprove = true;
      if (context.resume.skillsText && !options._skillsText) {
        options._skillsText = context.resume.skillsText;
      }
    } else {
      // Decisions still pending from a turn that died with a previous process
      // will never be acted on by this one: the user moved on. Supersede them
      // (and close their "needs you" entries) before this turn asks anything.
      await AgenticLoopService.retireOrphanedDecisions(loopKey);
    }
    // Accept mid-turn input (steering, non-blocking answers, completions)
    // for the life of this turn; the harness drains it at its boundaries.
    // What it accepts is kept durably until the turn ends (TurnInputStore).
    TurnInputMailbox.open(conversationId, decisionOwnerOf(context));
    if (context.resume) await AgenticLoopService.reopenResumedTurn(context, loopKey);
    try {
      return await harness.run();
    } finally {
      recordAgentTurnOutcome(turnSpan, state);
      permissionModeCleanup?.();

      // Clean up in-memory cache keyed by agentConversationId (keeps MongoDB state for next turn)
      ToolContext.cleanupInMemory(resolvedAgentConversationId);

      // The turn is over: whatever it still waited on lapses (persisted as such).
      await ApprovalRegistry.cancel(loopKey);
      await QuestionRegistry.cancelAll(loopKey);
      TurnInputMailbox.close(conversationId);

      // Always clean up per-session tracker entries to prevent memory leaks —
      // sub-agent sessions have their own agentConversationId that must be released.
      ConversationGenerationTracker.cleanup(resolvedAgentConversationId);

      // Remove the live status entry so clients no longer see this conversation
      // as actively generating after the loop ends.
      ConversationStatusRegistry.remove(resolvedAgentConversationId);

      // Only clean up orchestrator state for root sessions — sub-agents are
      // cleaned by the parent session's OrchestratorService.cleanupConversation().
      if (!resolvedParentAgentConversationId) {
        try {
          const { default: OrchestratorService } =
            await import("./OrchestratorService.ts");
          OrchestratorService.cleanupConversation(resolvedAgentConversationId);
        } catch {
          /* OrchestratorService may not be used */
        }
      }

      // Nothing is left to re-drive: the turn ended in this process.
      await endTurnRun(context);
    }
  }

  /**
   * Resolve the turn's permission mode into a live handle on the options
   * (`_permissionMode`), tell the client which mode the turn runs in, and —
   * for a root turn — register the handle so `PUT /permissions/mode` can
   * switch it mid-turn. Returns the cleanup for the turn's end.
   *
   * A new conversation keeps the mode its first request named (the client's
   * selector); after that only the selector (`PUT /permissions/mode`) and an
   * approved plan change what is stored, so a timer's `dontAsk` never
   * overwrites the user's choice.
   */
  static async openPermissionMode(context: AgenticContext): Promise<() => void> {
    const { options, conversationId, project, username } = context;
    const [
      { PermissionModeHandle, PermissionModeRegistry, resolveTurnPermissionMode },
      { PERMISSION_MODE_EVENT_TYPE },
    ] = await Promise.all([
      import("./permissions/PermissionModeState.ts"),
      import("./permissions/PermissionModes.ts"),
    ]);
    const isRoot = !options.isSubAgent;
    // A sub-agent's own conversation never stores a mode; it inherits one.
    const storedMode =
      isRoot && conversationId && !context.isNewConversation
        ? await ConversationApprovalSettings.getPermissionMode(conversationId, project, username)
        : null;
    const resolved = await resolveTurnPermissionMode({
      requested: options.permissionMode,
      unattended: options.unattended === true,
      storedMode,
      username,
    });
    const handle = new PermissionModeHandle(resolved.mode, {
      source: resolved.source,
      unattended: options.unattended === true,
    });
    options._permissionMode = handle;
    if (resolved.refusedBypass) {
      logger.warn(
        `[PermissionModes] ${conversationId}: ${resolved.refusedBypass.reason}; running in ${resolved.mode}`,
      );
    }
    if (!isRoot || !conversationId) return () => {};

    if (context.isNewConversation && resolved.source === "request") {
      void ConversationApprovalSettings.setPermissionMode(
        conversationId,
        project,
        username,
        resolved.mode,
      ).catch((error: unknown) =>
        logger.warn(`[PermissionModes] Could not store the mode of ${conversationId}: ${String(error)}`),
      );
    }

    context.emit({
      type: PERMISSION_MODE_EVENT_TYPE,
      conversationId,
      mode: resolved.mode,
      source: resolved.source,
      ...(options.unattended === true && { unattended: true }),
      ...(resolved.refusedBypass && { refused: "bypass", reason: resolved.refusedBypass.reason }),
    });
    const stopListening = handle.onChange((change) => {
      context.emit({
        type: PERMISSION_MODE_EVENT_TYPE,
        conversationId,
        mode: change.mode,
        previousMode: change.previousMode,
        source: change.source,
      });
    });
    PermissionModeRegistry.register(conversationId, handle);
    return () => {
      stopListening();
      PermissionModeRegistry.unregister(conversationId, handle);
    };
  }

  // ── Approval Resolution API ─────────────────────────────
  // Keyed by the loop key (resolveLoopKey) — for a root turn, the
  // client-facing conversation id. One decision per tool call.

  /** Apply the user's decision for one pending call (POST /agent/approve). */
  static async decideApproval(
    conversationId: string,
    input: ApprovalDecisionInput,
  ): Promise<ApprovalDecisionOutcome> {
    return ApprovalRegistry.decide(resolveLoopKey({ conversationId }), input);
  }

  /**
   * The calls still waiting for a decision on a conversation — its running
   * turn's, or those of a turn parked when the previous process stopped.
   */
  static async getPendingApproval(conversationId: string): Promise<{
    isPending: boolean;
    type?: string;
    batchId?: string;
    tools?: string[];
    toolCalls?: PendingToolCallSummary[];
  }> {
    const pending = await ApprovalRegistry.getPending(resolveLoopKey({ conversationId }));
    if (!pending || pending.toolCalls.length === 0) return { isPending: false };
    return {
      isPending: true,
      type: pending.type,
      batchId: pending.batchId,
      tools: pending.toolCalls.map((toolCall) => toolCall.name),
      toolCalls: pending.toolCalls,
    };
  }

  // ── Ask User Question — Resolution API ─────────────────
  // Filed under the LOOP KEY (LoopKey.resolveLoopKey) — the id the client
  // answers with; several per loop, each by questionId. See QuestionRegistry.

  /** File a pending question under its loop (called by the ask_user tool). */
  static async _setPendingQuestion(
    loopKey: string,
    entry: {
      questionId: string;
      blocking: boolean;
      createdAt: number;
      agentConversationId?: string | null;
      resolve: (value: {
        answers: QuestionAnswer[] | null;
        isCancelled?: boolean;
      }) => { delivered: boolean; reason?: string } | void;
      question?: string;
      questions?: QuestionDefinition[];
      choices?: string[];
      toolCallId?: string | null;
    },
    owner: DecisionOwner = {},
  ): Promise<void> {
    await QuestionRegistry.register(loopKey, entry, owner);
  }

  /** Withdraw one question unanswered (its turn was stopped). */
  static async _removePendingQuestion(loopKey: string, questionId: string): Promise<void> {
    await QuestionRegistry.remove(loopKey, questionId);
  }

  /**
   * Answer a pending question: `conversationId` is the loop key, the legacy
   * `agentConversationId` is also tried; `questionId` picks the card, else
   * the oldest blocking question is answered.
   */
  static async resolveUserQuestion(
    conversationId: string,
    answers: QuestionAnswer[],
    options: { questionId?: string; agentConversationId?: string } = {},
  ): Promise<QuestionAnswerOutcome> {
    return QuestionRegistry.answer(conversationId, answers, options);
  }

  /** Every open question on a loop, oldest first. */
  static async listPendingQuestions(loopKey: string): Promise<PendingQuestionSummary[]> {
    return QuestionRegistry.list(loopKey);
  }

  /** The question a reloaded client shows: the oldest blocking one, else the oldest open card. */
  static async getPendingQuestion(
    loopKey: string,
  ): Promise<{ isPending: boolean } & Partial<PendingQuestionSummary>> {
    const pending = await QuestionRegistry.getPending(loopKey);
    return pending ? { isPending: true, ...pending } : { isPending: false };
  }

  /**
   * Supersede the decisions a dead turn left pending on this loop (see
   * runAgenticLoop) and close their "needs you" entries. Best-effort.
   */
  static async retireOrphanedDecisions(loopKey: string): Promise<void> {
    if (!loopKey) return;
    try {
      const retired = [
        ...(await ApprovalRegistry.retireOrphans(loopKey)),
        ...(await QuestionRegistry.retireOrphans(loopKey)),
      ];
      if (retired.length === 0) return;
      logger.info(
        `[AgenticLoop] A new turn on ${loopKey} superseded ${retired.length} decision(s) left pending by an earlier process`,
      );
      const { default: ConversationAttentionRegistry } = await import(
        "./ConversationAttentionRegistry.ts"
      );
      ConversationAttentionRegistry.forget(retired);
    } catch (error: unknown) {
      logger.warn(
        `[AgenticLoop] Could not retire orphaned decisions on ${loopKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * A re-driven turn's mailbox is open: give it what the restart owed it —
   * the input accepted before the restart and never delivered (same ids),
   * the notices of background work the restart cut off, and the
   * non-blocking cards it asked before (open ones answer into it; answers
   * that came while the server was down are delivered now). Each once.
   */
  static async reopenResumedTurn(context: AgenticContext, loopKey: string): Promise<void> {
    const resume = context.resume;
    if (!resume) return;
    for (const entry of resume.inputs) TurnInputMailbox.restore(loopKey, entry);
    for (const notice of resume.notices) TurnInputMailbox.post(loopKey, notice);
    try {
      const { adoptNonBlockingQuestions } = await import(
        "./tool-definitions/AskUserQuestionTool.ts"
      );
      await adoptNonBlockingQuestions(loopKey, decisionOwnerOf(context));
    } catch (error: unknown) {
      logger.warn(
        `[AgenticLoop] Could not adopt the open questions of ${loopKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    context.emit({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: TURN_RESUME.STATUS_RESUMED,
      iteration: resume.pass.iteration,
      attempt: resume.attempt,
    });
    logger.info(
      `[AgenticLoop] Re-driving ${loopKey} from iteration ${resume.pass.iteration} (attempt ${resume.attempt}): ` +
        `${resume.pass.toolCalls.length} call(s) replayed, ${resume.inputs.length} input(s) restored, ${resume.notices.length} notice(s)`,
    );
  }

  // ── Harness Discovery API ──────────────────────────────

  /** List available harnesses for the settings UI. */
  static listHarnesses(): Array<{
    id: string;
    label: string;
    description: string;
  }> {
    return HarnessRegistry.list() as Array<{
      id: string;
      label: string;
      description: string;
    }>;
  }
}
