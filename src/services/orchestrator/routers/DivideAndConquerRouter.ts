import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../../types/orchestrator.ts";
import type { TopologyRouter } from "../TopologyRouter.ts";
import {
  resolveSiblingInstances,
  selectInstanceForMember,
} from "../InstanceResolver.ts";
import { getProvider } from "../../../providers/index.ts";
import logger from "../../../utils/logger.ts";
import { buildToolCallFallbackSummary } from "../SubAgentResultBuilder.ts";
import RequestLogger from "../../RequestLogger.ts";
import { getErrorMessage } from "../../../utils/ErrorHelpers.ts";

const MAXIMUM_SUBTASKS = 6;
const MAXIMUM_SYNTHESIS_CHARACTERS = 120_000;

interface DecomposedSubtask {
  description: string;
  prompt: string;
}

function truncateResultOutput(output: string, maximumCharacters: number): string {
  if (output.length <= maximumCharacters) return output;
  const truncatedOutput = output.slice(0, maximumCharacters);
  return `${truncatedOutput}\n\n[... truncated — output exceeded ${maximumCharacters.toLocaleString()} character budget]`;
}

function buildDecompositionPrompt(
  originalTask: string,
  memberCount: number,
): string {
  const maximumSubtasks = Math.min(MAXIMUM_SUBTASKS, Math.max(memberCount, 3));

  return [
    `You are a task decomposition planner.`,
    `Your job is to break down a complex task into independent subtasks that can be executed in parallel by separate sub-agents.`,
    "",
    "## Original Task",
    "",
    originalTask,
    "",
    "## Instructions",
    "",
    `1. Analyze the task and identify ${maximumSubtasks} or fewer independent subtasks.`,
    "2. Each subtask must be self-contained — a sub-agent should be able to execute it without knowing about other subtasks.",
    "3. Subtasks should NOT overlap in scope — avoid two subtasks modifying the same files.",
    "4. Each subtask must include specific file paths, function names, and exact instructions.",
    "5. Do NOT include meta-tasks like 'review' or 'verify' — focus on implementation work.",
    "",
    "## Output Format",
    "",
    "Respond with ONLY a JSON array of subtask objects. No markdown fences, no explanations outside the JSON.",
    "",
    "```json",
    "[",
    "  {",
    `    "description": "Brief 1-line description of the subtask",`,
    `    "prompt": "Detailed, self-contained instructions for the sub-agent. Include file paths, function names, and specific changes."`,
    "  }",
    "]",
    "```",
  ].join("\n");
}

function parseDecompositionResponse(responseText: string): DecomposedSubtask[] {
  // Strip markdown code fences if present
  let cleanedResponse = responseText.trim();
  cleanedResponse = cleanedResponse.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    const parsed = JSON.parse(cleanedResponse);
    if (!Array.isArray(parsed)) {
      logger.warn("[DivideAndConquerRouter] Decomposition response is not an array");
      return [];
    }

    return parsed
      .filter(
        (subtask: unknown): subtask is DecomposedSubtask =>
          typeof subtask === "object" &&
          subtask !== null &&
          typeof (subtask as DecomposedSubtask).description === "string" &&
          typeof (subtask as DecomposedSubtask).prompt === "string" &&
          (subtask as DecomposedSubtask).prompt.trim().length > 0,
      )
      .slice(0, MAXIMUM_SUBTASKS);
  } catch (parseError: unknown) {
    logger.error(
      `[DivideAndConquerRouter] Failed to parse decomposition JSON: ${getErrorMessage(parseError)}`,
    );

    // Attempt to extract JSON from mixed content
    const jsonArrayMatch = cleanedResponse.match(/\[[\s\S]*\]/);
    if (jsonArrayMatch) {
      try {
        const extracted = JSON.parse(jsonArrayMatch[0]);
        if (Array.isArray(extracted)) {
          return extracted
            .filter(
              (subtask: unknown): subtask is DecomposedSubtask =>
                typeof subtask === "object" &&
                subtask !== null &&
                typeof (subtask as DecomposedSubtask).description === "string" &&
                typeof (subtask as DecomposedSubtask).prompt === "string",
            )
            .slice(0, MAXIMUM_SUBTASKS);
        }
      } catch {
        // Fallback exhausted
      }
    }

    return [];
  }
}

