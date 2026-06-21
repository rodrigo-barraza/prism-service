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

const DEFAULT_MAXIMUM_DEPTH = 3;
const DEFAULT_BRANCH_FACTOR = 3;
const MAXIMUM_EVALUATION_CHARACTERS = 100_000;

interface TreeNode {
  depth: number;
  branchIndex: number;
  result: SubAgentResult;
  score: number;
  parentNodeIndex: number | null;
}

function truncateResultOutput(output: string, maximumCharacters: number): string {
  if (output.length <= maximumCharacters) return output;
  const truncatedOutput = output.slice(0, maximumCharacters);
  return `${truncatedOutput}\n\n[... truncated — output exceeded ${maximumCharacters.toLocaleString()} character budget]`;
}

function buildEvaluationPrompt(
  originalTask: string,
  candidateResults: { branchIndex: number; output: string }[],
  currentDepth: number,
  maximumDepth: number,
): string {
  const characterBudgetPerCandidate = Math.floor(
    MAXIMUM_EVALUATION_CHARACTERS / Math.max(candidateResults.length, 1),
  );

  const candidateSections = candidateResults.map((candidate) => {
    const truncatedOutput = truncateResultOutput(candidate.output, characterBudgetPerCandidate);
    return `### Branch ${candidate.branchIndex + 1}\n${truncatedOutput}`;
  });

  return [
    `You are an evaluator in a Monte Carlo Tree Search (MCTS) for agent reasoning.`,
    `This is depth ${currentDepth} of ${maximumDepth}.`,
    "",
    "## Original Task",
    "",
    originalTask,
    "",
    "## Candidate Solutions",
    "",
    candidateSections.join("\n\n---\n\n"),
    "",
    "## Instructions",
    "",
    "Evaluate each candidate solution and score them on a scale of 0.0 to 1.0 based on:",
    "- **Correctness** (0.3 weight) — Is the solution technically correct?",
    "- **Completeness** (0.3 weight) — How much of the task is addressed?",
    "- **Quality** (0.2 weight) — Code quality, reasoning clarity, robustness",
    "- **Verification** (0.2 weight) — Did the agent verify its work?",
    "",
    "Also determine if the BEST candidate is a complete solution (no further iterations needed).",
    "",
    "Respond with ONLY a JSON object. No markdown fences, no explanations outside the JSON.",
    "",
    "```json",
    "{",
    `  "scores": [0.85, 0.72, 0.91],`,
    `  "bestBranchIndex": 2,`,
    `  "isComplete": false,`,
    `  "feedback": "Branch 3 has the strongest approach but needs error handling for edge cases."`,
    "}",
    "```",
  ].join("\n");
}

interface EvaluationResult {
  scores: number[];
  bestBranchIndex: number;
  isComplete: boolean;
  feedback: string;
}

function parseEvaluationResponse(responseText: string, branchCount: number): EvaluationResult {
  let cleanedResponse = responseText.trim();
  cleanedResponse = cleanedResponse.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");

  try {
    const parsed = JSON.parse(cleanedResponse);
    const scores = Array.isArray(parsed.scores)
      ? parsed.scores.map((score: unknown) => Math.max(0, Math.min(1, Number(score) || 0)))
      : new Array(branchCount).fill(0.5);

    const bestBranchIndex = typeof parsed.bestBranchIndex === "number"
      ? Math.max(0, Math.min(branchCount - 1, parsed.bestBranchIndex))
      : scores.indexOf(Math.max(...scores));

    return {
      scores,
      bestBranchIndex,
      isComplete: Boolean(parsed.isComplete),
      feedback: typeof parsed.feedback === "string" ? parsed.feedback : "",
    };
  } catch {
    logger.warn("[MCTSRouter] Failed to parse evaluation JSON — using uniform scores");

    // Attempt JSON extraction from mixed content
    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const extracted = JSON.parse(jsonMatch[0]);
        return {
          scores: Array.isArray(extracted.scores)
            ? extracted.scores.map((score: unknown) => Number(score) || 0.5)
            : new Array(branchCount).fill(0.5),
          bestBranchIndex: typeof extracted.bestBranchIndex === "number"
            ? extracted.bestBranchIndex : 0,
          isComplete: Boolean(extracted.isComplete),
          feedback: typeof extracted.feedback === "string" ? extracted.feedback : "",
        };
      } catch {
        // Fallback exhausted
      }
    }

    return {
      scores: new Array(branchCount).fill(0.5),
      bestBranchIndex: 0,
      isComplete: false,
      feedback: "",
    };
  }
}

function buildRefinementPrompt(
  originalTask: string,
  previousBestOutput: string,
  evaluationFeedback: string,
  currentDepth: number,
  maximumDepth: number,
): string {
  return [
    `You are continuing work on a task. A previous attempt was evaluated and selected as the best approach, but it needs refinement.`,
    `This is iteration ${currentDepth} of ${maximumDepth}.`,
    "",
    "## Original Task",
    "",
    originalTask,
    "",
    "## Previous Best Attempt",
    "",
    previousBestOutput,
    "",
    "## Evaluator Feedback",
    "",
    evaluationFeedback,
    "",
    "## Instructions",
    "",
    "1. Build on the previous best attempt — don't start from scratch.",
    "2. Address the evaluator's feedback specifically.",
    "3. Improve completeness, fix any identified issues, and strengthen weak areas.",
    "4. Verify your work (run tests, typecheck, etc.).",
    "5. Commit and report what you improved.",
  ].join("\n");
}

