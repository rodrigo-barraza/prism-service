import { DEFAULT_TOPOLOGY, DEFAULT_REASONING_STRATEGY } from "@rodrigo-barraza/utilities-library/taxonomy";
import AgenticToolResolver from "./AgenticToolResolver.ts";
import AgenticLoopState from "./AgenticLoopState.ts";
import HarnessRegistry from "./harnesses/HarnessRegistry.ts";
import {
  pendingApprovals,
  pendingQuestions,
  type PendingToolCallSummary,
  type QuestionDefinition,
  type QuestionAnswer,
} from "./ApprovalRegistry.ts";
import ConversationGenerationTracker from "./ConversationGenerationTracker.ts";
import ToolContext from "./ToolContext.ts";
import logger from "../utils/logger.ts";

import type { AgenticContext, ConversationMessage } from "./harnesses/types.ts";

/**
 * AgenticLoopService — public façade for agentic loop execution.
 *
 * Orchestrates:
 *   1. Tool resolution (AgenticToolResolver)
 *   2. State initialization (AgenticLoopState)
 *   3. Harness selection and instantiation (HarnessRegistry)
 *   4. Reasoning strategy resolution (Chain of Thought / Tree of Thoughts)
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
    const resolvedTools = await AgenticToolResolver.resolve({
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
    if (!toolContextStore.has("dynamicEnabledTools")) {
      const initialNames =
        resolvedTools.resolvedEnabledTools ||
        resolvedTools.finalTools.map((tool) => tool.name);
      ToolContext.set(resolvedAgentConversationId, "dynamicEnabledTools", initialNames);
    }

    // 2. Initialize shared state
    const state = new AgenticLoopState({
      originalMessageCount: messages.length,
      planModeActive: !!options.planFirst,
    });

    // 3. Select harness, topology, and reasoning strategy
    let harnessId = options.harness;
    let topologyId = options.topology;
    let reasoningStrategy = options.reasoningStrategy;
    if (!harnessId || !topologyId || !reasoningStrategy || options.enableCriticGate === undefined) {
      try {
        const { default: SettingsService } =
          await import("./SettingsService.js");
        const agentSettings = await SettingsService.getSection("agents");
        if (!harnessId) harnessId = agentSettings?.harness || "standard";
        if (!topologyId)
          topologyId = agentSettings?.topology || DEFAULT_TOPOLOGY;
        if (!reasoningStrategy)
          reasoningStrategy = (agentSettings?.reasoningStrategy as string) || DEFAULT_REASONING_STRATEGY;

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
            (options.reminderProvider as string) || agentSettings.reminderProvider;
        }
      } catch {
        if (!harnessId) harnessId = "standard";
        if (!topologyId) topologyId = DEFAULT_TOPOLOGY;
        if (!reasoningStrategy) reasoningStrategy = DEFAULT_REASONING_STRATEGY;
      }
    }

    // Migration: legacy "tree_of_thought" harness → standard harness + tree_of_thoughts strategy
    if (harnessId === "tree_of_thought" || harnessId === "tree-of-thought") {
      const legacyHarnessId = harnessId;
      harnessId = "standard";
      reasoningStrategy = "tree_of_thoughts";
      logger.info(
        `[AgenticLoop] Migrated legacy harness "${legacyHarnessId}" → harness "standard" + reasoningStrategy "tree_of_thoughts"`,
      );
    }

    options.harness = harnessId;
    options.topology = topologyId;
    options.reasoningStrategy = reasoningStrategy;
    const HarnessClass = HarnessRegistry.get(harnessId)!;
    logger.info(
      `[AgenticLoop] Using harness: "${HarnessClass.id}" (${HarnessClass.label}), strategy: "${reasoningStrategy}"`,
    );

    // 4. Instantiate and run
    const harness = new HarnessClass(context, state, resolvedTools);
    try {
      return await harness.run();
    } finally {
      // Clean up in-memory cache keyed by agentConversationId (keeps MongoDB state for next turn)
      ToolContext.cleanupInMemory(resolvedAgentConversationId);

      // Clean up in-memory state keyed by conversationId (client-facing)
      pendingApprovals.delete(conversationId);
      pendingQuestions.delete(conversationId);

      // Always clean up per-session tracker entries to prevent memory leaks —
      // sub-agent sessions have their own agentConversationId that must be released.
      ConversationGenerationTracker.cleanup(resolvedAgentConversationId);

      // Only clean up orchestrator state for root sessions — sub-agents are
      // cleaned by the parent session's OrchestratorService.cleanupConversation().
      if (!resolvedParentAgentConversationId) {
        try {
          const { default: OrchestratorService } =
            await import("./OrchestratorService.js");
          OrchestratorService.cleanupConversation(resolvedAgentConversationId);
        } catch {
          /* OrchestratorService may not be used */
        }
      }
    }
  }

  // ── Approval Resolution API ─────────────────────────────
  // Keyed by conversationId — the client-facing conversation identifier.
  // Only one agentic run is active per conversation at a time, so there
  // is no collision risk.

  /** Resolve a pending approval for a conversation. */
  static resolveApproval(
    conversationId: string,
    isApproved: boolean,
    { shouldApproveAll = false }: { shouldApproveAll?: boolean } = {},
  ): boolean {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return false;

    if (entry.type === "plan") {
      entry.resolve(isApproved);
    } else {
      entry.resolve({
        isApproved,
        shouldApproveAll,
        reason: isApproved ? "user_approved" : "user_rejected",
      });
    }
    return true;
  }

  /** Check if a conversation has a pending approval. */
  static getPendingApproval(conversationId: string): {
    isPending: boolean;
    type?: string;
    tools?: string[];
    toolCalls?: PendingToolCallSummary[];
  } {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return { isPending: false };
    return {
      isPending: true,
      type: entry.type,
      tools: entry.tools,
      toolCalls: entry.toolCalls,
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
