import {
  DEFAULT_TOPOLOGY,
  DEFAULT_THOUGHT_STRUCTURE,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import AgenticToolResolver from "./AgenticToolResolver.ts";
import AgenticLoopState from "./AgenticLoopState.ts";
import HarnessRegistry from "./harnesses/HarnessRegistry.ts";
import {
  ApprovalRegistry,
  pendingQuestions,
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
import { runPreflightToolDiscovery } from "./harnesses/lifecycle/PreflightToolDiscovery.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
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
  /** Run an agentic loop using the specified (or default) harness. */
  static async runAgenticLoop(
    context: AgenticContext,
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

    // 1. Resolve tools (passing agentConversationId so dynamicEnabledTools is merged)
    let resolvedTools = await AgenticToolResolver.resolve({
      options,
      agent: agent || undefined,
      project,
      username,
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
    const preflight = await runPreflightToolDiscovery({
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
    if (
      !options.isSubAgent &&
      !context.isNewConversation &&
      messages.length > 0
    ) {
      for (let i = 0; i < messages.length - 1; i++) {
        messages[i]._alreadyPersisted = true;
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

    // 2. Initialize shared state
    const state = new AgenticLoopState({
      originalMessageCount: messages.length,
      planModeActive: !!options.planFirst,
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

    // 4. Instantiate and run
    const harness = new HarnessClass(context, state, resolvedTools);
    // Accept mid-turn input (steering, non-blocking answers, completions)
    // for the life of this turn; the harness drains it at its boundaries.
    TurnInputMailbox.open(conversationId);
    try {
      return await harness.run();
    } finally {
      // Clean up in-memory cache keyed by agentConversationId (keeps MongoDB state for next turn)
      ToolContext.cleanupInMemory(resolvedAgentConversationId);

      // Clean up in-memory state keyed by conversationId (client-facing)
      ApprovalRegistry.cancel(resolveLoopKey(context));
      pendingQuestions.delete(conversationId);
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
    }
  }

  // ── Approval Resolution API ─────────────────────────────
  // Keyed by the loop key (resolveLoopKey) — for a root turn, the
  // client-facing conversation id. One decision per tool call.

  /** Apply the user's decision for one pending call (POST /agent/approve). */
  static decideApproval(
    conversationId: string,
    input: ApprovalDecisionInput,
  ): ApprovalDecisionOutcome {
    return ApprovalRegistry.decide(resolveLoopKey({ conversationId }), input);
  }

  /** The calls still waiting for a decision on a conversation's running turn. */
  static getPendingApproval(conversationId: string): {
    isPending: boolean;
    type?: string;
    batchId?: string;
    tools?: string[];
    toolCalls?: PendingToolCallSummary[];
  } {
    const pending = ApprovalRegistry.getPending(resolveLoopKey({ conversationId }));
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

  /** Store a pending question resolver (called by ToolOrchestratorService). */
  static _setPendingQuestion(
    conversationId: string,
    entry: {
      resolve: (value: {
        answers: QuestionAnswer[] | null;
        isTimedOut?: boolean;
      }) => void;
      question?: string;
      questions?: QuestionDefinition[];
      choices?: string[];
    },
  ): void {
    pendingQuestions.set(conversationId, entry);
  }

  /** Resolve a pending question for a conversation. */
  static resolveUserQuestion(
    conversationId: string,
    answers: QuestionAnswer[],
  ): boolean {
    const entry = pendingQuestions.get(conversationId);
    if (!entry) return false;
    pendingQuestions.delete(conversationId);
    entry.resolve({ answers });
    return true;
  }

  /** Check if a conversation has a pending question. */
  static getPendingQuestion(conversationId: string): {
    isPending: boolean;
    question?: string;
    questions?: QuestionDefinition[];
    choices?: string[];
  } {
    const entry = pendingQuestions.get(conversationId);
    if (!entry) return { isPending: false };
    return {
      isPending: true,
      question: entry.question,
      questions: entry.questions,
      choices: entry.choices,
    };
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
