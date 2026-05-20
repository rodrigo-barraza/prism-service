/**
 * Set up WebSocket handlers on the HTTP server.
 * Routes:
 *   /ws/chat   — Streaming chat (text, images, code, thinking, etc.)
 *   /ws/text-to-audio  — Streaming TTS (binary audio frames)
 *   /ws/live   — Persistent Live API session (audio/text bidirectional)
 */
export declare function setupWebSocket(wss: Record<string, unknown>): void;
//# sourceMappingURL=index.d.ts.map