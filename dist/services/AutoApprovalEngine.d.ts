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
    constructor(options?: any);
    /**
     * Get the approval tier for a tool.
  
     * @returns {number} Tier constant (1, 2, or 3)
     */
    getTier(toolName: any): any;
    /**
     * Get the tier label for a tool.
  
  
     */
    getTierLabel(toolName: any): string;
    /**
     * Check whether a tool call should auto-execute.
     *
  
     * @returns {{ approved: boolean, tier: number, tierLabel: string, reason: string }}
     */
    check(toolCall: any): {
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
    checkBatch(toolCalls: any): {
        autoApproved: any[];
        needsApproval: any[];
    };
    /**
     * Create a beforeToolCall hook handler for AgentHooks.
  
     */
    createHook(): (toolCall: any, _ctx: any) => Promise<{
        approved: boolean;
        tier: any;
        tierLabel: string;
        reason: string;
    }>;
}
//# sourceMappingURL=AutoApprovalEngine.d.ts.map