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
    static runAgenticLoop(context: AgenticContext): Promise<{
        messages: ConversationMessage[];
    }>;
    /** Resolve a pending approval for an agent session. */
    static resolveApproval(agentSessionId: string, approved: boolean, { approveAll }?: {
        approveAll?: boolean;
    }): boolean;
    /** Check if an agent session has a pending approval. */
    static getPendingApproval(agentSessionId: string): {
        pending: boolean;
        type?: string;
        tools?: string[];
    };
    /** Store a pending question resolver (called by ToolOrchestratorService). */
    static _setPendingQuestion(agentSessionId: string, entry: {
        resolve: (value: unknown) => void;
        question?: string;
        questions?: unknown[];
        choices?: string[];
    }): void;
    /** Resolve a pending question for an agent session. */
    static resolveUserQuestion(agentSessionId: string, answers: Array<{
        answer: string | string[];
        annotations?: string;
    }>): boolean;
    /** Check if an agent session has a pending question. */
    static getPendingQuestion(agentSessionId: string): {
        pending: boolean;
        question?: string;
        choices?: string[];
    };
    /** List available harnesses for the settings UI. */
    static listHarnesses(): Array<{
        id: string;
        label: string;
        description: string;
    }>;
}
//# sourceMappingURL=AgenticLoopService.d.ts.map