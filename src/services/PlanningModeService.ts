import logger from "../utils/logger.ts";
import type { ConversationMessage } from "./harnesses/types.ts";

/**
 * Planning instruction injected as a separate message when planFirst=true.
 * Mirrors Claude Code's plan mode: the model explores and designs first,
 * then calls exit_plan_mode to present its plan for approval.
 *
 * CACHE-STABILITY NOTE: This is injected as a standalone message AFTER the
 * system prompt, not appended to it. This preserves the system prompt's
 * content hash across iterations, enabling prefix caching on Anthropic,
 * Gemini context caching, and OpenAI cached prompts.
 */
const PLANNING_INSTRUCTION = `## ⚠️ PLANNING MODE ACTIVE — TOOL ACCESS RESTRICTED

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
 * 2. Planning instruction injected as a separate message (cache-stable)
 * 3. Model outputs plan text, then calls exit_plan_mode
 * 4. exit_plan_mode triggers plan_proposal + approval gate
 * 5. Approved plan echoed as tool result → model continues with full tools
 */
export default class PlanningModeService {
  /**
   * Inject the planning instruction as a separate message after the system prompt.
   *
   * Uses a dedicated message with `_isPlanningInjection: true` marker instead
   * of mutating the system message content. This preserves prefix cache
   * stability across all major providers (Anthropic, Gemini, OpenAI).
   */
  static injectPlanningInstruction(messages: ConversationMessage[]) {
    // Idempotency: don't inject twice
    if (
      messages.some(
        (message) =>
          (message as Record<string, unknown>)._isPlanningInjection === true,
      )
    ) {
      return;
    }

    // Insert AFTER the system message but BEFORE any user messages
    const systemIndex = messages.findIndex((message) => message.role === "system");
    const insertionIndex = systemIndex >= 0 ? systemIndex + 1 : 0;

    messages.splice(insertionIndex, 0, {
      role: "user",
      content: PLANNING_INSTRUCTION,
      _isPlanningInjection: true,
    });

    logger.info(
      "[PlanningMode] Injected planning instruction as separate message (cache-stable)",
    );
  }

  /**
   * Strip the planning instruction message from the conversation.
   * Called when exiting plan mode so execution doesn't carry stale constraints.
   */
  static stripPlanningInstruction(messages: ConversationMessage[]) {
    const injectionIndex = messages.findIndex(
      (message) =>
        (message as Record<string, unknown>)._isPlanningInjection === true,
    );
    if (injectionIndex >= 0) {
      messages.splice(injectionIndex, 1);
      logger.info(
        "[PlanningMode] Stripped planning instruction message",
      );
    }
  }
  static extractSteps(planText: string): string[] {
    const stepRegex = /^\d+\.\s+(.+)$/gm;
    const steps: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = stepRegex.exec(planText)) !== null) {
      steps.push(match[1].trim());
    }
    return steps;
  }
}