/**
 * MCTS-Guided Search Router — Monte Carlo Tree Search (LATS)
 *
 * Implements an iterative expand-evaluate-select-refine loop:
 *
 * 1. **Expand:** Spawn N sub-agents in parallel with the task (or refinement prompt)
 * 2. **Evaluate:** An LLM judge scores all N results on correctness/completeness/quality
 * 3. **Select:** Pick the highest-scoring branch
 * 4. **Backpropagate:** Feed the winner's output + evaluator feedback into the next depth
 * 5. **Repeat** until the evaluator marks the solution as complete or max depth reached
 *
 * Key differences from Tournament:
 * - Tournament is single-depth (expand once → judge once)
 * - MCTS is multi-depth (expand → evaluate → refine → expand → evaluate → ...)
 * - Each depth level builds on the previous winner's output
 * - The evaluator provides actionable feedback, not just a selection
 */
export class MCTSRouter implements TopologyRouter {
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
    const originalTask = members[0]?.prompt || "";
    const branchFactor = Math.min(
      Math.max(1, Number(topologyConfig?.branchFactor) || DEFAULT_BRANCH_FACTOR),
      Math.max(members.length, 2),
    );
    const maximumDepth = Math.max(1, Number(topologyConfig?.maxDepth) || DEFAULT_MAXIMUM_DEPTH);

    logger.info(
      `[MCTSRouter] Starting MCTS search for team "${teamName}" (branch factor: ${branchFactor}, max depth: ${maximumDepth})...`,
    );

