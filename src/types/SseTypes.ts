export interface SseEvent {
  type: string;
  content?: string;
  message?: string;
  data?: string;
  mimeType?: string;
  minioRef?: string;
  tool?: {
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
  };
  status?: string;
  /** Message role for `user_message` turn-start events */
  role?: string;
  /** Emission time (epoch ms) for viewer-facing events */
  timestamp?: number;
  provider?: string;
  model?: string;
  usage?: Record<string, unknown>;
  estimatedCost?: number;
  audioRef?: string;
  traceId?: string;
  conversationId?: string;
}
