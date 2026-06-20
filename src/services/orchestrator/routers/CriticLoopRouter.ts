import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../../types/orchestrator.ts";
import type { TopologyRouter, ContinueSubAgentCallback } from "../TopologyRouter.ts";
import { buildToolCallFallbackSummary } from "../SubAgentResultBuilder.ts";
import {
  resolveSiblingInstances,
  selectInstanceForMember,
} from "../InstanceResolver.ts";
import logger from "../../../utils/logger.ts";

const DEFAULT_MAXIMUM_ROUNDS = 3;
const PASS_VERDICT_PATTERN = /\bPASS\b/i;
const FAIL_VERDICT_PATTERN = /\bFAIL\b/i;

function buildCriticPrompt(
  actorOutput: string,
  originalTask: string,
  roundNumber: number,
  maximumRounds: number,
): string {
  return [
    `You are a critic evaluating a sub-agent's work output.`,
    `This is evaluation round ${roundNumber} of ${maximumRounds}.`,
    "",
    "## Original Task",
    "",
    originalTask,
    "",
    "## Actor's Output",
    "",
    actorOutput,
    "",
    "## Your Job",
    "",
    "Evaluate the actor's output rigorously against the original task requirements.",
    "Be adversarial — look for mistakes, missed edge cases, incomplete work, poor quality, or incorrect reasoning.",
    "",
    "Respond with ONE of these verdicts:",
    "",
    "**PASS** — The output fully and correctly satisfies the task. Explain briefly why it passes.",
    "",
    "**FAIL** — The output has issues that need fixing. Provide specific, actionable feedback:",
    "- What exactly is wrong or missing",
    "- What specific changes are needed",
    "- Reference file paths, line numbers, or code snippets where applicable",
    "",
    "Start your response with either **PASS** or **FAIL** on the first line.",
  ].join("\n");
}

function buildActorRevisionPrompt(
  criticFeedback: string,
  roundNumber: number,
): string {
  return [
    `Your previous work was reviewed by a critic (round ${roundNumber}) and needs revision.`,
    "",
    "## Critic's Feedback",
    "",
    criticFeedback,
    "",
    "## Instructions",
    "",
    "1. Address ALL issues raised by the critic.",
    "2. Make the specific changes requested.",
    "3. Verify your corrections (run tests, typecheck, etc.).",
    "4. Commit and report what you changed.",
    "",
    "Focus on fixing the identified issues — do not restart from scratch unless the critic's feedback requires it.",
  ].join("\n");
}

function extractActorOutputText(spawnResult: SubAgentResult): string {
  return spawnResult.result
    || buildToolCallFallbackSummary(spawnResult)
    || spawnResult.summary;
}

function parseVerdict(criticOutput: string): { isPassing: boolean; feedback: string } {
  const firstLine = criticOutput.trim().split("\n")[0];

  if (PASS_VERDICT_PATTERN.test(firstLine)) {
    return { isPassing: true, feedback: criticOutput };
  }

  if (FAIL_VERDICT_PATTERN.test(firstLine)) {
    return { isPassing: false, feedback: criticOutput };
  }

  // Ambiguous verdict — treat as fail with the full output as feedback
  // so the actor gets a chance to revise
  logger.warn(
    `[CriticLoopRouter] Critic did not start with PASS or FAIL. Treating as FAIL.`,
  );
  return { isPassing: false, feedback: criticOutput };
}

function detectDegenerationOfThought(
  previousFeedback: string | null,
  currentFeedback: string,
): boolean {
  if (!previousFeedback) return false;

  // Normalize whitespace for comparison
  const normalizedPrevious = previousFeedback.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedCurrent = currentFeedback.trim().toLowerCase().replace(/\s+/g, " ");

  // If >80% of the content is identical, the critic is repeating itself
  // indicating Degeneration-of-Thought (DoT)
  const shorterLength = Math.min(normalizedPrevious.length, normalizedCurrent.length);
  if (shorterLength === 0) return false;

  let matchingCharacters = 0;
  const comparisonLength = Math.min(shorterLength, 500);
  for (let characterIndex = 0; characterIndex < comparisonLength; characterIndex++) {
    if (normalizedPrevious[characterIndex] === normalizedCurrent[characterIndex]) {
      matchingCharacters++;
    }
  }

  const similarityRatio = matchingCharacters / comparisonLength;
  return similarityRatio > 0.8;
}

