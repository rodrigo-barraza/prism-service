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
  /**
   * Per-conversation monotonic sequence number, stamped by
   * withDirectViewerBroadcast / LiveTurnBuffer. Never resets between turns,
   * so a viewer's cursor (`afterSeq` on subscribe) from a previous turn still
   * sorts below every event of the next one. Events that already carry one
   * (re-broadcasts) keep it.
   */
  seq?: number;
}
