import type { GraphNode, GraphEdge, GraphData, SubAgentTreeNode } from "@rodrigo-barraza/utilities-library/graph";
import { AGENT_IDS, TOPOLOGIES, DEFAULT_TOPOLOGY, DEFAULT_USERNAME } from "@rodrigo-barraza/utilities-library/taxonomy";

/* ═══════════════════════════════════════════════════════════════════
   Types — mirrored from the frontend request shape
   ═══════════════════════════════════════════════════════════════════ */

interface GraphConversation {
  id?: string;
  _id?: string;
  title?: string;
  project?: string;
  status?: string;
  agent?: string;
  createdAt?: string;
  updatedAt?: string;
  messages?: Array<{ role?: string; content?: string | unknown[] | null }>;
  settings?: { agents?: { topology?: string }; [key: string]: unknown };
}

interface GraphConversationStats {
  totalCost?: number;
  requestCount?: number;
  totalTokens?: number;
  totalElapsedTime?: number;
}

interface GraphRequestEntry {
  _id?: string;
  agentConversationId?: string;
  parentAgentConversationId?: string;
  agent?: string;
  operation?: string;
  estimatedCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  duration?: number;
  timestamp?: string;
  createdAt?: string;
  status?: string;
  requestId?: string;
  model?: string;
  provider?: string;
  toolApiNames?: string[];
  username?: string;
}

/* ═══════════════════════════════════════════════════════════════════
   buildConversationGraph — Multi-pass graph assembly
   ═══════════════════════════════════════════════════════════════════
   Ported from ChatConversationGraphComponent.tsx. This is a pure
   data transformation: conversation + stats + requests → GraphData.
   No DOM, no React, no canvas — just nodes and edges with positions.
   ═══════════════════════════════════════════════════════════════════ */

