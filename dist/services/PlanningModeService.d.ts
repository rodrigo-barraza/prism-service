/**
 * PlanningModeService — implements the "Plan First" workflow using
 * Claude Code's tool-based state machine pattern.
 *
 * When planFirst=true:
 * 1. Loop starts with planModeActive=true (tools stripped)
 * 2. Planning instruction injected into system prompt
 * 3. Model outputs plan text, then calls exit_plan_mode
 * 4. exit_plan_mode triggers plan_proposal + approval gate
 * 5. Approved plan echoed as tool result → model continues with full tools
 */
export default class PlanningModeService {
    /**
     * Inject the planning instruction into the system message.
     * Called once before the agentic loop starts when planFirst=true.
     *
  
     */
    static injectPlanningInstruction(messages: any): void;
    /**
     * Strip the planning instruction from the system message.
     * Called when exiting plan mode so execution doesn't carry stale constraints.
     *
  
     */
    static stripPlanningInstruction(messages: any): void;
    /**
     * Extract step descriptions from a plan for progress tracking.
     *
  
     * @returns {Array<string>} Step descriptions
     */
    static extractSteps(planText: any): any[];
}
//# sourceMappingURL=PlanningModeService.d.ts.map