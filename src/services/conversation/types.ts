import type { ChatMessage } from "../../types/admin.ts";

export interface ConversationMeta {
  title?: string;
  systemPrompt?: string;
  settings?: ConversationSettings;
  traceId?: string | null;
  parentAgentSessionId?: string | null;
  workspaceRoot?: string | null;
  synthetic?: boolean;
  agent?: string | null;
}

export interface ConversationSettings {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  [key: string]: unknown;
}

export interface ConversationPatchInput {
  title?: string;
  messages?: ChatMessage[];
  systemPrompt?: string;
  settings?: ConversationSettings;
}

export interface ConversationPatchFields {
  updatedAt: string;
  title?: string;
  messages?: ChatMessage[];
  modalities?: Record<string, boolean>;
  providers?: string[];
  totalCost?: number;
  modelNames?: string[];
  systemPrompt?: string;
  settings?: ConversationSettings;
}

export interface ToolCallPayload {
  name: string;
  id?: string | null;
  args?: Record<string, unknown> | string;
  thoughtSignature?: string;
  durationMs?: number;
}

export interface MessagePayload {
  role: string;
  content?: string | unknown[] | null;
  rawContent?: string;
  images?: string[] | unknown[];
  audio?: string | unknown[];
  video?: string | unknown[];
  pdf?: string | unknown[];
  toolCalls?: ToolCallPayload[];
  thinking?: string;
  [key: string]: unknown;
}

export interface ConversationServiceInterface {
  appendMessages(
    conversationId: string,
    project: string,
    username: string,
    newMessages: Array<ChatMessage | MessagePayload>,
    conversationMeta?: ConversationMeta | null,
    options?: { collection?: string },
  ): Promise<Record<string, unknown>>;
  setGenerating(
    conversationId: string,
    project: string,
    username: string,
    generating: boolean,
    options?: { collection?: string; agent?: string },
  ): Promise<void>;
  getSessionStats(
    sessionId: string,
    project: string,
    username: string,
  ): Promise<Record<string, unknown> | null>;
}
