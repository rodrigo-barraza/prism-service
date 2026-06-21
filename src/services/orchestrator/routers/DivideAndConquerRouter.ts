import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../../types/orchestrator.ts";
import type { TopologyRouter, ContinueSubAgentCallback, TopologyConfig } from "../TopologyRouter.ts";
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
  dependsOn?: number[];
}

function truncateResultOutput(output: string, maximumCharacters: number): string {
  if (output.length <= maximumCharacters) return output;
  const truncatedOutput = output.slice(0, maximumCharacters);
  return `${truncatedOutput}\n\n[... truncated — output exceeded ${maximumCharacters.toLocaleString()} character budget]`;
}

function buildDecompositionPrompt(
  originalTask: string,
  memberCount: number,
  maximumSubtaskCount: number = MAXIMUM_SUBTASKS,
): string {
  const maximumSubtasks = Math.min(maximumSubtaskCount, Math.max(memberCount, 3));

  return [
    `You are a task decomposition planner.`,
    `Your job is to break down a complex task into subtasks that can be executed by separate sub-agents.`,
    "",
    "## Original Task",
    "",
    originalTask,
    "",
    "## Instructions",
    "",
    `1. Analyze the task and identify ${maximumSubtasks} or fewer subtasks.`,
    "2. Each subtask should be as self-contained as possible.",
    "3. Subtasks should NOT overlap in scope — avoid two subtasks modifying the same files.",
    "4. Each subtask must include specific file paths, function names, and exact instructions.",
    "5. Do NOT include meta-tasks like 'review' or 'verify' — focus on implementation work.",
    "6. If a subtask depends on the output of another subtask (e.g., 'write tests' depends on 'implement feature'),",
    '   specify `dependsOn` as an array of 0-based subtask indices. Independent subtasks should omit this field.',
    "",
    "## Output Format",
    "",
    "Respond with ONLY a JSON array of subtask objects. No markdown fences, no explanations outside the JSON.",
    "",
    "```json",
    "[",
    '  {',
    `    "description": "Define TypeScript interfaces for the feature",`,
    `    "prompt": "Create the type definitions in src/types/..."`,
    '  },',
    '  {',
    `    "description": "Implement the service using the types",`,
    `    "prompt": "Implement the service in src/services/...",`,
    `    "dependsOn": [0]`,
    '  }',
    "]",
    "```",
  ].join("\n");
}