export function buildConversationGraph(
  conversation: GraphConversation,
  conversationStats: GraphConversationStats | null,
  conversationRequests: GraphRequestEntry[],
  canvasWidth: number,
  canvasHeight: number,
): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIdSet = new Set<string>();
  const edgeKeySet = new Set<string>();

  const addNode = (
    id: string,
    label: string,
    category: GraphNode["category"],
    radius: number,
    metadata?: Record<string, unknown>,
    sequenceNumber?: number,
    depth?: number,
  ) => {
    if (nodeIdSet.has(id)) return;
    nodeIdSet.add(id);
    nodes.push({ id, label, category, radius, x: 0, y: 0, velocityX: 0, velocityY: 0, metadata, sequenceNumber, depth });
  };

  const addEdge = (source: string, target: string, strength = 1, isCurved = false) => {
    const edgeKey = `${source}→${target}`;
    if (edgeKeySet.has(edgeKey)) return;
    edgeKeySet.add(edgeKey);
    edges.push({ source, target, strength, isCurved });
  };

  const conversationId = conversation.id || conversation._id || "";
  const conversationNodeId = `session:${conversationId}`;

  addNode(conversationNodeId, conversation.title || "Conversation", "session", 24, {
    conversationId,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    totalCost: conversationStats?.totalCost,
    requestCount: conversationStats?.requestCount,
    totalTokens: conversationStats?.totalTokens,
    totalElapsedTime: conversationStats?.totalElapsedTime,
  });

  if (conversation.project) {
    const projectNodeId = `project:${conversation.project}`;
    addNode(projectNodeId, conversation.project, "project", 24, { project: conversation.project });
    addEdge(projectNodeId, conversationNodeId, 0.8);
  }

  let mainAgentConversationId = conversationId;
  for (const request of conversationRequests) {
    if (!request.parentAgentConversationId && request.agentConversationId) {
      mainAgentConversationId = request.agentConversationId;
      break;
    }
  }

  const parentAgentNodeId = conversation.agent
    ? `agent:${mainAgentConversationId}:${conversation.agent}`
    : `agent:${mainAgentConversationId}:default`;
  if (conversation.agent) {
    addNode(parentAgentNodeId, conversation.agent, "agent", 24, { agent: conversation.agent, depth: 0 }, undefined, 0);
  } else {
    addNode(parentAgentNodeId, "Default Agent", "agent", 24, { agent: "default", depth: 0 }, undefined, 0);
  }
  addEdge(conversationNodeId, parentAgentNodeId, 0.9);

  const userSet = new Set<string>();

  const sortedRequests = [...conversationRequests].sort((requestA, requestB) => {
    const getRequestTime = (request: GraphRequestEntry): number => {
      const rawTime = request.createdAt || request.timestamp;
      if (!rawTime) return 0;
      const parsed = new Date(rawTime).getTime();
      return isNaN(parsed) ? 0 : parsed;
    };
    return getRequestTime(requestA) - getRequestTime(requestB);
  });

  // Pass 1: discover sub-agent parent relationships
  const subAgentParentMap = new Map<string, string>();
  const subAgentNodeIdList: string[] = [];
  const knownSubAgentConversationIds = new Set<string>();

  for (const request of sortedRequests) {
    const requestAgentConversationId = request.agentConversationId || mainAgentConversationId;
    const isSubAgent = !!request.parentAgentConversationId;

    if (isSubAgent) {
      knownSubAgentConversationIds.add(requestAgentConversationId);
      if (!subAgentParentMap.has(requestAgentConversationId)) {
        subAgentParentMap.set(requestAgentConversationId, request.parentAgentConversationId!);
      }
    }
  }

  // Collect main agent conversation IDs (multi-turn)
  const mainAgentConversationIds = new Set<string>([mainAgentConversationId]);
  for (const request of conversationRequests) {
    if (request.agentConversationId && !knownSubAgentConversationIds.has(request.agentConversationId)) {
      mainAgentConversationIds.add(request.agentConversationId);
    }
  }

  // Normalize parent references and build node ID mapping
  const agentConversationIdToNodeId = new Map<string, string>();
  for (const mainId of mainAgentConversationIds) {
    agentConversationIdToNodeId.set(mainId, parentAgentNodeId);
  }

  for (const [subAgentId, rawParentId] of subAgentParentMap) {
    const matchingRequest = sortedRequests.find(
      (request) => request.agentConversationId === subAgentId && request.parentAgentConversationId,
    );
    const currentAgentNodeId = `agent:${subAgentId}:${matchingRequest?.agent || AGENT_IDS.OMNI}`;
    agentConversationIdToNodeId.set(subAgentId, currentAgentNodeId);
    const normalizedParentId = mainAgentConversationIds.has(rawParentId) ? mainAgentConversationId : rawParentId;
    subAgentParentMap.set(subAgentId, normalizedParentId);
    subAgentNodeIdList.push(currentAgentNodeId);
  }

  // Compute sub-agent depths
  const subAgentDepthMap = new Map<string, number>();
  const computeDepth = (agentConversationId: string): number => {
    if (mainAgentConversationIds.has(agentConversationId)) return 0;
    if (subAgentDepthMap.has(agentConversationId)) return subAgentDepthMap.get(agentConversationId)!;
    const parentConversationId = subAgentParentMap.get(agentConversationId) || mainAgentConversationId;
    const depth = computeDepth(parentConversationId) + 1;
    subAgentDepthMap.set(agentConversationId, depth);
    return depth;
  };

  for (const agentConversationId of subAgentParentMap.keys()) {
    computeDepth(agentConversationId);
  }

  // Pass 2: create nodes and edges for all requests
  const lastRequestNodeIdPerAgentContext = new Map<string, string>();

  const userMessages = conversation.messages
    ?.filter((message) => message.role === "user")
    .map((message) => {
      const messageText = (typeof message.content === "string" ? message.content : "").trim();
      return messageText.length > 30 ? `${messageText.slice(0, 28)}…` : messageText || "user message";
    }) ?? [];

  let currentMainAgentConversationId: string | null = null;
  let mainAgentTurnIndex = 0;

  for (let requestIndex = 0; requestIndex < sortedRequests.length; requestIndex++) {
    const request = sortedRequests[requestIndex];
    const sequenceNumber = requestIndex + 1;
    const operationLabel = request.operation || "unknown";
    const requestNodeId = `request:${request._id || requestIndex}`;
    const requestAgentConversationId = request.agentConversationId || mainAgentConversationId;
    const isSubAgent = knownSubAgentConversationIds.has(requestAgentConversationId);
    const agentDepth = isSubAgent ? (subAgentDepthMap.get(requestAgentConversationId) || 1) : 0;

    // Insert turn boundary node when main agent's agentConversationId changes
    if (!isSubAgent && requestAgentConversationId !== currentMainAgentConversationId) {
      currentMainAgentConversationId = requestAgentConversationId;

      const turnNodeId = `turn:${mainAgentTurnIndex}`;
      const turnLabel = userMessages[mainAgentTurnIndex] || `Turn ${mainAgentTurnIndex + 1}`;
      addNode(turnNodeId, turnLabel, "turn", 24, {
        turnIndex: mainAgentTurnIndex,
        agentConversationId: requestAgentConversationId,
      });

      const previousRequestNodeId = lastRequestNodeIdPerAgentContext.get("__main_agent__");
      if (previousRequestNodeId) {
        addEdge(previousRequestNodeId, turnNodeId, 0.5);
      } else {
        addEdge(parentAgentNodeId, turnNodeId, 0.6);
      }

      lastRequestNodeIdPerAgentContext.set("__main_agent__", turnNodeId);
      mainAgentTurnIndex++;
    }

    const uniqueToolNames = request.toolApiNames
      ? [...new Set(request.toolApiNames)]
      : [];

    addNode(requestNodeId, `#${sequenceNumber} ${operationLabel}`, "request", 24, {
      operation: operationLabel,
      estimatedCost: request.estimatedCost,
      inputTokens: request.inputTokens,
      outputTokens: request.outputTokens,
      duration: request.duration,
      timestamp: request.timestamp,
      status: request.status,
      requestId: request.requestId || request._id,
      model: request.model || null,
      provider: request.provider || null,
      agentDepth,
      toolNames: uniqueToolNames,
    }, sequenceNumber);

    const currentAgentNodeId = isSubAgent
      ? `agent:${requestAgentConversationId}:${request.agent || AGENT_IDS.OMNI}`
      : parentAgentNodeId;

    if (isSubAgent) {
      const subAgentLabel = request.agent || AGENT_IDS.OMNI;
      const subAgentDepth = subAgentDepthMap.get(requestAgentConversationId) || 1;
      addNode(currentAgentNodeId, subAgentLabel, "subagent", 24, {
        agent: subAgentLabel,
        isSubagent: true,
        parentAgentConversationId: request.parentAgentConversationId || mainAgentConversationId,
        agentConversationId: requestAgentConversationId,
        depth: subAgentDepth,
      }, undefined, subAgentDepth);
    }

    const agentContextKey = isSubAgent ? requestAgentConversationId : "__main_agent__";
    const previousRequestNodeId = lastRequestNodeIdPerAgentContext.get(agentContextKey);

    if (!previousRequestNodeId) {
      addEdge(currentAgentNodeId, requestNodeId, 0.6);
    } else {
      addEdge(previousRequestNodeId, requestNodeId, 0.5);
    }
    lastRequestNodeIdPerAgentContext.set(agentContextKey, requestNodeId);

    if (request.username && request.username !== DEFAULT_USERNAME && request.username !== "system") {
      userSet.add(request.username);
    }
  }

  for (const userName of userSet) {
    const userNodeId = `user:${userName}`;
    addNode(userNodeId, userName, "user", 24, { username: userName });
    addEdge(userNodeId, conversationNodeId, 0.5);
  }

  // Build sub-agent tree
  const buildSubAgentTree = (parentConversationId: string, visitedIds: Set<string>): SubAgentTreeNode[] => {
    const children: SubAgentTreeNode[] = [];
    for (const [childConversationId, childParentId] of subAgentParentMap.entries()) {
      if (childParentId === parentConversationId && !visitedIds.has(childConversationId)) {
        const childNodeId = agentConversationIdToNodeId.get(childConversationId);
        if (childNodeId) {
          const nextVisited = new Set(visitedIds);
          nextVisited.add(childConversationId);
          children.push({
            nodeId: childNodeId,
            agentConversationId: childConversationId,
            children: buildSubAgentTree(childConversationId, nextVisited),
          });
        }
      }
    }
    return children;
  };

  const subAgentTree = buildSubAgentTree(mainAgentConversationId, new Set([mainAgentConversationId]));

  // Create topology-aware edges
  const topology = conversation.settings?.agents?.topology || DEFAULT_TOPOLOGY;

  const createTreeEdges = (treeNodes: SubAgentTreeNode[], parentAgentConversationId: string) => {
    for (const treeNode of treeNodes) {
      const isParentMainAgent = mainAgentConversationIds.has(parentAgentConversationId);
      const parentAgentRequests = sortedRequests.filter((sortedRequest) => {
        const sortedRequestConvId = sortedRequest.agentConversationId || mainAgentConversationId;
        const sortedRequestIsSubAgent = knownSubAgentConversationIds.has(sortedRequestConvId);
        if (sortedRequestIsSubAgent) {
          return sortedRequestConvId === parentAgentConversationId;
        }
        return !sortedRequestIsSubAgent && isParentMainAgent;
      });

      let linkedToTool = false;
      for (const parentRequest of parentAgentRequests) {
        if (parentRequest.toolApiNames?.includes("create_subagents") || parentRequest.toolApiNames?.includes("create_subagent")) {
          const requestNodeId = `request:${parentRequest._id || sortedRequests.indexOf(parentRequest)}`;
          if (nodeIdSet.has(requestNodeId)) {
            addEdge(requestNodeId, treeNode.nodeId, 0.9, false);
            linkedToTool = true;
            break;
          }
        }
      }

      if (!linkedToTool) {
        const parentNodeId = agentConversationIdToNodeId.get(parentAgentConversationId) || parentAgentNodeId;
        addEdge(parentNodeId, treeNode.nodeId, 0.9, false);
      }

      if (treeNode.children.length > 0) {
        createTreeEdges(treeNode.children, treeNode.agentConversationId);
      }
    }
  };

  if (subAgentTree.length > 0) {
    if (topology === TOPOLOGIES.SEQUENTIAL) {
      const flattenedNodes = flattenSubAgentTree(subAgentTree);
      if (flattenedNodes.length > 0) {
        addEdge(parentAgentNodeId, flattenedNodes[0], 0.9, false);
        for (let index = 1; index < flattenedNodes.length; index++) {
          addEdge(flattenedNodes[index - 1], flattenedNodes[index], 0.9, false);
        }
      }
    } else if (topology === TOPOLOGIES.PEER_TO_PEER) {
      createTreeEdges(subAgentTree, mainAgentConversationId);
      for (let index = 0; index < subAgentTree.length; index++) {
        for (let nextIndex = index + 1; nextIndex < subAgentTree.length; nextIndex++) {
          addEdge(subAgentTree[index].nodeId, subAgentTree[nextIndex].nodeId, 0.4);
        }
      }
    } else if (topology === TOPOLOGIES.CRITIC_LOOP) {
      const flattenedNodes = flattenSubAgentTree(subAgentTree);
      if (flattenedNodes.length > 0) {
        addEdge(parentAgentNodeId, flattenedNodes[0], 0.9, false);
        for (let index = 1; index < flattenedNodes.length; index++) {
          addEdge(flattenedNodes[index - 1], flattenedNodes[index], 0.8, false);
        }
        if (flattenedNodes.length > 1) {
          addEdge(flattenedNodes[flattenedNodes.length - 1], flattenedNodes[0], 0.5, false);
        }
      }
    } else if (topology === TOPOLOGIES.HIERARCHICAL_AGGREGATION) {
      createTreeEdges(subAgentTree, mainAgentConversationId);
      for (let index = 0; index < subAgentTree.length; index++) {
        for (let nextIndex = index + 1; nextIndex < subAgentTree.length; nextIndex++) {
          addEdge(subAgentTree[index].nodeId, subAgentTree[nextIndex].nodeId, 0.4);
        }
      }
    } else {
      createTreeEdges(subAgentTree, mainAgentConversationId);
    }
  }

  const graphData: GraphData = { nodes, edges, subAgentTree };

  // Apply topology layout
  applyTopologyLayout(graphData, canvasWidth, canvasHeight, topology);

  return graphData;
}

