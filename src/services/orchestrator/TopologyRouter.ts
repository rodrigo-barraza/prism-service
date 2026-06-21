import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../types/orchestrator.ts";
import type { TopologyType } from "@rodrigo-barraza/utilities-library/taxonomy";

export type { TopologyType };

export type TopologyConfig = Record<string, number | string | boolean>;

/**
 * Callback to continue an existing sub-agent's session with a follow-up prompt.
 * Used by turn-based routers (PeerToPeerRouter) to reuse the same agent instance,
 * worktree, and conversation state across multiple rounds — instead of spawning
 * a new sub-agent on every turn.
 */
export type ContinueSubAgentCallback = (
  agentId: string,
  prompt: string,
  orchestratorContext: OrchestratorContext,
  round?: number,
) => Promise<SubAgentResult | { error: string }>;

export interface TopologyRouter {
  execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
    continueSubAgent?: ContinueSubAgentCallback,
    topologyConfig?: TopologyConfig,
  ): Promise<(SubAgentResult | { error: string })[]>;
}

