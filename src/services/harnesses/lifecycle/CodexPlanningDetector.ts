import logger from "../../../utils/logger.ts";
import PromptLocaleService from "../../PromptLocaleService.ts";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type {
  PassState,
  ConversationMessage,
  AgenticContext,
  ToolSchema,
} from "../types.ts";

/**
 * CodexPlanningDetector — handles Codex/planning models that separate
 * planning and action phases in multi-turn agentic flows.
 *
 * Some models (e.g., OpenAI Codex) produce a text-only "planning"
 * response first, then expect a follow-up turn to execute tools.
 * Without this detector, the harness would interpret the planning
 * response as a final answer and break the loop prematurely.
 *
 * When detected, injects a continuation system message prompting
 * the model to proceed with tool calls, or to state completion
 * if the task is actually done.
 *
 * Extracted from ReActHarness (lines 703–736) for cross-harness reuse.
 */

interface CodexDetectionResult {
  /** True if a continuation prompt was injected and the loop should continue. */
  shouldContinueLoop: boolean;
}

/**
 * Check if a text-only pass from a Codex model should trigger a
 * continuation prompt instead of breaking the loop.
 *
 * Returns `{ shouldContinueLoop: true }` when a continuation prompt
 * was injected; the harness should `continue` instead of `break`.
 * Returns `{ shouldContinueLoop: false }` when no intervention is needed.
 */
export function handleCodexPlanningResponse(
  pass: PassState,
  currentMessages: ConversationMessage[],
  context: AgenticContext,
  state: AgenticLoopState,
  availableTools: ToolSchema[],
  harnessLabel: string,
): CodexDetectionResult {
  const isCodexModel = context.resolvedModel
    ?.toLowerCase()
    .includes("codex");
  const hasToolsAvailable = availableTools && availableTools.length > 0;

  if (!isCodexModel || !hasToolsAvailable) {
    return { shouldContinueLoop: false };
  }

  const lastMessage = currentMessages[currentMessages.length - 1];
  const isAlreadyPrompted =
    lastMessage &&
    lastMessage.role === "system" &&
    typeof lastMessage.content === "string" &&
    lastMessage.content.includes("If you have fully completed");

  if (isAlreadyPrompted) {
    return { shouldContinueLoop: false };
  }

  logger.info(
    `[${harnessLabel}] Codex model planning/update detected in iteration ${state.iterations}. Continuing to action phase.`,
  );

  currentMessages.push({
    role: "assistant",
    content: pass.streamedText,
    ...(pass.streamedThinking.trim() && {
      thinking: pass.streamedThinking.trim(),
    }),
  });

  currentMessages.push({
    role: "system",
    content: PromptLocaleService.get(
      (context.options?.locale as string | undefined) || PromptLocaleService.getDefaultLocale(),
      "harness.codexPlanningDetector.continuePrompt",
    ),
  });

  return { shouldContinueLoop: true };
}
