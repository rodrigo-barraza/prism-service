/**
 * buildConversationGraph — Unit Tests
 *
 * Adversarial test suite verifying the graph builder produces structurally
 * correct graphs for all topology types, handles edge cases (empty requests,
 * missing fields, multi-turn conversations, deeply nested sub-agents), and
 * ensures node deduplication, correct edge wiring, and deterministic layout
 * positions.
 */

import { describe, it, expect } from "vitest";
import { buildConversationGraph } from "../src/services/conversation/buildConversationGraph.ts";
import type { GraphData } from "@rodrigo-barraza/utilities-library/graph";

// ── Test Fixtures ──────────────────────────────────────────────────

const TEST_CONVERSATION_ID = "conv-abc-123";
const TEST_AGENT_CONVERSATION_ID = "agent-conv-xyz-789";
const CANVAS_WIDTH = 1600;
const CANVAS_HEIGHT = 900;

function createMockConversation(overrides: Record<string, unknown> = {}) {
  return {
    _id: TEST_CONVERSATION_ID,
    id: TEST_CONVERSATION_ID,
    project: "test-project",
    agent: "OMNI",
    status: "completed",
    title: "Test Conversation",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:05:00Z",
    messages: [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there" },
    ],
    settings: { agents: { topology: "hierarchical" } },
    ...overrides,
  };
}