    const provider = getProvider(providerName);
    if (!provider) {
      const errorMessage = `Provider "${providerName}" not found`;
      logger.error(`[MCTSRouter] ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    const allTreeNodes: TreeNode[] = [];
    const allResults: (SubAgentResult | { error: string })[] = [];
    let currentPrompt = originalTask;
    let bestResultSoFar: SubAgentResult | null = null;

    for (let depthLevel = 1; depthLevel <= maximumDepth; depthLevel++) {
      logger.info(
        `[MCTSRouter] Depth ${depthLevel}/${maximumDepth}: Expanding ${branchFactor} branches...`,
      );

      // ── EXPAND: Spawn N sub-agents in parallel ────────────────────────

      const resolvedSiblings = await resolveSiblingInstances(
        { providerName, resolvedModel },
        "MCTSRouter",
      );

      const referenceMember = members[0];
      const branchAssignments: OrchestratorSpawnParams[] = [];

      for (let branchIndex = 0; branchIndex < branchFactor; branchIndex++) {
        const { assignedProvider, assignedModel } = selectInstanceForMember(
          referenceMember,
          resolvedSiblings,
          { providerName, resolvedModel },
        );

        branchAssignments.push({
          description: `${referenceMember.description} (Depth ${depthLevel}, Branch ${branchIndex + 1})`,
          prompt: currentPrompt,
          files: referenceMember.files,
          model: referenceMember.model,
          agent: referenceMember.agent,
          assignedProvider,
          assignedModel,
          agentIndex: branchIndex,
          teamSize: branchFactor,
          round: depthLevel,
          orchestratorContext,
        });
      }

      const branchPromises = branchAssignments.map((assignment) =>
        spawnSubAgent(assignment),
      );
      const branchResults = await Promise.all(branchPromises);
      allResults.push(...branchResults);

      // Collect successful results for evaluation
      const successfulBranches: { branchIndex: number; result: SubAgentResult }[] = [];
      for (let branchIndex = 0; branchIndex < branchResults.length; branchIndex++) {
        const branchResult = branchResults[branchIndex];
        if (!("error" in branchResult) && branchResult.status === "completed") {
          successfulBranches.push({ branchIndex, result: branchResult });
        }
      }

      if (successfulBranches.length === 0) {
        logger.warn(
          `[MCTSRouter] All ${branchFactor} branches failed at depth ${depthLevel} — aborting search`,
        );
        break;
      }

      // ── EVALUATE: Score each successful branch ────────────────────────

      logger.info(
        `[MCTSRouter] Depth ${depthLevel}: Evaluating ${successfulBranches.length} successful branch(es)...`,
      );

      const candidateOutputs = successfulBranches.map((branch) => ({
        branchIndex: branch.branchIndex,
        output: branch.result.result
          || buildToolCallFallbackSummary(branch.result)
          || branch.result.summary,
      }));

      const evaluationPrompt = buildEvaluationPrompt(
        originalTask,
        candidateOutputs,
        depthLevel,
        maximumDepth,
      );

      let evaluationResult: EvaluationResult;

      try {
        const evaluationStartMs = performance.now();
        const evaluationMessages: Array<{ role: "user" | "assistant" | "system"; content: string }> = [{ role: "user", content: evaluationPrompt }];
        const evaluationResponse = await provider.generateText(
          evaluationMessages,
          resolvedModel,
          { maxTokens: 2048 },
        );

        RequestLogger.logBackgroundLlmCall({
          requestId: `${orchestratorContext.conversationId || "unknown"}-mcts-eval-d${depthLevel}-${teamName}`,
          endpoint: "/agent",
          operation: "orchestrator:mcts-evaluate",
          project: orchestratorContext.project || null,
          username: orchestratorContext.username || "system",
          agent: null,
          provider: providerName,
          model: resolvedModel,
          traceId: orchestratorContext.traceId || null,
          agentConversationId: orchestratorContext.agentConversationId || null,
          aiMessages: evaluationMessages,
          resultText: evaluationResponse.text || "",
          usage: evaluationResponse.usage || null,
          success: true,
          errorMessage: null,
          requestStartMs: evaluationStartMs,
          extraRequestPayload: {
            teamName,
            depth: depthLevel,
            branchCount: successfulBranches.length,
          },
        }).catch((loggingError: unknown) =>
          logger.error(
            `[MCTSRouter] Failed to log evaluation request: ${getErrorMessage(loggingError)}`,
          ),
        );

        evaluationResult = parseEvaluationResponse(
          evaluationResponse.text || "",
          successfulBranches.length,
        );
      } catch (evaluationError: unknown) {
        logger.error(
          `[MCTSRouter] Evaluation failed at depth ${depthLevel}: ${getErrorMessage(evaluationError)}`,
        );
        // Default to first successful branch
        evaluationResult = {
          scores: new Array(successfulBranches.length).fill(0.5),
          bestBranchIndex: 0,
          isComplete: false,
          feedback: "",
        };
      }

      // ── SELECT: Pick the best branch ──────────────────────────────────

      const selectedBranchIndex = Math.min(
        evaluationResult.bestBranchIndex,
        successfulBranches.length - 1,
      );
      const selectedBranch = successfulBranches[selectedBranchIndex];
      bestResultSoFar = selectedBranch.result;

      // Record tree nodes for the search history
      for (let branchOffset = 0; branchOffset < successfulBranches.length; branchOffset++) {
        const branch = successfulBranches[branchOffset];
        allTreeNodes.push({
          depth: depthLevel,
          branchIndex: branch.branchIndex,
          result: branch.result,
          score: evaluationResult.scores[branchOffset] ?? 0.5,
          parentNodeIndex: depthLevel > 1
            ? allTreeNodes.findIndex(
                (node) => node.depth === depthLevel - 1 && node.score === Math.max(
                  ...allTreeNodes.filter((existingNode) => existingNode.depth === depthLevel - 1).map((existingNode) => existingNode.score),
                ),
              )
            : null,
        });
      }

      const selectedScore = evaluationResult.scores[selectedBranchIndex] ?? 0.5;
      logger.info(
        `[MCTSRouter] Depth ${depthLevel}: Selected Branch ${selectedBranch.branchIndex + 1} (score: ${selectedScore.toFixed(2)})${evaluationResult.isComplete ? " — COMPLETE" : ""}`,
      );

      // ── BACKPROPAGATE: Check if solution is complete ──────────────────

      if (evaluationResult.isComplete) {
        logger.info(
          `[MCTSRouter] Evaluator marked solution as complete at depth ${depthLevel}. Terminating search.`,
        );
        break;
      }

      if (depthLevel >= maximumDepth) {
        logger.info(
          `[MCTSRouter] Maximum depth (${maximumDepth}) reached. Returning best result.`,
        );
        break;
      }

      // ── Prepare next depth: Refinement prompt seeded with winner ──────

      const bestOutput = selectedBranch.result.result
        || buildToolCallFallbackSummary(selectedBranch.result)
        || selectedBranch.result.summary;

      currentPrompt = buildRefinementPrompt(
        originalTask,
        bestOutput,
        evaluationResult.feedback,
        depthLevel,
        maximumDepth,
      );
    }

    // Build a summary result with the full search history
    if (bestResultSoFar && allTreeNodes.length > 0) {
      const searchSummary: SubAgentResult = {
        agent_id: `mcts-search-${teamName}-${Date.now()}`,
        description: `MCTS search summary for team "${teamName}"`,
        status: "completed",
        summary: `MCTS search explored ${allTreeNodes.length} nodes across ${Math.max(...allTreeNodes.map((node) => node.depth))} depth levels`,
        result: bestResultSoFar.result,
        toolUses: 0,
        iterations: allTreeNodes.length,
        durationMs: allResults
          .filter((result): result is SubAgentResult => !("error" in result))
          .reduce((total, result) => total + (result.durationMs || 0), 0),
        messages: [],
        diff: bestResultSoFar.diff,
      };

      allResults.push(searchSummary);
    }

    return allResults;
  }
}
