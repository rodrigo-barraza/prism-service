import AgenticToolResolver from "./AgenticToolResolver.js";
import AgenticLoopState from "./AgenticLoopState.js";
import HarnessRegistry from "./harnesses/HarnessRegistry.js";
import { pendingApprovals, pendingQuestions } from "./ApprovalRegistry.js";
import SessionGenerationTracker from "./SessionGenerationTracker.js";
import logger from "../utils/logger.js";
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
    static async runAgenticLoop(context) {
        const { options, agent, project, username, modelDef, messages, agentSessionId, parentAgentSessionId, } = context;
        // 1. Resolve tools
        const resolvedTools = await AgenticToolResolver.resolve({
            options,
            agent,
            project,
            username,
            modelDef,
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
                const { default: SettingsService } = await import("./SettingsService.js");
                const agentSettings = await SettingsService.getSection("agents");
                harnessId = agentSettings?.harness || "standard";
            }
            catch {
                harnessId = "standard";
            }
        }
        const HarnessClass = HarnessRegistry.get(harnessId);
        logger.info(`[AgenticLoop] Using harness: "${HarnessClass.id}" (${HarnessClass.label})`);
        // 4. Instantiate and run
        const harness = new HarnessClass(context, state, resolvedTools);
        try {
            return await harness.run();
        }
        finally {
            // Clean up
            pendingApprovals.delete(agentSessionId);
            pendingQuestions.delete(agentSessionId);
            if (!parentAgentSessionId) {
                const trackerSessionId = parentAgentSessionId || agentSessionId;
                SessionGenerationTracker.cleanup(trackerSessionId);
                try {
                    const { default: CoordinatorService } = await import("./CoordinatorService.js");
                    CoordinatorService.cleanupSession(agentSessionId);
                }
                catch {
                    /* CoordinatorService may not be used */
                }
            }
        }
    }
    // ── Approval Resolution API ─────────────────────────────
    /** Resolve a pending approval for an agent session. */
    static resolveApproval(agentSessionId, approved, { approveAll = false } = {}) {
        const entry = pendingApprovals.get(agentSessionId);
        if (!entry)
            return false;
        if (entry.type === "plan") {
            entry.resolve(approved);
        }
        else {
            entry.resolve({
                approved,
                approveAll,
                reason: approved ? "user_approved" : "user_rejected",
            });
        }
        return true;
    }
    /** Check if an agent session has a pending approval. */
    static getPendingApproval(agentSessionId) {
        const entry = pendingApprovals.get(agentSessionId);
        if (!entry)
            return { pending: false };
        return { pending: true, type: entry.type, tools: entry.tools };
    }
    // ── Ask User Question — Resolution API ─────────────────
    /** Store a pending question resolver (called by ToolOrchestratorService). */
    static _setPendingQuestion(agentSessionId, entry) {
        pendingQuestions.set(agentSessionId, entry);
    }
    /** Resolve a pending question for an agent session. */
    static resolveUserQuestion(agentSessionId, answers) {
        const entry = pendingQuestions.get(agentSessionId);
        if (!entry)
            return false;
        pendingQuestions.delete(agentSessionId);
        entry.resolve({ answers });
        return true;
    }
    /** Check if an agent session has a pending question. */
    static getPendingQuestion(agentSessionId) {
        const entry = pendingQuestions.get(agentSessionId);
        if (!entry)
            return { pending: false };
        return { pending: true, question: entry.question, choices: entry.choices };
    }
    // ── Harness Discovery API ──────────────────────────────
    /** List available harnesses for the settings UI. */
    static listHarnesses() {
        return HarnessRegistry.list();
    }
}
//# sourceMappingURL=AgenticLoopService.js.map