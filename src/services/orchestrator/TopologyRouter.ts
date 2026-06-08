import type {
  TeamMember,
  OrchestratorContext,
  OrchestratorSpawnParams,
  SubAgentResult,
} from "../../types/orchestrator.ts";
import type { TopologyType } from "@rodrigo-barraza/utilities-library/taxonomy";

export type { TopologyType };

export interface TopologyRouter {
  execute(
    teamName: string,
    members: TeamMember[],
    orchestratorContext: OrchestratorContext,
    spawnSubAgent: (
      assignment: OrchestratorSpawnParams,
    ) => Promise<SubAgentResult | { error: string }>,
  ): Promise<(SubAgentResult | { error: string })[]>;
}
