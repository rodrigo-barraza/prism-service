import { describe, it, expect } from "vitest";
import { getOrchestratorPromptAddendum } from "../../OrchestratorPrompt.ts";
import ToolOrchestratorService from "../../ToolOrchestratorService.ts";

describe("getOrchestratorPromptAddendum", () => {
  it("should mark hierarchical as default when defaultTopology is hierarchical or omitted", () => {
    const prompt = getOrchestratorPromptAddendum({ subAgentTools: [] });
    expect(prompt).toContain("**`hierarchical`** (default)");
    expect(prompt).not.toContain("**`sequential`** (default)");
    expect(prompt).not.toContain("**`peer_to_peer`** (default)");
  });

  it("should mark sequential as default when defaultTopology is sequential", () => {
    const prompt = getOrchestratorPromptAddendum({
      subAgentTools: [],
      defaultTopology: "sequential",
    });
    expect(prompt).toContain("**`sequential`** (default)");
    expect(prompt).not.toContain("**`hierarchical`** (default)");
    expect(prompt).not.toContain("**`peer_to_peer`** (default)");
  });

  it("should mark peer_to_peer as default when defaultTopology is peer_to_peer", () => {
    const prompt = getOrchestratorPromptAddendum({
      subAgentTools: [],
      defaultTopology: "peer_to_peer",
    });
    expect(prompt).toContain("**`peer_to_peer`** (default)");
    expect(prompt).not.toContain("**`hierarchical`** (default)");
    expect(prompt).not.toContain("**`sequential`** (default)");
  });
});

describe("ToolOrchestratorService tool schemas dynamic defaults", () => {
  it("should output hierarchical as default in create_team schema description when defaultTopology is hierarchical", () => {
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas("hierarchical");
    const createTeam = clientSchemas.find(s => s.name === "create_subagents");
    expect(createTeam).toBeDefined();
    expect(createTeam?.description).toContain("'hierarchical' (default)");
    expect(createTeam?.description).not.toContain("'sequential' (default)");
    expect(createTeam?.description).not.toContain("'peer_to_peer' (default)");

    const topologyParam = (createTeam?.parameters as any)?.properties?.topology;
    expect(topologyParam).toBeDefined();
    expect(topologyParam.description).toContain("'hierarchical (default)'");
    expect(topologyParam.description).not.toContain("'sequential (default)'");
    expect(topologyParam.description).not.toContain("'peer_to_peer (default)'");
  });

  it("should output sequential as default in create_team schema description when defaultTopology is sequential", () => {
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas("sequential");
    const createTeam = clientSchemas.find(s => s.name === "create_subagents");
    expect(createTeam?.description).toContain("'sequential' (default)");
    expect(createTeam?.description).not.toContain("'hierarchical' (default)");
    expect(createTeam?.description).not.toContain("'peer_to_peer' (default)");

    const topologyParam = (createTeam?.parameters as any)?.properties?.topology;
    expect(topologyParam.description).toContain("'sequential (default)'");
    expect(topologyParam.description).not.toContain("'hierarchical (default)'");
    expect(topologyParam.description).not.toContain("'peer_to_peer (default)'");
  });

  it("should output peer_to_peer as default in create_team schema description when defaultTopology is peer_to_peer or p2p", () => {
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas("peer_to_peer");
    const createTeam = clientSchemas.find(s => s.name === "create_subagents");
    expect(createTeam?.description).toContain("'peer_to_peer' (default)");
    expect(createTeam?.description).not.toContain("'hierarchical' (default)");
    expect(createTeam?.description).not.toContain("'sequential' (default)");

    const topologyParam = (createTeam?.parameters as any)?.properties?.topology;
    expect(topologyParam.description).toContain("'peer_to_peer (default)'");
    expect(topologyParam.description).not.toContain("'hierarchical (default)'");
    expect(topologyParam.description).not.toContain("'sequential' (default)'");
  });
});
