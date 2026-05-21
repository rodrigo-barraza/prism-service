/**
 * Workflow Type Definitions
 *
 * Shared interfaces for WorkflowAssembler graph assembly and
 * WorkflowsRoutes CRUD operations.
 */

// ── Graph Nodes ─────────────────────────────────────────────

export interface GraphNodeBase {
  id: string;
  inputTypes: string[];
  outputTypes: string[];
  position: { x: number; y: number };
}

export interface InputNode extends GraphNodeBase {
  nodeType: "input";
  modality: "text" | "conversation";
  content?: string;
  messages?: WorkflowMessage[];
  supportedModalities?: string[];
  customName?: string;
}

export interface ModelNode extends GraphNodeBase {
  modelName: string;
  provider: string;
  displayName: string;
  modelType: string;
  rawInputTypes?: string[];
  supportsSystemPrompt?: boolean;
  stepMeta?: {
    duration?: number;
    timestamp?: string;
    index?: number;
  };
}

export interface ViewerNode extends GraphNodeBase {
  nodeType: "viewer";
  modality: string | null;
  content: string | null;
  contentType: "text" | "image" | "audio" | null;
  receivedOutputs: NodeResult;
}

export type GraphNode = InputNode | ModelNode | ViewerNode;

// ── Graph Edges ─────────────────────────────────────────────

export interface GraphEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceModality: string;
  targetModality: string;
}

// ── Node Result ─────────────────────────────────────────────

export interface NodeResult {
  text?: string;
  image?: string;
  audio?: string;
}

export type NodeResultMap = Record<string, NodeResult>;

// ── Assembled Graph ─────────────────────────────────────────

export interface AssembledGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeResults: NodeResultMap;
}

// ── Workflow Step (input to assembler) ──────────────────────

export interface WorkflowStep {
  label?: string;
  model?: string;
  type?: string;
  systemPrompt?: string;
  input?: string;
  output?: string;
  outputType?: string;
  outputImageRef?: string;
  duration?: number;
  timestamp?: string;
  index?: number;
}

// ── Workflow Message ────────────────────────────────────────

export interface WorkflowMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

// ── Workflow Document (MongoDB) ─────────────────────────────

export interface WorkflowDefinition {
  name?: string;
  description?: string;
  source?: string;
  conversationIds?: string[];
  nodeCount?: number;
  edgeCount?: number;
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  nodeResults?: NodeResultMap;
  createdAt?: string;
  updatedAt?: string;
}

// ── Model Modalities (resolved from config) ────────────────

export interface ResolvedModalities {
  label?: string | null;
  inputTypes: string[];
  outputTypes: string[];
  rawInputTypes: string[];
  modelType: string;
  supportsSystemPrompt: boolean;
}