/**
 * Critic Loop Router — Actor-Critic Iterative Refinement (MAR)
 *
 * Implements a stateful Actor→Critic feedback loop:
 * 1. Actor spawns and executes the task (preserveWorktree: true)
 * 2. Critic spawns and evaluates the Actor's output
 * 3. If FAIL: Actor continues with critic's feedback via continueSubAgent
 * 4. Repeat until PASS or maximum rounds reached
 *
 * Includes Degeneration-of-Thought (DoT) protection: if the critic
 * repeats the same feedback twice in a row, the loop force-terminates
 * to avoid infinite cycles (per MAR research findings).
 *
 * Members mapping:
 * - members[0] = Actor (required)
 * - members[1] = Critic (optional — auto-generated if missing)
 * - members[2+] = Additional critics form a panel (future enhancement)
 */
export class CriticLoopRouter implements TopologyRouter {
  async execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
    continueSubAgent?: ContinueSubAgentCallback,
  ): Promise<(SubAgentResult | { error: string })[]> {
    const { providerName, resolvedModel } = orchestratorContext;

    if (members.length === 0) {
      const errorMessage = "Critic Loop topology requires at least 1 member (the actor).";
      logger.error(`[CriticLoopRouter] ${errorMessage}`);
      return [{ error: errorMessage }];
    }

    const actorMember = members[0];
    const criticMember: TeamMember = members[1] || {
      description: `Critic for "${actorMember.description}"`,
      prompt: "Review and evaluate the actor's output.",
      files: actorMember.files,
    };

    const maximumRounds = DEFAULT_MAXIMUM_ROUNDS;
    const allResults: (SubAgentResult | { error: string })[] = [];
    let previousCriticFeedback: string | null = null;
    let actorAgentId: string | null = null;

    logger.info(
      `[CriticLoopRouter] Starting Actor-Critic loop for team "${teamName}" (max ${maximumRounds} rounds)...`,
    );

    // ── Round 1: Initial Actor spawn ────────────────────────────────────

    const resolvedSiblings = await resolveSiblingInstances(
      { providerName, resolvedModel },
      "CriticLoopRouter",
    );

    const { assignedProvider: actorProvider, assignedModel: actorModel } =
      selectInstanceForMember(
        actorMember,
        resolvedSiblings,
        { providerName, resolvedModel },
      );

    const actorAssignment: OrchestratorSpawnParams = {
      description: `${actorMember.description} (Actor, Round 1)`,
      prompt: actorMember.prompt,
      files: actorMember.files,
      model: actorMember.model,
      agent: actorMember.agent,
      assignedProvider: actorProvider,
      assignedModel: actorModel,
      agentIndex: 0,
      teamSize: 2,
      round: 1,
      orchestratorContext,
      preserveWorktree: true,
    };

    logger.info(
      `[CriticLoopRouter] Round 1: Spawning Actor "${actorMember.description}"...`,
    );

    let actorResult = await spawnSubAgent(actorAssignment);
    allResults.push(actorResult);

    if ("error" in actorResult) {
      logger.error(
        `[CriticLoopRouter] Actor failed on initial spawn: ${actorResult.error}`,
      );
      return allResults;
    }

    if (actorResult.status !== "completed") {
      logger.error(
        `[CriticLoopRouter] Actor did not complete (status: ${actorResult.status}). Aborting loop.`,
      );
      return allResults;
    }

    actorAgentId = actorResult.agent_id;

    // ── Critic evaluation rounds ────────────────────────────────────────

    for (let roundNumber = 1; roundNumber <= maximumRounds; roundNumber++) {
      const actorOutputText = extractActorOutputText(actorResult as SubAgentResult);

      logger.info(
        `[CriticLoopRouter] Round ${roundNumber}/${maximumRounds}: Spawning Critic to evaluate Actor's output...`,
      );

      // Spawn a FRESH critic each round (no session reuse — different eyes each time)
      const { assignedProvider: criticProvider, assignedModel: criticModel } =
        selectInstanceForMember(
          criticMember,
          resolvedSiblings,
          { providerName, resolvedModel },
        );

      const criticPromptText = buildCriticPrompt(
        actorOutputText,
        actorMember.prompt,
        roundNumber,
        maximumRounds,
      );

      const criticAssignment: OrchestratorSpawnParams = {
        description: `${criticMember.description} (Critic, Round ${roundNumber})`,
        prompt: criticPromptText,
        files: criticMember.files,
        model: criticMember.model,
        agent: criticMember.agent,
        assignedProvider: criticProvider,
        assignedModel: criticModel,
        agentIndex: 1,
        teamSize: 2,
        round: roundNumber,
        orchestratorContext,
      };

      const criticResult = await spawnSubAgent(criticAssignment);
      allResults.push(criticResult);

      if ("error" in criticResult) {
        logger.error(
          `[CriticLoopRouter] Critic failed in round ${roundNumber}: ${criticResult.error}. Returning Actor's last output.`,
        );
        return allResults;
      }

      if (criticResult.status !== "completed") {
        logger.warn(
          `[CriticLoopRouter] Critic did not complete in round ${roundNumber}. Returning Actor's last output.`,
        );
        return allResults;
      }

      const criticOutputText = extractActorOutputText(criticResult);
      const verdict = parseVerdict(criticOutputText);

      if (verdict.isPassing) {
        logger.info(
          `[CriticLoopRouter] Round ${roundNumber}: Critic PASSED. Actor's output accepted.`,
        );
        return allResults;
      }

      logger.info(
        `[CriticLoopRouter] Round ${roundNumber}: Critic FAILED. Providing feedback to Actor...`,
      );

      // ── DoT detection ─────────────────────────────────────────────────
      if (detectDegenerationOfThought(previousCriticFeedback, verdict.feedback)) {
        logger.warn(
          `[CriticLoopRouter] Degeneration-of-Thought detected — critic is repeating the same feedback. Force-terminating loop.`,
        );
        return allResults;
      }
      previousCriticFeedback = verdict.feedback;

      // ── Check if we have rounds remaining for revision ────────────────
      if (roundNumber >= maximumRounds) {
        logger.warn(
          `[CriticLoopRouter] Maximum rounds (${maximumRounds}) reached. Returning last Actor output despite critic failure.`,
        );
        return allResults;
      }

      // ── Continue Actor with critic's feedback ─────────────────────────
      if (!continueSubAgent) {
        logger.error(
          `[CriticLoopRouter] continueSubAgent callback not provided — cannot continue Actor session for revision.`,
        );
        return allResults;
      }

      if (!actorAgentId) {
        logger.error(
          `[CriticLoopRouter] No Actor agent ID available for continuation.`,
        );
        return allResults;
      }

      const revisionPrompt = buildActorRevisionPrompt(
        verdict.feedback,
        roundNumber,
      );

      logger.info(
        `[CriticLoopRouter] Round ${roundNumber + 1}: Continuing Actor with critic's feedback...`,
      );

      actorResult = await continueSubAgent(
        actorAgentId,
        revisionPrompt,
        orchestratorContext,
        roundNumber + 1,
      );
      allResults.push(actorResult);

      if ("error" in actorResult) {
        logger.error(
          `[CriticLoopRouter] Actor failed on revision round ${roundNumber + 1}: ${actorResult.error}`,
        );
        return allResults;
      }

      if (actorResult.status !== "completed") {
        logger.warn(
          `[CriticLoopRouter] Actor did not complete revision (status: ${actorResult.status}). Returning partial results.`,
        );
        return allResults;
      }
    }

    return allResults;
  }
}