function buildSynthesisPrompt(
  originalTask: string,
  subtaskResults: (SubAgentResult | { error: string })[],
  subtaskDescriptions: string[],
): string {
  const characterBudgetPerResult = Math.floor(
    MAXIMUM_SYNTHESIS_CHARACTERS / Math.max(subtaskResults.length, 1),
  );

  const resultSections = subtaskResults.map((result, resultIndex) => {
    const subtaskDescription = subtaskDescriptions[resultIndex] || `Subtask #${resultIndex + 1}`;
    if ("error" in result) {
      return `### Subtask: ${subtaskDescription}\n**Status:** Error\n**Error:** ${result.error}`;
    }
    const subAgentResult = result as SubAgentResult;
    const outputText = subAgentResult.result
      ? truncateResultOutput(subAgentResult.result, characterBudgetPerResult)
      : (buildToolCallFallbackSummary(subAgentResult) || subAgentResult.summary);
    return [
      `### Subtask: ${subtaskDescription}`,
      `**Status:** ${subAgentResult.status}`,
      `**Output:**\n${outputText}`,
    ].join("\n");
  });

  return [
    `You are a synthesis agent for a divide-and-conquer execution.`,
    `The original task was decomposed into ${subtaskResults.length} independent subtasks. Each was executed by a separate sub-agent.`,
    "",
    "## Original Task",
    "",
    originalTask,
    "",
    "## Subtask Results",
    "",
    resultSections.join("\n\n---\n\n"),
    "",
    "## Instructions",
    "",
    "1. Analyze all subtask results above.",
    "2. Verify that the original task has been fully addressed across all subtasks.",
    "3. Identify any gaps — subtasks that failed or areas that weren't covered.",
    "4. Produce a single, coherent synthesis that combines all subtask results.",
    "5. If any subtasks failed, note what remains to be done.",
    "6. Be concise but thorough — produce an integrated summary, not a concatenation.",
  ].join("\n");
}

/**
 * Divide & Conquer Router — Recursive Task Decomposition (ToT)
 *
 * Implements a three-phase planner-execute-synthesize flow:
 * 1. **Decompose:** An LLM planner breaks the task into independent subtasks
 * 2. **Execute:** Each subtask is dispatched to a sub-agent in parallel
 * 3. **Synthesize:** A final pass merges all subtask results
 *
 * Members mapping:
 * - members[0].prompt is used as the original task for decomposition
 * - All members share the same model/provider configuration
 * - The planner may generate fewer or more subtasks than members provided
 *
 * This is compositionally: Sequential(Planner) → Hierarchical(subtasks) → Aggregation(synthesis)
 */
