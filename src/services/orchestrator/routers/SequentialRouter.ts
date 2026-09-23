import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "#src/types/orchestrator";
import { nextGlobalSpawnIndex } from "#src/types/orchestrator";
import type {
  TopologyRouter,
  ContinueSubAgentCallback,
  TopologyConfig,
} from "#src/services/orchestrator/TopologyRouter";
import { buildToolCallFallbackSummary } from "#src/services/orchestrator/SubAgentResultBuilder";
import {
  resolveSiblingInstances,
  selectInstanceForMember,
} from "#src/services/orchestrator/InstanceResolver";
import logger from "#src/utils/logger";
import { isMergeBackKept } from "#src/services/orchestrator/WorktreeMergeBack";

/**
 * Sequential Router — Serial Pipeline (SP)
 *
 * Paper: "Chain-of-Thought Prompting Elicits Reasoning in
 * Large Language Models" (arxiv.org/abs/2201.11903)
 *
 * Inspired by CoT's step-by-step decomposition, but extended
 * from single-prompt reasoning to multi-agent orchestration.
 * Each sub-agent receives accumulated prior outputs as context.
 *
 * See TopologyRegistry.ts → TOPOLOGY_DEFINITIONS (id: "sequential")
 * for full paper-alignment metadata and config option documentation.
 */
export class SequentialRouter implements TopologyRouter {
  async execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
    _continueSubAgent?: ContinueSubAgentCallback,
    _topologyConfig?: TopologyConfig,
  ): Promise<(SubAgentResult | { error: string })[]> {
    const { providerName, resolvedModel } = orchestratorContext;
    logger.info(
      `[SequentialRouter] Starting sequential team execution of ${members.length} member(s)...`,
    );

    const results: (SubAgentResult | { error: string })[] = [];
    let accumulatedContext = "";

    for (let index = 0; index < members.length; index++) {
      const member = members[index];
      logger.info(
        `[SequentialRouter] Running step ${index + 1}/${members.length}: ${member.description}`,
      );

      // 1. Re-resolve instances per step (availability changes between sequential steps)
      const resolvedSiblings = await resolveSiblingInstances(
        { providerName, resolvedModel },
        "SequentialRouter",
      );
      const { assignedProvider, assignedModel } = selectInstanceForMember(
        member,
        resolvedSiblings,
        { providerName, resolvedModel },
      );

      // 2. Prepare step prompt by prepending accumulated context from all prior steps
      const basePrompt = member.prompt;
      const stepPrompt = accumulatedContext
        ? `--- PREVIOUS STEPS RESULTS ---\n${accumulatedContext}\n\n--- YOUR TASK ---\n${basePrompt}`
        : basePrompt;

      const assignment: OrchestratorSpawnParams = {
        description: member.description,
        prompt: stepPrompt,
        files: member.files,
        model: member.model,
        agent: member.agent,
        routing: member.routing,
        assignedProvider,
        assignedModel,
        agentIndex: index,
        globalSpawnIndex: nextGlobalSpawnIndex(orchestratorContext),
        teamSize: members.length,
        orchestratorContext,
        awaitCompletion: true,
      };

      // 3. Spawn and wait for this sub-agent to finish
      const spawnResult = await spawnSubAgent(assignment);
      results.push(spawnResult);

      if ("error" in spawnResult) {
        logger.error(
          `[SequentialRouter] Step ${index + 1} failed: ${spawnResult.error}. Aborting sequence.`,
        );
        break;
      }

      if (spawnResult.status === "failed") {
        logger.error(
          `[SequentialRouter] Step ${index + 1} failed. Aborting sequence.`,
        );
        break;
      }

      // 4. The step's work merged back when its loop ended (WorktreeMergeBack),
      //    so the next step's worktree branches from it. Work that could not
      //    merge is kept on its branch — and the next step must not run
      //    without it.
      if (isMergeBackKept(spawnResult.mergeBack)) {
        const errorMessage = `Step ${index + 1} (${spawnResult.agent_id}) did not merge back: ${spawnResult.mergeBack!.error ?? spawnResult.mergeBack!.status}. Its work is kept on branch ${spawnResult.mergeBack!.branch}. Aborting sequence.`;
        logger.error(`[SequentialRouter] ${errorMessage}`);
        return [...results, { error: errorMessage }];
      }

      // 5. Accumulate text result for subsequent agents (append, not overwrite)
      const stepOutput =
        spawnResult.result ||
        buildToolCallFallbackSummary(spawnResult) ||
        spawnResult.summary;
      const stepSummaryBlock = `Step ${index + 1} (${member.description}):\n${stepOutput}`;
      accumulatedContext = accumulatedContext
        ? `${accumulatedContext}\n\n---\n\n${stepSummaryBlock}`
        : stepSummaryBlock;
    }

    return results;
  }
}
