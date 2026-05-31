import { expandMessagesForFC } from "../../../utils/FunctionCallingUtilities.ts";
import SessionGenerationTracker from "../../SessionGenerationTracker.ts";
import { SSE_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";

import type BaseAgenticHarness from "../BaseAgenticHarness.ts";
import type AgenticLoopState from "../../AgenticLoopState.ts";
import type { AgenticContext, ConversationMessage } from "../types.ts";

/**
 * ExhaustionRecovery — handles the iteration-limit summary pass.
 *
 * When the agentic loop hits its maximum iteration count without producing
 * a final text response, this module runs one last LLM call (with no tools)
 * asking the model to summarize progress and state what remains.
 *
 * Extracted from ReActHarness to be reusable by any iterating harness.
 */

/**
 * Run a tool-free exhaustion recovery pass.
 *
 * Appends a system instruction asking for a progress summary, streams the
 * response through the harness's `consumeStream`, and updates state.
 */
export async function runExhaustionRecoveryPass(
  harness: BaseAgenticHarness,
  context: AgenticContext,
  state: AgenticLoopState,
  currentMessages: ConversationMessage[],
): Promise<void> {
  const { emit, signal, options, resolvedModel, modelDef, provider } = context;

  emit({ type: SSE_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.ITERATION_LIMIT_REACHED });

  currentMessages.push({
    role: "user",
    content: [
      "[SYSTEM] You have reached the maximum number of tool-call iterations for this turn.",
      "Summarize the progress you have made so far, report any partial results,",
      "and clearly state what remains to be done so the user knows where things stand.",
    ].join(" "),
  });

  const exhaustionOptions: Record<string, unknown> = { ...options };
  delete exhaustionOptions.tools;

  const enforcedMessages = harness.enforceContextWindow(currentMessages, 0);
  const expandedMessages = expandMessagesForFC(enforcedMessages, {
    filterDeleted: false,
  });

  const augmentedOptions = {
    ...exhaustionOptions,
    project: context.project,
    agent: context.agent,
    username: context.username,
  };

  const exhaustionRequestId = `${context.requestId || context.agentSessionId}-exhaustion`;
  harness.registerTrackerRequest(exhaustionRequestId);

  const exhaustionStream =
    modelDef?.liveAPI && provider.generateTextStreamLive
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

  harness.emitGenerationProgress();
  SessionGenerationTracker.complete(exhaustionRequestId);
}
