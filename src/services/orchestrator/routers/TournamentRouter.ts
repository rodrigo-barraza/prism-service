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

const MAXIMUM_EVALUATION_CHARACTERS = 120_000;

function truncateResultOutput(output: string, maximumCharacters: number): string {
  if (output.length <= maximumCharacters) return output;
  const truncatedOutput = output.slice(0, maximumCharacters);
  return `${truncatedOutput}\n\n[... truncated — output exceeded ${maximumCharacters.toLocaleString()} character budget]`;
}

function buildSelectionPrompt(
  teamName: string,
  memberResults: (SubAgentResult | { error: string })[],
): string {
  const characterBudgetPerMember = Math.floor(MAXIMUM_EVALUATION_CHARACTERS / Math.max(memberResults.length, 1));

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
      `**Tool Uses:** ${subAgentResult.toolUses}`,
      `**Duration:** ${subAgentResult.durationMs}ms`,
      `**Output:**\n${outputText}`,
    ].join("\n");
  });

  return [
    `You are a judge for the team "${teamName}".`,
    `${memberResults.length} sub-agents have independently completed the same task. Your job is to evaluate their outputs and select the SINGLE BEST result.`,
    "",
    "## Sub-Agent Results",
    "",
    resultSections.join("\n\n---\n\n"),
    "",
    "## Instructions",
    "",
    "1. Evaluate each sub-agent's output on the following criteria:",
    "   - **Correctness** — Is the solution factually and technically correct?",
    "   - **Completeness** — Does it fully address the task requirements?",
    "   - **Quality** — Is the code/reasoning clean, well-structured, and robust?",
    "   - **Verification** — Did the agent verify its work (tests, typechecks)?",
    "2. Select the single best sub-agent result. State which sub-agent number you chose.",
    "3. Reproduce the winning sub-agent's output VERBATIM — do not modify, merge, or improve it.",
    "4. Briefly justify your selection (2-3 sentences max).",
    "",
    "Format your response as:",
    "**Winner:** Sub-Agent #N",
    "**Justification:** [brief reason]",
    "",
    "**Selected Output:**",
    "[reproduce the winning output verbatim]",
  ].join("\n");
}

export class TournamentRouter implements TopologyRouter {
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
      `[TournamentRouter] createTeam: tournament selection of ${members.length} sub-agent(s)...`,
    );

    // ── Phase 1: Parallel execution (identical to HierarchicalRouter) ────

    const resolvedSiblings = await resolveSiblingInstances(
      { providerName, resolvedModel },
      "TournamentRouter",
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

    // ── Phase 2: Judge selection (Tournament / Best-of-N) ────────────────

    const successfulResults = memberResults.filter(
      (result) => !("error" in result) && result.status === "completed",
    );

    if (successfulResults.length === 0) {
      logger.warn(
        `[TournamentRouter] All ${memberResults.length} sub-agents failed — skipping judge pass`,
      );
      return memberResults;
    }

    if (successfulResults.length === 1) {
      logger.info(
        `[TournamentRouter] Only 1 sub-agent succeeded — auto-selecting as winner`,
      );
      return memberResults;
    }

    logger.info(
      `[TournamentRouter] Running judge selection over ${successfulResults.length} successful sub-agent results...`,
    );

    try {
      const selectionPrompt = buildSelectionPrompt(teamName, memberResults);
      const provider = getProvider(providerName);

      if (!provider) {
        logger.error(
          `[TournamentRouter] Provider "${providerName}" not found for judge pass`,
        );
        return memberResults;
      }

      const selectionStartTime = Date.now();
      const selectionRequestStartMs = performance.now();
      const selectionMessages = [{ role: "user", content: selectionPrompt }];
      const selectionResult = await provider.generateText(
        selectionMessages,
        resolvedModel,
        { maxTokens: 8192 },
      );
      const selectionDurationMs = Date.now() - selectionStartTime;

      RequestLogger.logBackgroundLlmCall({
        requestId: `${orchestratorContext.conversationId || "unknown"}-tournament-${teamName}`,
        endpoint: "/agent",
        operation: "orchestrator:tournament-judge",
        project: orchestratorContext.project || null,
        username: orchestratorContext.username || "system",
        agent: null,
        provider: providerName,
        model: resolvedModel,
        traceId: orchestratorContext.traceId || null,
        agentConversationId: orchestratorContext.agentConversationId || null,
        aiMessages: selectionMessages as Parameters<typeof RequestLogger.logBackgroundLlmCall>[0]["aiMessages"],
        resultText: selectionResult.text || "",
        usage: selectionResult.usage || null,
        success: true,
        errorMessage: null,
        requestStartMs: selectionRequestStartMs,
        extraRequestPayload: {
          teamName,
          memberCount: members.length,
          successfulCount: successfulResults.length,
        },
      }).catch((loggingError: unknown) =>
        logger.error(
          `[TournamentRouter] Failed to log tournament judge request: ${getErrorMessage(loggingError)}`,
        ),
      );

      const judgeSubAgentResult: SubAgentResult = {
        agent_id: `tournament-judge-${teamName}-${Date.now()}`,
        description: `Tournament judge for team "${teamName}"`,
        status: "completed",
        summary: `Evaluated ${successfulResults.length} sub-agent results and selected the best one`,
        result: selectionResult.text,
        toolUses: 0,
        iterations: 1,
        durationMs: selectionDurationMs,
        messages: [],
        diff: { additions: 0, deletions: 0, files: [] },
      };

      logger.info(
        `[TournamentRouter] Judge selection complete in ${selectionDurationMs}ms (${selectionResult.usage.inputTokens} input, ${selectionResult.usage.outputTokens} output tokens)`,
      );

      return [...memberResults, judgeSubAgentResult];
    } catch (judgeError: unknown) {
      const errorMessage =
        judgeError instanceof Error
          ? judgeError.message
          : String(judgeError);
      logger.error(
        `[TournamentRouter] Judge pass failed: ${errorMessage}`,
      );
      return memberResults;
    }
  }
}
