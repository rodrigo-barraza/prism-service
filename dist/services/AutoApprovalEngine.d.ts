/**
 * Tool approval tiers — deterministic, rule-based permission system.
 *
 * Tier 1 (AUTO):    Read-only tools, always execute without prompting.
 * Tier 2 (WRITE):   Write tools, auto-approve in "Full Auto" mode, otherwise prompt.
 * Tier 3 (DANGER):  Destructive / arbitrary execution, always prompt unless Full Auto.
 */
export declare const APPROVAL_TIERS: {
    AUTO: number;
    WRITE: number;
    DANGER: number;
};
/**
 * AutoApprovalEngine — determines whether a tool call should auto-execute
 * or require user approval.
 *
 * Registered as a `beforeToolCall` hook in AgentHooks.
 */
export default class AutoApprovalEngine {
    constructor(options?: Record<string, unknown>);
    /**
     * Get the approval tier for a tool.
  
     * @returns {number} Tier constant (1, 2, or 3)
     */
    getTier(toolName: Record<string, unknown>): any;
    /**
     * Get the tier label for a tool.
  
  
     */
    getTierLabel(toolName: Record<string, unknown>): string;
    /**
     * Check whether a tool call should auto-execute.
     *
  
     * @returns {{ approved: boolean, tier: number, tierLabel: string, reason: string }}
     */
    check(toolCall: Record<string, unknown>): {
        approved: boolean;
        tier: any;
        tierLabel: string;
        reason: string;
    };
    /**
     * Check a batch of tool calls. Returns the ones needing approval.
     *
  
     * @returns {{ autoApproved: Array, needsApproval: Array }}
     */
    checkBatch(toolCalls: Record<string, unknown>): {
        autoApproved: Record<string, unknown>[];
        needsApproval: Record<string, unknown>[];
    };
    /**
     * Create a beforeToolCall hook handler for AgentHooks.
  
     */
    createHook(): (toolCall: Record<string, unknown>, _ctx: Record<string, unknown>) => Promise<{
        approved: boolean;
        tier: any;
        tierLabel: string;
        reason: string;
    }>;
}
//# sourceMappingURL=AutoApprovalEngine.d.ts.map