function createMockRequest(overrides: Record<string, unknown> = {}) {
  return {
    _id: `req-${Math.random().toString(36).slice(2, 8)}`,
    agentConversationId: TEST_AGENT_CONVERSATION_ID,
    operation: "chat",
    estimatedCost: 0.001,
    inputTokens: 100,
    outputTokens: 50,
    createdAt: "2026-07-01T00:01:00Z",
    model: "gpt-4o",
    provider: "openai",
    agent: "OMNI",
    username: "testuser",
    ...overrides,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function findNodeById(graph: GraphData, nodeId: string) {
  return graph.nodes.find((node) => node.id === nodeId);
}

function findNodesByCategory(graph: GraphData, category: string) {
  return graph.nodes.filter((node) => node.category === category);
}

function findEdge(graph: GraphData, source: string, target: string) {
  return graph.edges.find(
    (edge) => edge.source === source && edge.target === target,
  );
}

function getNodeIds(graph: GraphData): string[] {
  return graph.nodes.map((node) => node.id);
}

// ── Tests ──────────────────────────────────────────────────────────

describe("buildConversationGraph", () => {
  describe("Basic graph structure", () => {
    it("should produce a non-empty graph with a session, agent, and project node", () => {
      const conversation = createMockConversation();
      const graph = buildConversationGraph(conversation, null, [], CANVAS_WIDTH, CANVAS_HEIGHT);

      expect(graph.nodes.length).toBeGreaterThanOrEqual(3);
      expect(graph.edges.length).toBeGreaterThanOrEqual(2);

      const sessionNodes = findNodesByCategory(graph, "session");
      const agentNodes = findNodesByCategory(graph, "agent");
      const projectNodes = findNodesByCategory(graph, "project");

      expect(sessionNodes).toHaveLength(1);
      expect(agentNodes).toHaveLength(1);
      expect(projectNodes).toHaveLength(1);

      expect(sessionNodes[0].id).toBe(`session:${TEST_CONVERSATION_ID}`);
      expect(sessionNodes[0].label).toBe("Test Conversation");
    });

    it("should wire project → session → agent edges", () => {
      const conversation = createMockConversation();
      const graph = buildConversationGraph(conversation, null, [], CANVAS_WIDTH, CANVAS_HEIGHT);

      const projectToSession = findEdge(graph, `project:test-project`, `session:${TEST_CONVERSATION_ID}`);
      const sessionToAgent = graph.edges.find(
        (edge) => edge.source === `session:${TEST_CONVERSATION_ID}` && edge.target.startsWith("agent:"),
      );

      expect(projectToSession).toBeDefined();
      expect(sessionToAgent).toBeDefined();
    });

    it("should never create duplicate node IDs", () => {
      const requests = Array.from({ length: 20 }, (_, index) =>
        createMockRequest({
          _id: `req-${index}`,
          createdAt: `2026-07-01T00:0${Math.floor(index / 10)}:${String(index % 60).padStart(2, "0")}Z`,
        }),
      );
      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const nodeIds = getNodeIds(graph);
      const uniqueNodeIds = new Set(nodeIds);
      expect(uniqueNodeIds.size).toBe(nodeIds.length);
    });

    it("should never create duplicate edges", () => {
      const requests = Array.from({ length: 10 }, (_, index) =>
        createMockRequest({
          _id: `req-${index}`,
          createdAt: `2026-07-01T00:01:${String(index * 5).padStart(2, "0")}Z`,
        }),
      );
      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const edgeKeys = graph.edges.map((edge) => `${edge.source}→${edge.target}`);
      const uniqueEdgeKeys = new Set(edgeKeys);
      expect(uniqueEdgeKeys.size).toBe(edgeKeys.length);
    });
  });

  describe("Request node creation", () => {
    it("should create one request node per request entry", () => {
      const requests = [
        createMockRequest({ _id: "req-1", createdAt: "2026-07-01T00:01:00Z" }),
        createMockRequest({ _id: "req-2", createdAt: "2026-07-01T00:02:00Z" }),
        createMockRequest({ _id: "req-3", createdAt: "2026-07-01T00:03:00Z" }),
      ];
      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const requestNodes = findNodesByCategory(graph, "request");
      expect(requestNodes).toHaveLength(3);
    });

    it("should assign monotonically increasing sequence numbers", () => {
      const requests = [
        createMockRequest({ _id: "req-a", createdAt: "2026-07-01T00:01:00Z" }),
        createMockRequest({ _id: "req-b", createdAt: "2026-07-01T00:02:00Z" }),
        createMockRequest({ _id: "req-c", createdAt: "2026-07-01T00:03:00Z" }),
      ];
      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const requestNodes = findNodesByCategory(graph, "request")
        .sort((nodeA, nodeB) => (nodeA.sequenceNumber ?? 0) - (nodeB.sequenceNumber ?? 0));

      expect(requestNodes[0].sequenceNumber).toBe(1);
      expect(requestNodes[1].sequenceNumber).toBe(2);
      expect(requestNodes[2].sequenceNumber).toBe(3);
    });

    it("should chain request nodes sequentially via edges", () => {
      const requests = [
        createMockRequest({ _id: "req-1", createdAt: "2026-07-01T00:01:00Z" }),
        createMockRequest({ _id: "req-2", createdAt: "2026-07-01T00:02:00Z" }),
        createMockRequest({ _id: "req-3", createdAt: "2026-07-01T00:03:00Z" }),
      ];
      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      // req-1 → req-2 → req-3 chain (possibly through turn nodes)
      const requestNodeIds = findNodesByCategory(graph, "request")
        .sort((nodeA, nodeB) => (nodeA.sequenceNumber ?? 0) - (nodeB.sequenceNumber ?? 0))
        .map((node) => node.id);

      // First request should connect from the agent or a turn node
      const firstRequestInbound = graph.edges.find((edge) => edge.target === requestNodeIds[0]);
      expect(firstRequestInbound).toBeDefined();

      // Subsequent requests should chain
      for (let index = 1; index < requestNodeIds.length; index++) {
        const chainEdge = graph.edges.find((edge) => edge.target === requestNodeIds[index]);
        expect(chainEdge).toBeDefined();
      }
    });

    it("should embed tool names in request node metadata", () => {
      const requests = [
        createMockRequest({
          _id: "req-tools",
          toolApiNames: ["read_file", "write_file", "read_file"],
        }),
      ];
      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const requestNode = findNodeById(graph, "request:req-tools");
      expect(requestNode).toBeDefined();
      const toolNames = requestNode!.metadata?.toolNames as string[];
      expect(toolNames).toEqual(["read_file", "write_file"]);
    });
  });

  describe("Multi-turn conversations", () => {
    it("should create turn boundary nodes when agentConversationId changes", () => {
      const requests = [
        createMockRequest({ _id: "req-t1-1", agentConversationId: "turn-1", createdAt: "2026-07-01T00:01:00Z" }),
        createMockRequest({ _id: "req-t1-2", agentConversationId: "turn-1", createdAt: "2026-07-01T00:02:00Z" }),
        createMockRequest({ _id: "req-t2-1", agentConversationId: "turn-2", createdAt: "2026-07-01T00:03:00Z" }),
      ];
      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const turnNodes = findNodesByCategory(graph, "turn");
      // Should have at least 2 turn nodes (one per distinct agentConversationId)
      expect(turnNodes.length).toBeGreaterThanOrEqual(2);
    });

    it("should use user message text as turn node labels", () => {
      const conversation = createMockConversation({
        messages: [
          { role: "user", content: "First question" },
          { role: "assistant", content: "First answer" },
          { role: "user", content: "Second question" },
          { role: "assistant", content: "Second answer" },
        ],
      });
      const requests = [
        createMockRequest({ _id: "req-1", agentConversationId: "turn-1", createdAt: "2026-07-01T00:01:00Z" }),
        createMockRequest({ _id: "req-2", agentConversationId: "turn-2", createdAt: "2026-07-01T00:02:00Z" }),
      ];
      const graph = buildConversationGraph(conversation, null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const turnNodes = findNodesByCategory(graph, "turn");
      const turnLabels = turnNodes.map((node) => node.label);

      expect(turnLabels).toContain("First question");
      expect(turnLabels).toContain("Second question");
    });
  });

  describe("Sub-agent graph topology", () => {
    it("should create subagent nodes for requests with parentAgentConversationId", () => {
      const requests = [
        createMockRequest({
          _id: "req-main",
          agentConversationId: TEST_AGENT_CONVERSATION_ID,
          createdAt: "2026-07-01T00:01:00Z",
          toolApiNames: ["create_subagent"],
        }),
        createMockRequest({
          _id: "req-sub-1",
          agentConversationId: "sub-agent-conv-1",
          parentAgentConversationId: TEST_AGENT_CONVERSATION_ID,
          agent: "RESEARCHER",
          createdAt: "2026-07-01T00:02:00Z",
        }),
        createMockRequest({
          _id: "req-sub-2",
          agentConversationId: "sub-agent-conv-1",
          parentAgentConversationId: TEST_AGENT_CONVERSATION_ID,
          agent: "RESEARCHER",
          createdAt: "2026-07-01T00:03:00Z",
        }),
      ];

      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const subagentNodes = findNodesByCategory(graph, "subagent");
      expect(subagentNodes).toHaveLength(1);
      expect(subagentNodes[0].label).toBe("RESEARCHER");
      expect(subagentNodes[0].metadata?.isSubagent).toBe(true);
    });

    it("should compute correct depth for nested sub-agents", () => {
      const requests = [
        createMockRequest({
          _id: "req-main",
          agentConversationId: TEST_AGENT_CONVERSATION_ID,
          createdAt: "2026-07-01T00:01:00Z",
        }),
        createMockRequest({
          _id: "req-depth1",
          agentConversationId: "sub-depth-1",
          parentAgentConversationId: TEST_AGENT_CONVERSATION_ID,
          agent: "LEVEL1",
          createdAt: "2026-07-01T00:02:00Z",
        }),
        createMockRequest({
          _id: "req-depth2",
          agentConversationId: "sub-depth-2",
          parentAgentConversationId: "sub-depth-1",
          agent: "LEVEL2",
          createdAt: "2026-07-01T00:03:00Z",
        }),
      ];

      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const subagentNodes = findNodesByCategory(graph, "subagent");
      const level1 = subagentNodes.find((node) => node.label === "LEVEL1");
      const level2 = subagentNodes.find((node) => node.label === "LEVEL2");

      expect(level1).toBeDefined();
      expect(level2).toBeDefined();
      expect(level1!.depth).toBe(1);
      expect(level2!.depth).toBe(2);
    });

    it("should build subAgentTree correctly in the output", () => {
      const requests = [
        createMockRequest({
          _id: "req-main",
          agentConversationId: TEST_AGENT_CONVERSATION_ID,
          createdAt: "2026-07-01T00:01:00Z",
        }),
        createMockRequest({
          _id: "req-sub-a",
          agentConversationId: "sub-a",
          parentAgentConversationId: TEST_AGENT_CONVERSATION_ID,
          agent: "WORKER_A",
          createdAt: "2026-07-01T00:02:00Z",
        }),
        createMockRequest({
          _id: "req-sub-b",
          agentConversationId: "sub-b",
          parentAgentConversationId: TEST_AGENT_CONVERSATION_ID,
          agent: "WORKER_B",
          createdAt: "2026-07-01T00:03:00Z",
        }),
      ];

      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      expect(graph.subAgentTree).toBeDefined();
      expect(graph.subAgentTree).toHaveLength(2);
      expect(graph.subAgentTree[0].agentConversationId).toBe("sub-a");
      expect(graph.subAgentTree[1].agentConversationId).toBe("sub-b");
    });
  });

  describe("User nodes", () => {
    it("should create user nodes for non-default usernames", () => {
      const requests = [
        createMockRequest({ _id: "req-1", username: "alice", createdAt: "2026-07-01T00:01:00Z" }),
        createMockRequest({ _id: "req-2", username: "bob", createdAt: "2026-07-01T00:02:00Z" }),
      ];
      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const userNodes = findNodesByCategory(graph, "user");
      const userLabels = userNodes.map((node) => node.label);
      expect(userLabels).toContain("alice");
      expect(userLabels).toContain("bob");
    });

    it("should NOT create user nodes for 'system' or default username", () => {
      const requests = [
        createMockRequest({ _id: "req-1", username: "system", createdAt: "2026-07-01T00:01:00Z" }),
        createMockRequest({ _id: "req-2", username: "anonymous", createdAt: "2026-07-01T00:02:00Z" }),
      ];
      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const userNodes = findNodesByCategory(graph, "user");
      const userLabels = userNodes.map((node) => node.label);
      expect(userLabels).not.toContain("system");
      expect(userLabels).not.toContain("anonymous");
    });
  });

  describe("Layout positions", () => {
    it("should assign finite x/y coordinates to all nodes", () => {
      const requests = Array.from({ length: 5 }, (_, index) =>
        createMockRequest({
          _id: `req-${index}`,
          createdAt: `2026-07-01T00:0${index}:00Z`,
        }),
      );
      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      for (const node of graph.nodes) {
        expect(Number.isFinite(node.x)).toBe(true);
        expect(Number.isFinite(node.y)).toBe(true);
      }
    });

    it("should produce different layouts for different canvas dimensions", () => {
      const requests = [
        createMockRequest({ _id: "req-1", createdAt: "2026-07-01T00:01:00Z" }),
      ];
      const conversation = createMockConversation();

      const smallGraph = buildConversationGraph(conversation, null, requests, 800, 600);
      const largeGraph = buildConversationGraph(conversation, null, requests, 3200, 1800);

      // At least one node should have different coordinates
      const smallPositions = new Map(smallGraph.nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
      const hasPositionDifference = largeGraph.nodes.some((node) => {
        const smallPosition = smallPositions.get(node.id);
        return smallPosition && (smallPosition.x !== node.x || smallPosition.y !== node.y);
      });
      expect(hasPositionDifference).toBe(true);
    });
  });

  describe("Topology-specific layouts", () => {
    const topologies = ["hierarchical", "sequential", "peer_to_peer", "critic_loop", "tournament", "mcts"];

    for (const topology of topologies) {
      it(`should produce a valid graph for '${topology}' topology`, () => {
        const conversation = createMockConversation({
          settings: { agents: { topology } },
        });
        const requests = [
          createMockRequest({
            _id: "req-main",
            agentConversationId: TEST_AGENT_CONVERSATION_ID,
            createdAt: "2026-07-01T00:01:00Z",
          }),
          createMockRequest({
            _id: "req-sub",
            agentConversationId: "sub-1",
            parentAgentConversationId: TEST_AGENT_CONVERSATION_ID,
            agent: "WORKER",
            createdAt: "2026-07-01T00:02:00Z",
          }),
        ];

        const graph = buildConversationGraph(conversation, null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

        expect(graph.nodes.length).toBeGreaterThan(0);
        expect(graph.edges.length).toBeGreaterThan(0);

        for (const node of graph.nodes) {
          expect(Number.isFinite(node.x)).toBe(true);
          expect(Number.isFinite(node.y)).toBe(true);
        }
      });
    }
  });

  describe("Edge cases", () => {
    it("should produce a valid graph with zero requests", () => {
      const graph = buildConversationGraph(createMockConversation(), null, [], CANVAS_WIDTH, CANVAS_HEIGHT);

      expect(graph.nodes.length).toBeGreaterThanOrEqual(3);
      expect(graph.edges.length).toBeGreaterThanOrEqual(2);
      expect(findNodesByCategory(graph, "request")).toHaveLength(0);
    });

    it("should handle a conversation with no project", () => {
      const conversation = createMockConversation({ project: undefined });
      const graph = buildConversationGraph(conversation, null, [], CANVAS_WIDTH, CANVAS_HEIGHT);

      const projectNodes = findNodesByCategory(graph, "project");
      expect(projectNodes).toHaveLength(0);
    });

    it("should handle a conversation with no agent", () => {
      const conversation = createMockConversation({ agent: undefined });
      const graph = buildConversationGraph(conversation, null, [], CANVAS_WIDTH, CANVAS_HEIGHT);

      const agentNodes = findNodesByCategory(graph, "agent");
      expect(agentNodes).toHaveLength(1);
      expect(agentNodes[0].label).toBe("Default Agent");
    });

    it("should handle a conversation with no messages", () => {
      const conversation = createMockConversation({ messages: [] });
      const requests = [
        createMockRequest({ _id: "req-1", agentConversationId: "turn-1", createdAt: "2026-07-01T00:01:00Z" }),
      ];
      const graph = buildConversationGraph(conversation, null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Should still produce a graph without crashing
      expect(graph.nodes.length).toBeGreaterThan(0);
    });

    it("should handle requests with missing timestamps gracefully", () => {
      const requests = [
        createMockRequest({ _id: "req-no-time", createdAt: undefined, timestamp: undefined }),
        createMockRequest({ _id: "req-with-time", createdAt: "2026-07-01T00:01:00Z" }),
      ];

      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const requestNodes = findNodesByCategory(graph, "request");
      expect(requestNodes).toHaveLength(2);
    });

    it("should handle requests with no agentConversationId", () => {
      const requests = [
        createMockRequest({ _id: "req-orphan", agentConversationId: undefined, createdAt: "2026-07-01T00:01:00Z" }),
      ];

      const graph = buildConversationGraph(createMockConversation(), null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      const requestNodes = findNodesByCategory(graph, "request");
      expect(requestNodes).toHaveLength(1);
    });

    it("should embed conversation stats in the session node metadata", () => {
      const conversationStats = {
        totalCost: 0.42,
        requestCount: 10,
        totalTokens: 5000,
        totalElapsedTime: 120,
      };
      const graph = buildConversationGraph(createMockConversation(), conversationStats, [], CANVAS_WIDTH, CANVAS_HEIGHT);

      const sessionNode = findNodesByCategory(graph, "session")[0];
      expect(sessionNode.metadata?.totalCost).toBe(0.42);
      expect(sessionNode.metadata?.requestCount).toBe(10);
      expect(sessionNode.metadata?.totalTokens).toBe(5000);
      expect(sessionNode.metadata?.totalElapsedTime).toBe(120);
    });
  });

  describe("Parity: incremental vs full-load produces identical structure", () => {
    it("should produce the same node set regardless of request order", () => {
      const requests = [
        createMockRequest({ _id: "req-1", createdAt: "2026-07-01T00:01:00Z", operation: "chat" }),
        createMockRequest({ _id: "req-2", createdAt: "2026-07-01T00:02:00Z", operation: "tool_use" }),
        createMockRequest({ _id: "req-3", createdAt: "2026-07-01T00:03:00Z", operation: "chat" }),
      ];

      const conversation = createMockConversation();

      // Full load (all requests at once)
      const fullGraph = buildConversationGraph(conversation, null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Shuffled order (simulates incremental arrival)
      const shuffledRequests = [requests[2], requests[0], requests[1]];
      const shuffledGraph = buildConversationGraph(conversation, null, shuffledRequests, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Same node IDs (graph assembly sorts by timestamp internally)
      const fullNodeIds = new Set(getNodeIds(fullGraph));
      const shuffledNodeIds = new Set(getNodeIds(shuffledGraph));
      expect(shuffledNodeIds).toEqual(fullNodeIds);
    });

    it("should produce the same edge set regardless of request order", () => {
      const requests = [
        createMockRequest({ _id: "req-1", createdAt: "2026-07-01T00:01:00Z" }),
        createMockRequest({ _id: "req-2", createdAt: "2026-07-01T00:02:00Z" }),
        createMockRequest({ _id: "req-3", createdAt: "2026-07-01T00:03:00Z" }),
      ];

      const conversation = createMockConversation();

      const fullGraph = buildConversationGraph(conversation, null, requests, CANVAS_WIDTH, CANVAS_HEIGHT);
      const shuffledGraph = buildConversationGraph(conversation, null, [requests[1], requests[2], requests[0]], CANVAS_WIDTH, CANVAS_HEIGHT);

      const fullEdgeKeys = new Set(fullGraph.edges.map((edge) => `${edge.source}→${edge.target}`));
      const shuffledEdgeKeys = new Set(shuffledGraph.edges.map((edge) => `${edge.source}→${edge.target}`));
      expect(shuffledEdgeKeys).toEqual(fullEdgeKeys);
    });
  });
});
