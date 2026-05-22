import AgenticToolResolver from "./AgenticToolResolver.ts";
import AgenticLoopState from "./AgenticLoopState.ts";
import HarnessRegistry from "./harnesses/HarnessRegistry.ts";
import { pendingApprovals, pendingQuestions } from "./ApprovalRegistry.ts";
import SessionGenerationTracker from "./SessionGenerationTracker.ts";
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
      modelDef,
      messages,
      agentSessionId,
      parentAgentSessionId,
    } = context;

    // 1. Resolve tools
    const resolvedTools = await AgenticToolResolver.resolve({
      options,
      agent: agent || undefined,
      project,
      username,
      modelDef: modelDef || undefined,
    });

    // 2. Initialize shared state
    const state = new AgenticLoopState({
      originalMessageCount: messages.length,
      planModeActive: !!options.planFirst,
    });

    // 3. Select harness (from request option → persisted settings → default)
    let harnessId = options.harness;
    if (!harnessId) {
      try {
        const { default: SettingsService } =
          await import("./SettingsService.js");
                const agentSettings = await SettingsService.getSection(("agents" as any));
        harnessId = agentSettings?.harness || "standard";
      } catch {
        harnessId = "standard";
      }
    }
        const HarnessClass = HarnessRegistry.get((harnessId as any));
    logger.info(
      `[AgenticLoop] Using harness: "${HarnessClass.id}" (${HarnessClass.label})`,
    );

    // 4. Instantiate and run
    const harness = new HarnessClass(context, state, resolvedTools);
    try {
      return await harness.run();
    } finally {
      // Clean up
      pendingApprovals.delete(agentSessionId);
      pendingQuestions.delete(agentSessionId);
      if (!parentAgentSessionId) {
        const trackerSessionId = parentAgentSessionId || agentSessionId;
                (SessionGenerationTracker as any).cleanup((trackerSessionId as any));
        try {
          const { default: CoordinatorService } =
            await import("./CoordinatorService.js");
                    CoordinatorService.cleanupSession((agentSessionId as any));
        } catch {
          /* CoordinatorService may not be used */
        }
      }
    }
  }

  // ── Approval Resolution API ─────────────────────────────

  /** Resolve a pending approval for an agent session. */
  static resolveApproval(
    agentSessionId: string,
    approved: boolean,
    { approveAll = false }: { approveAll?: boolean } = {},
  ): boolean {
    const entry = pendingApprovals.get(agentSessionId);
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

  /** Check if an agent session has a pending approval. */
  static getPendingApproval(agentSessionId: string): {
    pending: boolean;
    type?: string;
    tools?: string[];
  } {
    const entry = pendingApprovals.get(agentSessionId);
    if (!entry) return { pending: false };
    return { pending: true, type: entry.type, tools: entry.tools };
  }

  // ── Ask User Question — Resolution API ─────────────────

  /** Store a pending question resolver (called by ToolOrchestratorService). */
  static _setPendingQuestion(
    agentSessionId: string,
    entry: {
      resolve: (value: any) => void;
      question?: string;
      questions?: any[];
      choices?: string[];
    },
  ): void {
    pendingQuestions.set(agentSessionId, entry);
  }

  /** Resolve a pending question for an agent session. */
  static resolveUserQuestion(
    agentSessionId: string,
    answers: Array<{ answer: string | string[]; annotations?: string }>,
  ): boolean {
    const entry = pendingQuestions.get(agentSessionId);
    if (!entry) return false;
    pendingQuestions.delete(agentSessionId);
    entry.resolve({ answers });
    return true;
  }

  /** Check if an agent session has a pending question. */
  static getPendingQuestion(agentSessionId: string): {
    pending: boolean;
    question?: string;
    choices?: string[];
  } {
    const entry = pendingQuestions.get(agentSessionId);
    if (!entry) return { pending: false };
    return { pending: true, question: entry.question, choices: entry.choices };
  }

  // ── Harness Discovery API ──────────────────────────────

  /** List available harnesses for the settings UI. */
  static listHarnesses(): Array<{
    id: string;
    label: string;
    description: string;
  }> {
        // @ts-ignore - TODO: strict typing
        return HarnessRegistry.list();
  }
}