/* ═══════════════════════════════════════════════════════════════════
   Layout algorithms
   ═══════════════════════════════════════════════════════════════════ */

function flattenSubAgentTree(treeNodes: SubAgentTreeNode[]): string[] {
  const result: string[] = [];
  for (const treeNode of treeNodes) {
    result.push(treeNode.nodeId);
    result.push(...flattenSubAgentTree(treeNode.children));
  }
  return result;
}

function computeNodeTier(node: GraphNode): number {
  switch (node.category) {
    case "project":
    case "user":
      return 0;
    case "session":
      return 1;
    case "agent":
      return 2;
    case "subagent": {
      const subagentDepth = node.depth ?? 1;
      return 2 + subagentDepth * 3;
    }
    case "turn":
      return 3;
    case "request": {
      const requestAgentDepth = (node.metadata?.agentDepth as number) ?? 0;
      return 3 + requestAgentDepth * 3;
    }
    case "tool": {
      const toolAgentDepth = (node.metadata?.agentDepth as number) ?? 0;
      return 4 + toolAgentDepth * 3;
    }
    default:
      return 3;
  }
}

function applyHierarchicalLayout(graphData: GraphData, canvasWidth: number, canvasHeight: number): void {
  const { nodes: graphNodes, edges: graphEdges } = graphData;
  if (graphNodes.length === 0) return;

  const tierBuckets: Map<number, GraphNode[]> = new Map();
  for (const node of graphNodes) {
    const tier = computeNodeTier(node);
    if (!tierBuckets.has(tier)) tierBuckets.set(tier, []);
    tierBuckets.get(tier)!.push(node);
  }

  // Topologically sort nodes within each tier (Kahn's algorithm)
  const nodeIdSet = new Set(graphNodes.map((node) => node.id));
  for (const [, tierNodes] of tierBuckets) {
    if (tierNodes.length <= 1) continue;

    const tierNodeIds = new Set(tierNodes.map((tierNode) => tierNode.id));
    const inDegree = new Map<string, number>();
    const outEdges = new Map<string, string[]>();
    for (const tierNode of tierNodes) {
      inDegree.set(tierNode.id, 0);
      outEdges.set(tierNode.id, []);
    }

    for (const edge of graphEdges) {
      if (tierNodeIds.has(edge.source) && tierNodeIds.has(edge.target)) {
        outEdges.get(edge.source)!.push(edge.target);
        inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
      }
    }

    // Kahn's algorithm (stable topological sort)
    const sortedNodes: GraphNode[] = [];
    const queue: string[] = [];
    const nodeMap = new Map(tierNodes.map((tierNode) => [tierNode.id, tierNode]));

    for (const tierNode of tierNodes) {
      if ((inDegree.get(tierNode.id) ?? 0) === 0) queue.push(tierNode.id);
    }

    while (queue.length > 0) {
      const currentNodeId = queue.shift()!;
      sortedNodes.push(nodeMap.get(currentNodeId)!);
      for (const neighborId of (outEdges.get(currentNodeId) ?? [])) {
        const newDegree = (inDegree.get(neighborId) ?? 1) - 1;
        inDegree.set(neighborId, newDegree);
        if (newDegree === 0) queue.push(neighborId);
      }
    }

    for (const tierNode of tierNodes) {
      if (!sortedNodes.includes(tierNode)) sortedNodes.push(tierNode);
    }

    tierNodes.length = 0;
    tierNodes.push(...sortedNodes);
  }

  const populatedTierIndices = [...tierBuckets.keys()].sort((tierA, tierB) => tierA - tierB);
  const totalColumns = populatedTierIndices.length;
  const horizontalSpacing = Math.max(160, (canvasWidth - 100) / Math.max(totalColumns, 1));
  const startX = 80;
  const centerY = canvasHeight / 2;

  for (let columnIndex = 0; columnIndex < populatedTierIndices.length; columnIndex++) {
    const tierNodes = tierBuckets.get(populatedTierIndices[columnIndex])!;
    const tierX = startX + columnIndex * horizontalSpacing;
    const largestTierRadius = Math.max(...tierNodes.map((tierNode) => tierNode.radius));
    const minimumNodeSpacing = largestTierRadius * 2 + 15;
    const proportionalSpacing = tierNodes.length > 1
      ? (canvasHeight * 0.9) / (tierNodes.length - 1)
      : canvasHeight * 0.9;
    const verticalSpacing = Math.max(minimumNodeSpacing, Math.min(80, proportionalSpacing));
    const totalTierHeight = (tierNodes.length - 1) * verticalSpacing;
    const tierStartY = centerY - totalTierHeight / 2;
    for (let nodeIndex = 0; nodeIndex < tierNodes.length; nodeIndex++) {
      tierNodes[nodeIndex].x = tierX;
      tierNodes[nodeIndex].y = tierStartY + nodeIndex * verticalSpacing;
    }
  }
}

