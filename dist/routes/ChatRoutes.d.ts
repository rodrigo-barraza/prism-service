declare const router: import("express-serve-static-core").Router;
/**
 * Handle a conversation request: text generation, image generation,
 * vision/captioning — with conversationId-based persistence.
 *
 * Used by the /chat route and any non-agent callers.
 */
export declare function handleConversation(params: any, emit: any, { signal }?: any): Promise<void>;
/**
 * Handle an agent request: always dispatches to AgenticLoopService.
 * Persistence uses agentSessionId (not conversationId).
 *
 * Used exclusively by the /agent route.
 */
export declare function handleAgent(params: any, emit: any, { signal }?: any): Promise<void>;
export default router;
//# sourceMappingURL=ChatRoutes.d.ts.map