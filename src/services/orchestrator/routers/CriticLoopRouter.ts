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

interface CriticVerdict {
  criticIndex: number;
  criticDescription: string;
  isPassing: boolean;
  feedback: string;
}

function buildCriticPrompt(
  actorOutput: string,
  originalTask: string,
  roundNumber: number,
  maximumRounds: number,
  criticRole?: string,
): string {
  const roleContext = criticRole
    ? `You are a specialized critic with the following focus: ${criticRole}\n`
    : "";

  return [
    `You are a critic evaluating a sub-agent's work output.`,
    roleContext,
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
  criticVerdicts: CriticVerdict[],
  roundNumber: number,
): string {
  const failedVerdicts = criticVerdicts.filter((verdict) => !verdict.isPassing);
  const passedVerdicts = criticVerdicts.filter((verdict) => verdict.isPassing);

  const feedbackSections = failedVerdicts.map((verdict) => {
    return [
      `### Critic: ${verdict.criticDescription}`,
      verdict.feedback,
    ].join("\n");
  });

  const passedSummary = passedVerdicts.length > 0
    ? `\n\nThe following critics PASSED your work (do not regress on their areas):\n${passedVerdicts.map((verdict) => `- ✅ ${verdict.criticDescription}`).join("\n")}`
    : "";

  return [
    `Your previous work was reviewed by ${criticVerdicts.length} critic(s) in round ${roundNumber} and needs revision.`,
    `${failedVerdicts.length} critic(s) FAILED your output. You must address ALL their feedback.`,
    passedSummary,
    "",
    "## Critic Feedback (FAIL verdicts)",
    "",
    feedbackSections.join("\n\n---\n\n"),
    "",
    "## Instructions",
    "",
    "1. Address ALL issues raised by EVERY failing critic.",
    "2. Make the specific changes requested.",
    "3. Do NOT regress on areas that passed — critics who passed will review again.",
    "4. Verify your corrections (run tests, typecheck, etc.).",
    "5. Commit and report what you changed.",
    "",
    "Focus on fixing the identified issues — do not restart from scratch unless the feedback requires it.",
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

  // If >80% of the content is identical, the critic panel is repeating itself
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
 * Implements a stateful Actor→Critics feedback loop with multi-critic panel support:
 * 1. Actor spawns and executes the task (preserveWorktree: true)
 * 2. All critics spawn IN PARALLEL and evaluate the Actor's output independently
 * 3. Unanimous consensus required — ALL critics must PASS for the loop to terminate
 * 4. If any critic FAILs: all FAIL feedback is aggregated into a single revision prompt
 * 5. Actor continues with aggregated feedback via continueSubAgent
 * 6. Repeat until unanimous PASS or maximum rounds reached
 *
 * Includes Degeneration-of-Thought (DoT) protection: if the aggregated critic
 * feedback is >80% similar to the previous round, the loop force-terminates
 * to avoid infinite cycles (per MAR research findings).
 *
 * Members mapping:
 * - members[0] = Actor (required)
 * - members[1] = First critic (optional — auto-generated if missing)
 * - members[2+] = Additional critics forming a panel (Council of Judges)
 *
 * Each critic can be specialized via its description/prompt fields:
 * - Fact-checker, logic auditor, style critic, security reviewer, etc.
 * - Fresh critic instances spawned each round (no session reuse)
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

    // Build critic panel: members[1..N] or auto-generate a single generic critic
    const criticMembers: TeamMember[] = members.length > 1
      ? members.slice(1)
      : [{
          description: `Critic for "${actorMember.description}"`,
          prompt: "Review and evaluate the actor's output.",
          files: actorMember.files,
        }];

    const criticCount = criticMembers.length;
    const totalTeamSize = 1 + criticCount;
    const maximumRounds = DEFAULT_MAXIMUM_ROUNDS;
    const allResults: (SubAgentResult | { error: string })[] = [];
    let previousAggregatedFeedback: string | null = null;
    let actorAgentId: string | null = null;

    logger.info(
      `[CriticLoopRouter] Starting Actor-Critic loop for team "${teamName}" (${criticCount} critic(s), max ${maximumRounds} rounds)...`,
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
      teamSize: totalTeamSize,
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
        `[CriticLoopRouter] Round ${roundNumber}/${maximumRounds}: Spawning ${criticCount} critic(s) in parallel...`,
      );

      // Spawn ALL critics in parallel — each evaluates independently
      const criticSpawnPromises: Promise<SubAgentResult | { error: string }>[] =
        criticMembers.map((criticMember, criticMemberIndex) => {
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
            criticMember.description,
          );

          const criticAssignment: OrchestratorSpawnParams = {
            description: `${criticMember.description} (Critic ${criticMemberIndex + 1}/${criticCount}, Round ${roundNumber})`,
            prompt: criticPromptText,
            files: criticMember.files,
            model: criticMember.model,
            agent: criticMember.agent,
            assignedProvider: criticProvider,
            assignedModel: criticModel,
            agentIndex: 1 + criticMemberIndex,
            teamSize: totalTeamSize,
            round: roundNumber,
            orchestratorContext,
          };

          return spawnSubAgent(criticAssignment);
        });

      const criticResults = await Promise.all(criticSpawnPromises);
      allResults.push(...criticResults);

      // Parse all critic verdicts
      const verdicts: CriticVerdict[] = [];

      for (let criticResultIndex = 0; criticResultIndex < criticResults.length; criticResultIndex++) {
        const criticResult = criticResults[criticResultIndex];
        const criticMember = criticMembers[criticResultIndex];

        if ("error" in criticResult) {
          logger.error(
            `[CriticLoopRouter] Critic "${criticMember.description}" failed in round ${roundNumber}: ${criticResult.error}`,
          );
          // Treat errored critics as FAIL with the error as feedback
          verdicts.push({
            criticIndex: criticResultIndex,
            criticDescription: criticMember.description,
            isPassing: false,
            feedback: `Critic errored: ${criticResult.error}`,
          });
          continue;
        }

        if (criticResult.status !== "completed") {
          logger.warn(
            `[CriticLoopRouter] Critic "${criticMember.description}" did not complete in round ${roundNumber}`,
          );
          verdicts.push({
            criticIndex: criticResultIndex,
            criticDescription: criticMember.description,
            isPassing: false,
            feedback: `Critic did not complete (status: ${criticResult.status})`,
          });
          continue;
        }

        const criticOutputText = extractActorOutputText(criticResult);
        const verdict = parseVerdict(criticOutputText);

        verdicts.push({
          criticIndex: criticResultIndex,
          criticDescription: criticMember.description,
          isPassing: verdict.isPassing,
          feedback: verdict.feedback,
        });
      }

      // Check for unanimous consensus
      const passingVerdicts = verdicts.filter((verdict) => verdict.isPassing);
      const failingVerdicts = verdicts.filter((verdict) => !verdict.isPassing);

      logger.info(
        `[CriticLoopRouter] Round ${roundNumber}: ${passingVerdicts.length}/${verdicts.length} critics PASSED`,
      );

      if (failingVerdicts.length === 0) {
        logger.info(
          `[CriticLoopRouter] Round ${roundNumber}: Unanimous PASS from all ${verdicts.length} critic(s). Actor's output accepted.`,
        );
        return allResults;
      }

      logger.info(
        `[CriticLoopRouter] Round ${roundNumber}: ${failingVerdicts.length} critic(s) FAILED. Aggregating feedback for Actor...`,
      );

      // ── DoT detection on aggregated feedback ──────────────────────────
      const aggregatedFeedback = failingVerdicts
        .map((verdict) => `[${verdict.criticDescription}]: ${verdict.feedback}`)
        .join("\n\n");

      if (detectDegenerationOfThought(previousAggregatedFeedback, aggregatedFeedback)) {
        logger.warn(
          `[CriticLoopRouter] Degeneration-of-Thought detected — critic panel is repeating the same aggregated feedback. Force-terminating loop.`,
        );
        return allResults;
      }
      previousAggregatedFeedback = aggregatedFeedback;

      // ── Check if we have rounds remaining for revision ────────────────
      if (roundNumber >= maximumRounds) {
        logger.warn(
          `[CriticLoopRouter] Maximum rounds (${maximumRounds}) reached. Returning last Actor output despite ${failingVerdicts.length} critic failure(s).`,
        );
        return allResults;
      }

      // ── Continue Actor with aggregated critic feedback ────────────────
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

      const revisionPrompt = buildActorRevisionPrompt(verdicts, roundNumber);

      logger.info(
        `[CriticLoopRouter] Round ${roundNumber + 1}: Continuing Actor with aggregated feedback from ${failingVerdicts.length} failing critic(s)...`,
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