function applyParentBasedLayout(
  graphData: GraphData,
  canvasWidth: number,
  canvasHeight: number,
  mainAgentPosition: { x: number; y: number },
  requestPositioner: (parentNode: GraphNode, node: GraphNode, centerX: number, centerY: number) => { x: number; y: number },
): void {
  const { nodes: graphNodes } = graphData;
  if (graphNodes.length === 0) return;

  const projectNode = graphNodes.find((graphNode) => graphNode.category === "project");
  const userNode = graphNodes.find((graphNode) => graphNode.category === "user");
  const sessionNode = graphNodes.find((graphNode) => graphNode.category === "session");
  const mainAgentNode = graphNodes.find((graphNode) => graphNode.category === "agent");

  const otherNodes = graphNodes.filter((graphNode) =>
    graphNode.category !== "project" &&
    graphNode.category !== "user" &&
    graphNode.category !== "session" &&
    graphNode.category !== "agent" &&
    graphNode.category !== "subagent" &&
    ((graphNode.metadata?.agentDepth as number) ?? 0) === 0
  );

  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;

  if (projectNode) { projectNode.x = 80; projectNode.y = 80; }
  if (userNode) { userNode.x = 180; userNode.y = 80; }
  if (sessionNode) { sessionNode.x = 130; sessionNode.y = 150; }

  if (mainAgentNode) {
    mainAgentNode.x = mainAgentPosition.x === -1 ? centerX : mainAgentPosition.x;
    mainAgentNode.y = mainAgentPosition.y === -1 ? centerY : mainAgentPosition.y;
  }

  const toolCounterByParent = new Map<string, number>();

  for (const node of otherNodes) {
    const edge = graphData.edges.find((edgeCandidate) => edgeCandidate.target === node.id);
    const parentNode = edge ? graphNodes.find((parentNodeCandidate) => parentNodeCandidate.id === edge.source) : null;

    if (parentNode) {
      if (node.category === "request") {
        const position = requestPositioner(parentNode, node, centerX, centerY);
        node.x = position.x;
        node.y = position.y;
      } else if (node.category === "tool") {
        const toolIndex = toolCounterByParent.get(parentNode.id) || 0;
        toolCounterByParent.set(parentNode.id, toolIndex + 1);
        node.x = parentNode.x - 80 - toolIndex * 25;
        node.y = parentNode.y + (toolIndex % 3) * 30;
      } else {
        node.x = parentNode.x;
        node.y = parentNode.y + 80;
      }
    } else {
      node.x = canvasWidth / 2;
      node.y = centerY + 100;
    }
  }
}

