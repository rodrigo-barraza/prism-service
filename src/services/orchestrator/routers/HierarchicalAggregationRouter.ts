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

const MAXIMUM_SYNTHESIS_CHARACTERS = 120_000;

function truncateResultOutput(output: string, maximumCharacters: number): string {
  if (output.length <= maximumCharacters) return output;
  const truncatedOutput = output.slice(0, maximumCharacters);
  return `${truncatedOutput}\n\n[... truncated — output exceeded ${maximumCharacters.toLocaleString()} character budget]`;
}

function buildSynthesisPrompt(
  teamName: string,
  memberResults: (SubAgentResult | { error: string })[],
): string {
  const characterBudgetPerMember = Math.floor(MAXIMUM_SYNTHESIS_CHARACTERS / Math.max(memberResults.length, 1));

  const resultSections = memberResults.map((result, resultIndex) => {
    if ("error" in result) {
      return `### Sub-Agent #${resultIndex + 1}\n**Status:** Error\n**Error:** ${result.error}`;
    }
    const subAgentResult = result as SubAgentResult;
    const outputText = subAgentResult.result
      ? truncateResultOutput(subAgentResult.result, characterBudgetPerMember)
      : (buildToolCallFallbackSummary(subAgentResult) || subAgentResult.summary);
    return [
      `### Sub-Agent #${resultIndex + 1}: ${subAgentResult.description || "unnamed"}`,
      `**Status:** ${subAgentResult.status}`,
      `**Output:**\n${outputText}`,
    ].join("\n");
  });

  return [
    `You are a synthesis agent for the team "${teamName}".`,
    `${memberResults.length} sub-agents have completed their work. Your job is to merge their outputs into a single, unified result.`,
    "",
    "## Sub-Agent Results",
    "",
    resultSections.join("\n\n---\n\n"),
    "",
    "## Instructions",
    "",
    "1. Analyze all sub-agent outputs above.",
    "2. Identify agreements, conflicts, and complementary information.",
    "3. Produce a single, coherent synthesis that combines the best reasoning and findings from each sub-agent.",
    "4. If any sub-agents failed, note which ones and incorporate results from the successful ones.",
    "5. Be concise but thorough. Do not simply concatenate the outputs — produce an integrated result.",
  ].join("\n");
}

export class HierarchicalAggregationRouter implements TopologyRouter {
  async execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
  ): Promise<(SubAgentResult | { error: string })[]> {
    const { providerName, resolvedModel } = orchestratorContext;
    logger.info(
      `[HierarchicalAggregationRouter] createTeam: batch assignment of ${members.length} sub-agent(s) with synthesis pass...`,
    );

    // ── Phase 1: Parallel execution (identical to HierarchicalRouter) ────

    const resolvedSiblings = await resolveSiblingInstances(
      { providerName, resolvedModel },
      "HierarchicalAggregationRouter",
    );

    const assignments: OrchestratorSpawnParams[] = [];

    for (let memberIndex = 0; memberIndex < members.length; memberIndex++) {
      const member = members[memberIndex];
      const { assignedProvider, assignedModel } = selectInstanceForMember(
        member,
        resolvedSiblings,
        { providerName, resolvedModel },
      );

      assignments.push({
        description: member.description,
        prompt: member.prompt,
        files: member.files,
        model: member.model,
        agent: member.agent,
        assignedProvider,
        assignedModel,
        agentIndex: memberIndex,
        teamSize: members.length,
        orchestratorContext,
      });
    }

    const spawnPromises = assignments.map((assignment) =>
      spawnSubAgent(assignment),
    );
    const memberResults = await Promise.all(spawnPromises);


    // ── Phase 2: Synthesis pass (GoT aggregation) ────────────────────

    const successfulResults = memberResults.filter(
      (result) => !("error" in result) && result.status === "completed",
    );

    if (successfulResults.length === 0) {
      logger.warn(
        `[HierarchicalAggregationRouter] All ${memberResults.length} sub-agents failed — skipping synthesis pass`,
      );
      return memberResults;
    }

    if (successfulResults.length === 1) {
      logger.info(
        `[HierarchicalAggregationRouter] Only 1 sub-agent succeeded — skipping synthesis pass`,
      );
      return memberResults;
    }

    logger.info(
      `[HierarchicalAggregationRouter] Running synthesis pass over ${successfulResults.length} successful sub-agent results...`,
    );

    try {
      const synthesisPrompt = buildSynthesisPrompt(teamName, memberResults);
      const provider = getProvider(providerName);

      if (!provider) {
        logger.error(
          `[HierarchicalAggregationRouter] Provider "${providerName}" not found for synthesis pass`,
        );
        return memberResults;
      }

      const synthesisStartTime = Date.now();
      const synthesisResult = await provider.generateText(
        [{ role: "user", content: synthesisPrompt }],
        resolvedModel,
        { maxTokens: 8192 },
      );
      const synthesisDurationMs = Date.now() - synthesisStartTime;

      const synthesisSubAgentResult: SubAgentResult = {
        agent_id: `synthesis-${teamName}-${Date.now()}`,
        description: `Synthesis pass for team "${teamName}"`,
        status: "completed",
        summary: `Aggregated ${successfulResults.length} sub-agent results into a unified synthesis`,
        result: synthesisResult.text,
        toolUses: 0,
        iterations: 1,
        durationMs: synthesisDurationMs,
        messages: [],
        diff: { additions: 0, deletions: 0, files: [] },
      };

      logger.info(
        `[HierarchicalAggregationRouter] Synthesis pass complete in ${synthesisDurationMs}ms (${synthesisResult.usage.inputTokens} input, ${synthesisResult.usage.outputTokens} output tokens)`,
      );

      return [...memberResults, synthesisSubAgentResult];
    } catch (synthesisError: unknown) {
      const errorMessage =
        synthesisError instanceof Error
          ? synthesisError.message
          : String(synthesisError);
      logger.error(
        `[HierarchicalAggregationRouter] Synthesis pass failed: ${errorMessage}`,
      );
      return memberResults;
    }
  }
}
