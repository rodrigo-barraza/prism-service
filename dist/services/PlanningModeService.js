import logger from "../utils/logger.js";
/**
 * Planning instruction injected into the system message when planFirst=true.
 * Mirrors Claude Code's plan mode: the model explores and designs first,
 * then calls exit_plan_mode to present its plan for approval.
 */
const PLANNING_INSTRUCTION = `

## ⚠️ PLANNING MODE ACTIVE — TOOL ACCESS RESTRICTED

**IMPORTANT**: Although the system prompt above may describe various tools (team_create, execute_shell, read_file, etc.), you are in PLANNING MODE and **CANNOT use any of them**.

The ONLY tools available to you right now are:
- **exit_plan_mode** — Call this when your plan is complete to submit it for user approval
- **think** — Use for internal reasoning

Any other tool calls WILL BE BLOCKED. Do not attempt to call team_create, execute_shell, read_file, write_file, or any other tool.

**What to do:**
1. Analyze the user's request
2. Design your implementation approach as text output
3. Call exit_plan_mode when ready — the user will review and approve before you can execute

Keep your plan concise. For simple tasks, a brief summary is sufficient.`;
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
    static injectPlanningInstruction(messages) {
        const systemMsg = messages.find((m) => m.role === "system");
        if (systemMsg) {
            // Idempotency: don't append twice
            if (systemMsg.content.includes("PLANNING MODE ACTIVE"))
                return;
            systemMsg.content = systemMsg.content + PLANNING_INSTRUCTION;
        }
        else {
            messages.unshift({
                role: "system",
                content: PLANNING_INSTRUCTION.trim(),
            });
        }
        logger.info("[PlanningMode] Injected planning instruction into system prompt");
    }
    /**
     * Strip the planning instruction from the system message.
     * Called when exiting plan mode so execution doesn't carry stale constraints.
     *
  
     */
    static stripPlanningInstruction(messages) {
        const systemMsg = messages.find((m) => m.role === "system");
        if (systemMsg && systemMsg.content.includes("PLANNING MODE ACTIVE")) {
            systemMsg.content = systemMsg.content.replace(PLANNING_INSTRUCTION, "");
            logger.info("[PlanningMode] Stripped planning instruction from system prompt");
        }
    }
    /**
     * Extract step descriptions from a plan for progress tracking.
     *
  
     * @returns {Array<string>} Step descriptions
     */
    static extractSteps(planText) {
        const stepRegex = /^\d+\.\s+(.+)$/gm;
        const steps = [];
        let match;
        while ((match = stepRegex.exec(planText)) !== null) {
            steps.push(match[1].trim());
        }
        return steps;
    }
}
//# sourceMappingURL=PlanningModeService.js.map