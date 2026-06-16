import { DEFAULT_TOPOLOGY } from "@rodrigo-barraza/utilities-library/taxonomy";
import AgenticToolResolver from "./AgenticToolResolver.ts";
import AgenticLoopState from "./AgenticLoopState.ts";
import HarnessRegistry from "./harnesses/HarnessRegistry.ts";
import { pendingApprovals, pendingQuestions, type PendingToolCallSummary, type QuestionDefinition, type QuestionAnswer } from "./ApprovalRegistry.ts";
import SessionGenerationTracker from "./SessionGenerationTracker.ts";
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
 *   4. Cleanup (approvals, questions, session tracking)
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
      agentSessionId,
      conversationId,
      parentAgentSessionId,
    } = context;

    // Load any persisted tool state from MongoDB (e.g. after server restart or previous turn)
    await ToolContext.ensureLoaded(agentSessionId);

    // 1. Resolve tools (passing agentSessionId so dynamicEnabledTools is merged)
    const resolvedTools = await AgenticToolResolver.resolve({
      options,
      agent: agent || undefined,
      project,
      username,
      modelDefinition: modelDefinition || undefined,
      agentSessionId,
    });

    // If dynamicEnabledTools is not in ToolContext, populate it with the resolved tools
    const toolContextStore = ToolContext.getStore(agentSessionId);
    if (!toolContextStore.has("dynamicEnabledTools")) {
      const initialNames = resolvedTools.resolvedEnabledTools || resolvedTools.finalTools.map((tool) => tool.name);
      ToolContext.set(agentSessionId, "dynamicEnabledTools", initialNames);
    }

    // 2. Initialize shared state
    const state = new AgenticLoopState({
      originalMessageCount: messages.length,
      planModeActive: !!options.planFirst,
    });

    // 3. Select harness (from request option → persisted settings → default)
    let harnessId = options.harness;
    let topologyId = options.topology;
    if (!harnessId || !topologyId || options.enableCriticGate === undefined) {
      try {
        const { default: SettingsService } =
          await import("./SettingsService.js");
        const agentSettings = await SettingsService.getSection("agents");
        if (!harnessId) harnessId = agentSettings?.harness || "standard";
        if (!topologyId) topologyId = agentSettings?.topology || DEFAULT_TOPOLOGY;

        // CriticGate: auto-enable from settings when a critic model is configured
        // and the request didn't explicitly set enableCriticGate.
        if (options.enableCriticGate === undefined && agentSettings?.criticModel) {
          options.enableCriticGate = true;
          options.criticModel = options.criticModel || agentSettings.criticModel;
        }
      } catch {
        if (!harnessId) harnessId = "standard";
        if (!topologyId) topologyId = DEFAULT_TOPOLOGY;
      }
    }
    options.harness = harnessId;
    options.topology = topologyId;
    const HarnessClass = HarnessRegistry.get(harnessId)!;
    logger.info(
      `[AgenticLoop] Using harness: "${HarnessClass.id}" (${HarnessClass.label})`,
    );

    // 4. Instantiate and run
    const harness = new HarnessClass(context, state, resolvedTools);
    try {
      return await harness.run();
    } finally {
      // Clean up in-memory cache keyed by agentSessionId (keeps MongoDB state for next turn)
      ToolContext.cleanupInMemory(agentSessionId);

      // Clean up in-memory state keyed by conversationId (client-facing)
      pendingApprovals.delete(conversationId);
      pendingQuestions.delete(conversationId);

      // Always clean up per-session tracker entries to prevent memory leaks —
      // sub-agent sessions have their own agentSessionId that must be released.
      SessionGenerationTracker.cleanup(agentSessionId);

      // Only clean up orchestrator state for root sessions — sub-agents are
      // cleaned by the parent session's OrchestratorService.cleanupSession().
      if (!parentAgentSessionId) {
        try {
          const { default: OrchestratorService } =
            await import("./OrchestratorService.js");
          OrchestratorService.cleanupSession(agentSessionId);
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
    approved: boolean,
    { approveAll = false }: { approveAll?: boolean } = {},
  ): boolean {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return false;

    if (entry.type === "plan") {
      entry.resolve(approved);
    } else {
      entry.resolve({
        approved,
        approveAll,
        reason: approved ? "user_approved" : "user_rejected",
      });
    }
    return true;
  }

  /** Check if a conversation has a pending approval. */
  static getPendingApproval(conversationId: string): {
    pending: boolean;
    type?: string;
    tools?: string[];
    toolCalls?: PendingToolCallSummary[];
  } {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return { pending: false };
    return {
      pending: true,
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
      resolve: (value: { answers: QuestionAnswer[] | null; timedOut?: boolean }) => void;
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
    pending: boolean;
    question?: string;
    questions?: QuestionDefinition[];
    choices?: string[];
  } {
    const entry = pendingQuestions.get(conversationId);
    if (!entry) return { pending: false };
    return {
      pending: true,
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
    return HarnessRegistry.list() as Array<{ id: string; label: string; description: string }>;
  }
}