function applySequentialLayout(graphData: GraphData, canvasWidth: number, canvasHeight: number): void {
  applyParentBasedLayout(graphData, canvasWidth, canvasHeight, { x: 130, y: -1 },
    (parentNode, node) => ({
      x: parentNode.x,
      y: parentNode.y + 70 + (node.sequenceNumber || 1) * 30,
    }),
  );
}

function applyPeerToPeerLayout(graphData: GraphData, canvasWidth: number, canvasHeight: number): void {
  applyParentBasedLayout(graphData, canvasWidth, canvasHeight, { x: -1, y: -1 },
    (parentNode, _node, centerX, centerY) => {
      const deltaX = parentNode.x - centerX;
      const deltaY = parentNode.y - centerY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY) || 1;
      return {
        x: parentNode.x + (deltaX / distance) * 50,
        y: parentNode.y + (deltaY / distance) * 50,
      };
    },
  );
}

function applyCriticLoopLayout(graphData: GraphData, canvasWidth: number, canvasHeight: number): void {
  applyParentBasedLayout(graphData, canvasWidth, canvasHeight, { x: -1, y: 220 },
    (parentNode, node) => ({
      x: parentNode.x + 120,
      y: parentNode.y + (node.sequenceNumber || 1) * 28,
    }),
  );
}