function parseDecompositionResponse(responseText: string, maximumSubtaskCount: number = MAXIMUM_SUBTASKS): DecomposedSubtask[] {
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
          "description" in subtask &&
          "prompt" in subtask &&
          typeof subtask.description === "string" &&
          typeof subtask.prompt === "string" &&
          subtask.prompt.trim().length > 0,
      )
      .slice(0, maximumSubtaskCount)
      .map((subtask) => ({
        ...subtask,
        dependsOn: Array.isArray(subtask.dependsOn)
          ? subtask.dependsOn.filter((index: unknown): index is number => typeof index === "number" && index >= 0)
          : undefined,
      }));
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
                "description" in subtask &&
                "prompt" in subtask &&
                typeof subtask.description === "string" &&
                typeof subtask.prompt === "string",
            )
            .slice(0, maximumSubtaskCount);
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
    const outputText = result.result
      ? truncateResultOutput(result.result, characterBudgetPerResult)
      : (buildToolCallFallbackSummary(result) || result.summary);
    return [
      `### Subtask: ${subtaskDescription}`,
      `**Status:** ${result.status}`,
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
 * Groups subtasks into execution tiers based on their dependency graph.
 * Tier 0 contains subtasks with no dependencies. Tier 1 contains subtasks
 * whose dependencies are all in Tier 0, and so on.
 * Falls back to a single tier (all parallel) if no dependencies exist.
 */
function buildExecutionTiers(subtasks: DecomposedSubtask[]): number[][] {
  const hasDependencies = subtasks.some(
    (subtask) => subtask.dependsOn && subtask.dependsOn.length > 0,
  );

  if (!hasDependencies) {
    return [subtasks.map((_, subtaskIndex) => subtaskIndex)];
  }

  const assignedTier = new Array<number>(subtasks.length).fill(-1);
  const maximumIterations = subtasks.length;

  for (let iteration = 0; iteration < maximumIterations; iteration++) {
    let madeProgress = false;

    for (let subtaskIndex = 0; subtaskIndex < subtasks.length; subtaskIndex++) {
      if (assignedTier[subtaskIndex] >= 0) continue;

      const dependencies = subtasks[subtaskIndex].dependsOn || [];
      const validDependencies = dependencies.filter(
        (dependencyIndex) => dependencyIndex >= 0 && dependencyIndex < subtasks.length && dependencyIndex !== subtaskIndex,
      );

      if (validDependencies.length === 0) {
        assignedTier[subtaskIndex] = 0;
        madeProgress = true;
        continue;
      }

      const allDependenciesResolved = validDependencies.every(
        (dependencyIndex) => assignedTier[dependencyIndex] >= 0,
      );

      if (allDependenciesResolved) {
        const maximumDependencyTier = Math.max(
          ...validDependencies.map((dependencyIndex) => assignedTier[dependencyIndex]),
        );
        assignedTier[subtaskIndex] = maximumDependencyTier + 1;
        madeProgress = true;
      }
    }

    if (!madeProgress) break;
  }

  // Assign any unresolved (cyclic) subtasks to the final tier
  const maximumResolvedTier = Math.max(0, ...assignedTier.filter((tier) => tier >= 0));
  for (let subtaskIndex = 0; subtaskIndex < subtasks.length; subtaskIndex++) {
    if (assignedTier[subtaskIndex] < 0) {
      logger.warn(
        `[DivideAndConquerRouter] Subtask ${subtaskIndex} has cyclic dependencies — assigning to final tier`,
      );
      assignedTier[subtaskIndex] = maximumResolvedTier + 1;
    }
  }

  const tierCount = Math.max(...assignedTier) + 1;
  const tiers: number[][] = Array.from({ length: tierCount }, () => []);
  for (let subtaskIndex = 0; subtaskIndex < subtasks.length; subtaskIndex++) {
    tiers[assignedTier[subtaskIndex]].push(subtaskIndex);
  }

  return tiers;
}

function buildDependencyContextPrefix(
  completedResults: Map<number, SubAgentResult | { error: string }>,
  dependencyIndices: number[],
  subtaskDescriptions: string[],
): string {
  const dependencyOutputs = dependencyIndices
    .filter((dependencyIndex) => completedResults.has(dependencyIndex))
    .map((dependencyIndex) => {
      const dependencyResult = completedResults.get(dependencyIndex)!;
      const dependencyDescription = subtaskDescriptions[dependencyIndex] || `Subtask #${dependencyIndex + 1}`;
      if ("error" in dependencyResult) {
        return `### ${dependencyDescription}\n**Status:** Error — ${dependencyResult.error}`;
      }
      const outputText = dependencyResult.result || dependencyResult.summary || "(no output)";
      return `### ${dependencyDescription}\n${outputText}`;
    });

  if (dependencyOutputs.length === 0) return "";

  return [
    "## Prerequisite Subtask Outputs",
    "",
    "The following subtasks have already been completed. Use their outputs as context for your work.",
    "",
    dependencyOutputs.join("\n\n---\n\n"),
    "",
    "---",
    "",
  ].join("\n");
}

/**
 * Divide & Conquer Router — Recursive Decomposition with Dependencies (RDD)
 *
 * Based on: "Recursive Decomposition with Dependencies for Generic
 * Divide-and-Conquer Reasoning" (arxiv.org/abs/2505.02576)
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
 *
 * Paper alignment:
 * - Recursive decomposition → ✅ LLM planner decomposes into subtasks
 * - Dependency DAG          → ✅ Planner outputs dependsOn indices; topological sort groups into tiers
 * - Sub-task execution      → ✅ Each subtask dispatched to a sub-agent (tier-parallel)
 * - Recomposition           → ✅ Synthesis pass merges subtask results
 * - Recursive depth         → ⚠️ Not implemented: single-level decomposition only
 */
export class DivideAndConquerRouter implements TopologyRouter {
  async execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
    _continueSubAgent?: ContinueSubAgentCallback,
    topologyConfig?: TopologyConfig,
  ): Promise<(SubAgentResult | { error: string })[]> {
    const { providerName, resolvedModel } = orchestratorContext;
    if (members.length === 0) {
      const errorMessage = "No members provided for Divide & Conquer execution";
      logger.error(`[DivideAndConquerRouter] ${errorMessage}`);
      return [{ error: errorMessage }];
    }
    const originalTask = members.map((member) => member.prompt).join("\n\n");
    const configuredMaxSubtasks = Math.max(1, Number(topologyConfig?.maxSubtasks) || MAXIMUM_SUBTASKS);

    logger.info(
      `[DivideAndConquerRouter] Starting divide-and-conquer for team "${teamName}" (${members.length} member(s))...`,
    );

    // ── Phase 1: Task Decomposition ─────────────────────────────────────

    logger.info(
      `[DivideAndConquerRouter] Phase 1: Decomposing task into subtasks...`,
    );

    const decompositionPrompt = buildDecompositionPrompt(originalTask, members.length, configuredMaxSubtasks);
    const provider = getProvider(providerName);

    if (!provider) {
      const errorMessage = `Provider "${providerName}" not found for decomposition pass`;
      logger.error(`[DivideAndConquerRouter] ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    let subtasks: DecomposedSubtask[];

    try {
      const decompositionStartMs = performance.now();
      const decompositionMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [{ role: "user", content: decompositionPrompt }];
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
        aiMessages: decompositionMessages,
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

      subtasks = parseDecompositionResponse(decompositionResult.text || "", configuredMaxSubtasks);

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

    // ── Phase 2: Tier-Based Subtask Execution (Dependency-Aware) ─────────

    const executionTiers = buildExecutionTiers(subtasks);
    const tierCount = executionTiers.length;
    const subtaskDescriptions = subtasks.map((subtask) => subtask.description);

    logger.info(
      `[DivideAndConquerRouter] Phase 2: Executing ${subtasks.length} subtask(s) across ${tierCount} tier(s)...`,
    );

    const resolvedSiblings = await resolveSiblingInstances(
      { providerName, resolvedModel },
      "DivideAndConquerRouter",
    );

    const referenceMember = members[0];
    const subtaskResults: (SubAgentResult | { error: string })[] = new Array(subtasks.length);
    const completedResults = new Map<number, SubAgentResult | { error: string }>();

    for (let tierIndex = 0; tierIndex < tierCount; tierIndex++) {
      const tierSubtaskIndices = executionTiers[tierIndex];

      if (tierCount > 1) {
        logger.info(
          `[DivideAndConquerRouter] Tier ${tierIndex + 1}/${tierCount}: Executing ${tierSubtaskIndices.length} subtask(s) in parallel...`,
        );
      }

      const tierAssignments: { subtaskIndex: number; assignment: OrchestratorSpawnParams }[] = [];

      for (const subtaskIndex of tierSubtaskIndices) {
        const subtask = subtasks[subtaskIndex];
        const { assignedProvider, assignedModel } = selectInstanceForMember(
          referenceMember,
          resolvedSiblings,
          { providerName, resolvedModel },
        );

        const dependencyContext = subtask.dependsOn && subtask.dependsOn.length > 0
          ? buildDependencyContextPrefix(completedResults, subtask.dependsOn, subtaskDescriptions)
          : "";

        tierAssignments.push({
          subtaskIndex,
          assignment: {
            description: subtask.description,
            prompt: dependencyContext + subtask.prompt,
            files: referenceMember.files,
            model: referenceMember.model,
            agent: referenceMember.agent,
            assignedProvider,
            assignedModel,
            agentIndex: subtaskIndex,
            teamSize: subtasks.length,
            orchestratorContext,
          },
        });
      }

      const tierPromises = tierAssignments.map(({ assignment }) =>
        spawnSubAgent(assignment),
      );
      const tierResults = await Promise.all(tierPromises);

      for (let resultOffset = 0; resultOffset < tierAssignments.length; resultOffset++) {
        const originalIndex = tierAssignments[resultOffset].subtaskIndex;
        subtaskResults[originalIndex] = tierResults[resultOffset];
        completedResults.set(originalIndex, tierResults[resultOffset]);
      }
    }

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
      const synthesisMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [{ role: "user", content: synthesisPrompt }];
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
        aiMessages: synthesisMessages,
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
