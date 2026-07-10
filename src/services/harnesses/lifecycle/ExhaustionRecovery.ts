import { expandMessagesForFunctionCall } from "#src/utils/FunctionCallingUtilities";
import ConversationGenerationTracker from "#src/services/ConversationGenerationTracker";
import PromptLocaleService from "#src/services/PromptLocaleService";
import logger from "#src/utils/logger";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";

import type BaseAgenticHarness from "#src/services/harnesses/BaseAgenticHarness";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type { AgenticContext, ConversationMessage } from "#src/services/harnesses/types";

/**
 * ExhaustionRecovery — handles the iteration-limit summary pass.
 *
 * When the agentic loop hits its maximum iteration count without producing
 * a final text response, this module runs one last LLM call (with no tools)
 * asking the model to summarize progress and state what remains.
 *
 * If the recovery LLM call itself produces empty output (common with
 * self-hosted or low-capability models that hit context limits), a synthetic
 * fallback summary is built from the accumulated tool call history so the
 * parent orchestrator always receives actionable context.
 *
 * Extracted from ReActHarness to be reusable by any iterating harness.
 */

/** Maximum number of tool results to include in the synthetic fallback. */
const MAXIMUM_FALLBACK_TOOL_RESULTS = 10;
/** Maximum characters per tool result excerpt in the fallback. */
const MAXIMUM_RESULT_EXCERPT_LENGTH = 500;

/**
 * Run a tool-free exhaustion recovery pass.
 *
 * Appends a system instruction asking for a progress summary, streams the
 * response through the harness's `consumeStream`, and updates state.
 * If the recovery pass produces empty output, injects a synthetic fallback
 * summary from the accumulated tool calls.
 */
export async function runExhaustionRecoveryPass(
  harness: BaseAgenticHarness,
  context: AgenticContext,
  state: AgenticLoopState,
  currentMessages: ConversationMessage[],
): Promise<void> {
  const { emit, signal, options, resolvedModel, modelDefinition, provider } =
    context;

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.ITERATION_LIMIT_REACHED,
  });

  const activeLocale =
    (options?.locale as string | undefined) ||
    PromptLocaleService.getDefaultLocale();

  const isSubAgent = !!context.parentAgentConversationId;
  const recoveryMessageKey = isSubAgent
    ? "harness.exhaustionRecovery.subAgentMessage"
    : "harness.exhaustionRecovery.message";

  currentMessages.push({
    role: "system",
    content: PromptLocaleService.get(activeLocale, recoveryMessageKey),
  });

  const { tools: _tools, ...exhaustionOptions } = options;

  const enforcedMessages = harness.enforceContextWindow(currentMessages, 0);
  const expandedMessages = expandMessagesForFunctionCall(enforcedMessages, {
    filterDeleted: false,
  });

  const augmentedOptions = {
    ...exhaustionOptions,
    project: context.project,
    agent: context.agent,
    username: context.username,
  };

  const exhaustionRequestId = `${context.requestId || context.agentConversationId}-exhaustion`;
  harness.registerTrackerRequest(exhaustionRequestId);

  const exhaustionStream =
    modelDefinition?.liveAPI && provider.generateTextStreamLive
      ? provider.generateTextStreamLive(expandedMessages, resolvedModel, {
          ...augmentedOptions,
          signal,
        })
      : provider.generateTextStream(expandedMessages, resolvedModel, {
          ...augmentedOptions,
          signal,
        });

  // Create a pass state for chunk routing through the shared processStreamChunk
  const exhaustionPass = harness.createPassState(augmentedOptions);
  exhaustionPass.requestId = exhaustionRequestId;

  // No tools in the exhaustion pass
  const emptyToolNames = new Set<string>();

  // Use the shared consumeStream — all chunk routing goes through processStreamChunk,
  // so new chunk types added to the base dispatcher are automatically handled.
  await harness.consumeStream(exhaustionStream, exhaustionPass, emptyToolNames);

  // ── Empty recovery fallback ──────────────────────────────────
  // Self-hosted or low-capability models sometimes produce empty output on
  // the recovery pass (the model's context is saturated with tool results
  // and it fails to generate a coherent summary). When this happens, build
  // a synthetic fallback from the accumulated tool call results so the parent
  // orchestrator always receives actionable context instead of "[No output]".
  const recoveryOutputText = (exhaustionPass.streamedText || "").trim();
  if (!recoveryOutputText && state.streamedToolCalls?.length > 0) {
    logger.warn(
      `[ExhaustionRecovery] Recovery pass produced empty output after ${state.iterations} iterations. ` +
        `Building synthetic fallback from ${state.streamedToolCalls.length} tool call(s).`,
    );

    const syntheticSummary = buildSyntheticFallbackSummary(
      state,
      currentMessages,
    );
    // Inject as the state's final text so the finalize method persists it
    state.finalStreamedText = syntheticSummary;
    exhaustionPass.streamedText = syntheticSummary;
    exhaustionPass.finalStreamedText = syntheticSummary;
  }

  harness.logIteration(exhaustionPass, currentMessages);
  harness.emitGenerationProgress();
  ConversationGenerationTracker.complete(exhaustionRequestId);
}

/**
 * Build a structured fallback summary from the accumulated tool call history.
 *
 * Extracts unique tool names, their invocation counts, and the most recent
 * results to create a human-readable summary that the parent orchestrator
 * can use even when the model failed to produce its own synthesis.
 */
export function buildSyntheticFallbackSummary(
  state: AgenticLoopState,
  currentMessages: ConversationMessage[],
): string {
  const toolCalls = state.streamedToolCalls;
  const toolNameCounts = new Map<string, number>();
  for (const toolCall of toolCalls) {
    const previousCount = toolNameCounts.get(toolCall.name) || 0;
    toolNameCounts.set(toolCall.name, previousCount + 1);
  }

  const sections: string[] = [];
  sections.push(
    `[Iteration limit reached after ${state.iterations} iterations — the model did not produce a final summary. ` +
      `Below is a synthetic summary of tool activity.]`,
  );

  // Tool usage breakdown
  const toolUsageSummary = Array.from(toolNameCounts.entries())
    .map(([toolName, count]) => `  - ${toolName}: ${count} call(s)`)
    .join("\n");
  sections.push(`\nTool usage:\n${toolUsageSummary}`);

  // Extract the most recent tool results from messages
  const toolResultMessages = currentMessages.filter(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.toolCalls) &&
      message.toolCalls.length > 0,
  );

  const recentToolResults = toolResultMessages
    .slice(-MAXIMUM_FALLBACK_TOOL_RESULTS)
    .flatMap((message) =>
      (message.toolCalls || []).map((toolCall) => {
        const resultText =
          typeof toolCall.result === "string"
            ? toolCall.result
            : JSON.stringify(toolCall.result);
        const truncatedResult =
          resultText.length > MAXIMUM_RESULT_EXCERPT_LENGTH
            ? resultText.substring(0, MAXIMUM_RESULT_EXCERPT_LENGTH) + "…"
            : resultText;
        const argsText =
          typeof toolCall.args === "string"
            ? toolCall.args
            : JSON.stringify(toolCall.args);
        return `  - ${toolCall.name}(${argsText.substring(0, 200)}): ${truncatedResult}`;
      }),
    );

  if (recentToolResults.length > 0) {
    sections.push(
      `\nRecent tool results (last ${recentToolResults.length}):\n${recentToolResults.join("\n")}`,
    );
  }

  return sections.join("\n");
}