function applyTournamentLayout(graphData: GraphData, canvasWidth: number, canvasHeight: number): void {
  applyParentBasedLayout(graphData, canvasWidth, canvasHeight, { x: -1, y: 220 },
    (parentNode, node) => ({
      x: parentNode.x,
      y: parentNode.y + 70 + (node.sequenceNumber || 1) * 28,
    }),
  );
}

function applyMCTSLayout(graphData: GraphData, canvasWidth: number, canvasHeight: number): void {
  applyParentBasedLayout(graphData, canvasWidth, canvasHeight, { x: -1, y: 220 },
    (parentNode, node) => ({
      x: parentNode.x + 80,
      y: parentNode.y + (node.sequenceNumber || 1) * 28,
    }),
  );
}

function applyTopologyLayout(
  graphData: GraphData,
  canvasWidth: number,
  canvasHeight: number,
  topology: string,
): void {
  const resolvedTopology = topology || DEFAULT_TOPOLOGY;
  if (resolvedTopology === TOPOLOGIES.SEQUENTIAL) {
    applySequentialLayout(graphData, canvasWidth, canvasHeight);
  } else if (resolvedTopology === TOPOLOGIES.PEER_TO_PEER) {
    applyPeerToPeerLayout(graphData, canvasWidth, canvasHeight);
  } else if (resolvedTopology === TOPOLOGIES.CRITIC_LOOP) {
    applyCriticLoopLayout(graphData, canvasWidth, canvasHeight);
  } else if (resolvedTopology === TOPOLOGIES.TOURNAMENT || resolvedTopology === TOPOLOGIES.DIVIDE_AND_CONQUER) {
    applyTournamentLayout(graphData, canvasWidth, canvasHeight);
  } else if (resolvedTopology === TOPOLOGIES.MCTS) {
    applyMCTSLayout(graphData, canvasWidth, canvasHeight);
  } else {
    applyHierarchicalLayout(graphData, canvasWidth, canvasHeight);
  }

  // Position sub-agent branches after base layout
  if (graphData.subAgentTree && graphData.subAgentTree.length > 0) {
    positionSubAgentBranches(graphData);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   Sub-agent branch positioning
   ═══════════════════════════════════════════════════════════════════ */

const REQUEST_SPACING = 60;
const BRANCH_GAP = REQUEST_SPACING * 2;
const MINIMUM_BRANCH_HEIGHT = REQUEST_SPACING * 2;
const COLUMN_SPACING = 200;

function positionSubAgentBranches(graphData: GraphData): void {
  const nodeMap = new Map(graphData.nodes.map((node) => [node.id, node]));
  const mainAgentNode = graphData.nodes.find((graphNode) => graphNode.category === "agent");
  if (!mainAgentNode) return;

  const rootRequestNodes = graphData.nodes.filter(
    (graphNode) => graphNode.category === "request" && ((graphNode.metadata?.agentDepth as number) ?? 0) === 0,
  );
  const rightmostRootRequestX = rootRequestNodes.length > 0
    ? Math.max(...rootRequestNodes.map((requestNode) => requestNode.x))
    : mainAgentNode.x + COLUMN_SPACING;

  const collectBranchNodes = (
    treeChild: SubAgentTreeNode,
    childNode: GraphNode,
    depth: number,
  ): GraphNode[] => {
    const requestNodes: GraphNode[] = [];
    const depthMatchedRequests = new Set(
      graphData.nodes
        .filter((graphNode) =>
          graphNode.category === "request" &&
          ((graphNode.metadata?.agentDepth as number) ?? 0) === depth,
        )
        .map((graphNode) => graphNode.id),
    );

    const firstRequestEdge = graphData.edges.find(
      (edge) => edge.source === childNode.id && depthMatchedRequests.has(edge.target),
    );
    if (firstRequestEdge) {
      const firstRequestNode = graphData.nodes.find((node) => node.id === firstRequestEdge.target);
      if (firstRequestNode) {
        requestNodes.push(firstRequestNode);
        let currentRequestId = firstRequestNode.id;
        while (true) {
          const nextChainEdge = graphData.edges.find(
            (edge) => edge.source === currentRequestId && depthMatchedRequests.has(edge.target),
          );
          if (!nextChainEdge) break;
          const nextRequestNode = graphData.nodes.find((node) => node.id === nextChainEdge.target);
          if (!nextRequestNode) break;
          requestNodes.push(nextRequestNode);
          currentRequestId = nextRequestNode.id;
        }
      }
    }

    return requestNodes;
  };

  const measureBranchHeight = (
    treeChild: SubAgentTreeNode,
    depth: number,
  ): number => {
    const childNode = nodeMap.get(treeChild.nodeId);
    if (!childNode) return MINIMUM_BRANCH_HEIGHT;

    const requestNodes = collectBranchNodes(treeChild, childNode, depth);
    const requestColumnHeight = requestNodes.length > 0
      ? (requestNodes.length - 1) * REQUEST_SPACING
      : 0;

    const ownContentHeight = Math.max(requestColumnHeight, MINIMUM_BRANCH_HEIGHT);

    if (treeChild.children.length > 0) {
      let nestedTotalHeight = 0;
      for (let nestedIndex = 0; nestedIndex < treeChild.children.length; nestedIndex++) {
        nestedTotalHeight += measureBranchHeight(treeChild.children[nestedIndex], depth + 1);
        if (nestedIndex < treeChild.children.length - 1) {
          nestedTotalHeight += BRANCH_GAP;
        }
      }
      return Math.max(ownContentHeight, nestedTotalHeight);
    }

    return ownContentHeight;
  };

  const positionBranch = (
    treeNodes: SubAgentTreeNode[],
    parentColumnX: number,
    parentY: number,
    depth: number,
  ) => {
    if (treeNodes.length === 0) return;

    const branchHeights = treeNodes.map((treeChild) => measureBranchHeight(treeChild, depth));
    const totalBranchesHeight = branchHeights.reduce((sum, height) => sum + height, 0)
      + (treeNodes.length - 1) * BRANCH_GAP;
    let currentY = parentY - totalBranchesHeight / 2;

    for (let childIndex = 0; childIndex < treeNodes.length; childIndex++) {
      const treeChild = treeNodes[childIndex];
      const childNode = nodeMap.get(treeChild.nodeId);
      if (!childNode) continue;

      const branchHeight = branchHeights[childIndex];
      const subAgentX = parentColumnX + COLUMN_SPACING;
      childNode.x = subAgentX;
      childNode.y = currentY + branchHeight / 2;

      const subAgentRequestX = subAgentX + COLUMN_SPACING;
      const subAgentRequestNodes = collectBranchNodes(treeChild, childNode, depth);

      const requestStartY = childNode.y - ((subAgentRequestNodes.length - 1) * REQUEST_SPACING) / 2;
      for (let requestIndex = 0; requestIndex < subAgentRequestNodes.length; requestIndex++) {
        subAgentRequestNodes[requestIndex].x = subAgentRequestX;
        subAgentRequestNodes[requestIndex].y = requestStartY + requestIndex * REQUEST_SPACING;
      }

      if (treeChild.children.length > 0) {
        positionBranch(treeChild.children, subAgentRequestX, childNode.y, depth + 1);
      }

      currentY += branchHeight + BRANCH_GAP;
    }
  };

  positionBranch(graphData.subAgentTree, rightmostRootRequestX, mainAgentNode.y, 1);
}
