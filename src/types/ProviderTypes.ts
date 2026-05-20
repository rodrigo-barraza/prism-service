export interface ProviderInstanceConfig {
  url: string;
  concurrency?: number;
  nickname?: string;
}

export interface InstanceEntry {
  id: string;
  type: string;
  baseUrl: string;
  concurrency: number;
  instanceNumber: number;
  nickname?: string;
  provider: unknown; // Replace with concrete Provider interface later
}

// Basic interfaces for chat structures
export interface ChatMessageContent {
  type: string;
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: string;
  content: string | ChatMessageContent[];
  name?: string;
  images?: string[];
  toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
  thinking?: string;
  thinkingSignature?: string;
}

export interface ProviderResponse {
  text?: string;
  thinking?: string;
  images?: Array<{ data: string; mimeType: string }>;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  provider?: string;
  model?: string;
  usage?: Record<string, number>;
  estimatedCost?: number;
}

export interface ProviderOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  serviceTier?: string;
  thinkingEnabled?: boolean;
  thinkingBudget?: number | string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
  webSearch?: boolean;
  webFetch?: boolean;
  codeExecution?: boolean;
  tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
  _retryAttempt?: number;
  reasoningSummary?: boolean;
  verbosity?: "low" | "medium" | "high";
  seed?: number;
  responseFormat?: string | { type: string };
  responseSchema?: Record<string, unknown>;
  frequencyPenalty?: number;
  presencePenalty?: number;
  model?: string;
  format?: string;
  instructions?: string;
  language?: string;
  prompt?: string;
  [key: string]: unknown;
}
