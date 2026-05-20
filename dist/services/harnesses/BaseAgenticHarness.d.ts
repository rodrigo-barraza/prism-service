import type AgenticLoopState from "../AgenticLoopState.ts";
import type AgentHooks from "../AgentHooks.ts";
import type { AgenticContext, ResolvedTools, PassState, ChunkAction, ConversationMessage } from "./types.ts";
/**
 * BaseAgenticHarness — abstract base class that defines the contract
 * for agentic loop execution strategies ("harnesses").
 *
 * Subclasses implement `run()` with their specific control flow
 * (standard tool loop, ReAct, plan-then-execute, etc.) while
 * inheriting shared infrastructure:
 *
 *   - Stream chunk routing (`processStreamChunk`)
 *   - Stream consumption (`consumeStream` — full pass with chunk routing)
 *   - Progress emission (`emitGenerationProgress`, `maybeEmitProgress`)
 *   - Iteration logging (`logIteration`)
 *   - Context window enforcement (`enforceContextWindow`)
 *   - LLM stream creation (`createProviderStream`)
 *   - Finalization (`finalize` — cost, persistence, done event)
 */
export default class BaseAgenticHarness {
    /** Harness identifier — subclasses MUST override. */
    static id: string;
    static label: string;
    static description: string;
    protected ctx: AgenticContext;
    protected state: AgenticLoopState;
    protected tools: ResolvedTools;
    protected trackerSessionId: string;
    constructor(context: AgenticContext, state: AgenticLoopState, tools: ResolvedTools);
    /** Execute the agentic loop. Subclasses MUST override. */
    run(): Promise<{
        messages: ConversationMessage[];
    }>;
    /** Emit a generation_progress status event with current session stats. */
    emitGenerationProgress(): void;
    /** Check if it's time to emit a progress event. */
    maybeEmitProgress(): void;
    /** Enforce token budget on messages before sending to provider. */
    enforceContextWindow(messages: ConversationMessage[], toolCount: number): ConversationMessage[];
    /**
     * Create an LLM text stream from the provider.
     * Handles liveAPI fallback and message expansion.
     */
    createProviderStream(messages: ConversationMessage[], passOptions: Record<string, unknown>): AsyncIterable<unknown>;
    /**
     * Consume an LLM stream, routing each chunk through `processStreamChunk`.
     * Handles abort signals and stream teardown.
     */
    consumeStream(stream: AsyncIterable<unknown>, pass: PassState, allowedToolNames: Set<string>): Promise<void>;
    /** Register a request with SessionGenerationTracker. */
    registerTrackerRequest(passRequestId: string): void;
    /**
     * Process a single stream chunk — routes to the appropriate handler.
     * Returns an action descriptor for the caller:
     *   `continue` — chunk was consumed, keep iterating
     *   `toolCall` — a tool call was detected
     *   `skip`     — chunk was filtered/dropped
     *   `break`    — abort signal received
     */
    processStreamChunk(chunk: unknown, pass: PassState, allowedToolNames: Set<string>): ChunkAction | Promise<ChunkAction>;
    /** Log a single iteration to the request log. */
    logIteration(pass: PassState, currentMessages: ConversationMessage[]): void;
    /** Create a fresh per-iteration pass state object. */
    createPassState(passOptions: Record<string, unknown>): PassState;
    /**
     * Shared finalization logic — cost calculation, persistence,
     * done event, worker snapshot persistence, and afterResponse hooks.
     *
     * Lifted from ReActHarness so all harnesses share the same
     * finalization path without copy-paste.
     */
    protected finalize(currentMessages: ConversationMessage[], hooks: AgentHooks): Promise<void>;
    private _recordFirstToken;
    private _recordTiming;
    private _trackToolDisplaySegment;
    private _handleImageChunk;
}
//# sourceMappingURL=BaseAgenticHarness.d.ts.map