export class DivideAndConquerRouter implements TopologyRouter {
  async execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
  ): Promise<(SubAgentResult | { error: string })[]> {
    const { providerName, resolvedModel } = orchestratorContext;
    const originalTask = members.map((member) => member.prompt).join("\n\n");

    logger.info(
      `[DivideAndConquerRouter] Starting divide-and-conquer for team "${teamName}" (${members.length} member(s))...`,
    );

    // ── Phase 1: Task Decomposition ─────────────────────────────────────

    logger.info(
      `[DivideAndConquerRouter] Phase 1: Decomposing task into subtasks...`,
    );

    const decompositionPrompt = buildDecompositionPrompt(originalTask, members.length);
    const provider = getProvider(providerName);

    if (!provider) {
      const errorMessage = `Provider "${providerName}" not found for decomposition pass`;
      logger.error(`[DivideAndConquerRouter] ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    let subtasks: DecomposedSubtask[];

    try {
      const decompositionStartMs = performance.now();
      const decompositionMessages = [{ role: "user", content: decompositionPrompt }];
      const decompositionResult = await provider.generateText(
        decompositionMessages,
        resolvedModel,
        { maxTokens: 4096 },
      );
      const decompositionDurationMs = Math.round(performance.now() - decompositionStartMs);

      RequestLogger.logBackgroundLlmCall({
        requestId: `${orchestratorContext.conversationId || "unknown"}-decompose-${teamName}`,
        endpoint: "/agent",
        operation: "orchestrator:decompose",
        project: orchestratorContext.project || null,
        username: orchestratorContext.username || "system",
        agent: null,
        provider: providerName,
        model: resolvedModel,
        traceId: orchestratorContext.traceId || null,
        agentConversationId: orchestratorContext.agentConversationId || null,
        aiMessages: decompositionMessages as Parameters<typeof RequestLogger.logBackgroundLlmCall>[0]["aiMessages"],
        resultText: decompositionResult.text || "",
        usage: decompositionResult.usage || null,
        success: true,
        errorMessage: null,
        requestStartMs: decompositionStartMs,
        extraRequestPayload: { teamName, phase: "decomposition" },
      }).catch((loggingError: unknown) =>
        logger.error(
          `[DivideAndConquerRouter] Failed to log decomposition request: ${getErrorMessage(loggingError)}`,
        ),
      );

      subtasks = parseDecompositionResponse(decompositionResult.text || "");

      logger.info(
        `[DivideAndConquerRouter] Decomposed into ${subtasks.length} subtask(s) in ${decompositionDurationMs}ms`,
      );
    } catch (decompositionError: unknown) {
      const errorMessage = `Decomposition failed: ${getErrorMessage(decompositionError)}`;
      logger.error(`[DivideAndConquerRouter] ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    if (subtasks.length === 0) {
      logger.warn(
        `[DivideAndConquerRouter] Decomposition produced 0 subtasks — falling back to direct execution`,
      );
      // Fall back: execute the original task as-is with one sub-agent
      subtasks = [{ description: members[0].description, prompt: originalTask }];
    }

    // ── Phase 2: Parallel Subtask Execution ─────────────────────────────

    logger.info(
      `[DivideAndConquerRouter] Phase 2: Executing ${subtasks.length} subtask(s) in parallel...`,
    );

    const resolvedSiblings = await resolveSiblingInstances(
      { providerName, resolvedModel },
      "DivideAndConquerRouter",
    );

    const referenceMember = members[0];

    const subtaskAssignments: OrchestratorSpawnParams[] = subtasks.map(
      (subtask, subtaskIndex) => {
        const { assignedProvider, assignedModel } = selectInstanceForMember(
          referenceMember,
          resolvedSiblings,
          { providerName, resolvedModel },
        );

        return {
          description: subtask.description,
          prompt: subtask.prompt,
          files: referenceMember.files,
          model: referenceMember.model,
          agent: referenceMember.agent,
          assignedProvider,
          assignedModel,
          agentIndex: subtaskIndex,
          teamSize: subtasks.length,
          orchestratorContext,
        };
      },
    );

    const subtaskPromises = subtaskAssignments.map((assignment) =>
      spawnSubAgent(assignment),
    );
    const subtaskResults = await Promise.all(subtaskPromises);

    // ── Phase 3: Synthesis ──────────────────────────────────────────────

    const successfulResults = subtaskResults.filter(
      (result) => !("error" in result) && result.status === "completed",
    );

    if (successfulResults.length === 0) {
      logger.warn(
        `[DivideAndConquerRouter] All ${subtaskResults.length} subtasks failed — skipping synthesis`,
      );
      return subtaskResults;
    }

    if (successfulResults.length === 1 && subtasks.length === 1) {
      logger.info(
        `[DivideAndConquerRouter] Single subtask executed — skipping synthesis`,
      );
      return subtaskResults;
    }

    logger.info(
      `[DivideAndConquerRouter] Phase 3: Synthesizing ${successfulResults.length} subtask result(s)...`,
    );

    try {
      const subtaskDescriptions = subtasks.map((subtask) => subtask.description);
      const synthesisPrompt = buildSynthesisPrompt(
        originalTask,
        subtaskResults,
        subtaskDescriptions,
      );

      const synthesisStartMs = performance.now();
      const synthesisMessages = [{ role: "user", content: synthesisPrompt }];
      const synthesisResult = await provider.generateText(
        synthesisMessages,
        resolvedModel,
        { maxTokens: 8192 },
      );
      const synthesisDurationMs = Math.round(performance.now() - synthesisStartMs);

      RequestLogger.logBackgroundLlmCall({
        requestId: `${orchestratorContext.conversationId || "unknown"}-synthesis-${teamName}`,
        endpoint: "/agent",
        operation: "orchestrator:divide-conquer-synthesis",
        project: orchestratorContext.project || null,
        username: orchestratorContext.username || "system",
        agent: null,
        provider: providerName,
        model: resolvedModel,
        traceId: orchestratorContext.traceId || null,
        agentConversationId: orchestratorContext.agentConversationId || null,
        aiMessages: synthesisMessages as Parameters<typeof RequestLogger.logBackgroundLlmCall>[0]["aiMessages"],
        resultText: synthesisResult.text || "",
        usage: synthesisResult.usage || null,
        success: true,
        errorMessage: null,
        requestStartMs: synthesisStartMs,
        extraRequestPayload: {
          teamName,
          phase: "synthesis",
          subtaskCount: subtasks.length,
          successfulCount: successfulResults.length,
        },
      }).catch((loggingError: unknown) =>
        logger.error(
          `[DivideAndConquerRouter] Failed to log synthesis request: ${getErrorMessage(loggingError)}`,
        ),
      );

      const synthesisSubAgentResult: SubAgentResult = {
        agent_id: `divide-conquer-synthesis-${teamName}-${Date.now()}`,
        description: `Divide & Conquer synthesis for team "${teamName}"`,
        status: "completed",
        summary: `Decomposed into ${subtasks.length} subtasks, synthesized ${successfulResults.length} successful results`,
        result: synthesisResult.text,
        toolUses: 0,
        iterations: 1,
        durationMs: synthesisDurationMs,
        messages: [],
        diff: { additions: 0, deletions: 0, files: [] },
      };

      logger.info(
        `[DivideAndConquerRouter] Synthesis complete in ${synthesisDurationMs}ms`,
      );

      return [...subtaskResults, synthesisSubAgentResult];
    } catch (synthesisError: unknown) {
      logger.error(
        `[DivideAndConquerRouter] Synthesis failed: ${getErrorMessage(synthesisError)}`,
      );
      return subtaskResults;
    }
  }
}
