import { expandMessagesForFC } from "../../utils/FunctionCallingUtilities.js";
import { mergeUsage, createUsageAccumulator, calculateTextCost, } from "../../utils/CostCalculator.js";
import { calculateTokensPerSec } from "../../utils/math.js";
import { getPricing, TYPES } from "../../config.js";
import { stripToolCallMarkup } from "../../utils/StreamChunkDispatcher.js";
import ContextWindowManager from "../../utils/ContextWindowManager.js";
import SessionGenerationTracker from "../SessionGenerationTracker.js";
import RequestLogger from "../RequestLogger.js";
import FileService from "../FileService.js";
import MongoWrapper from "../../wrappers/MongoWrapper.js";
// @ts-ignore — root-level config export
import { MONGO_DB_NAME } from "../../../config.js";
import { COLLECTIONS } from "../../constants.js";
import { finalizeTextGeneration } from "./lifecycle/Finalizer.js";
import logger from "../../utils/logger.js";
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
    static id = "base";
    static label = "Base (abstract)";
    static description = "Abstract base harness — do not use directly.";
    ctx;
    state;
    tools;
    trackerSessionId;
    constructor(context, state, tools) {
        this.ctx = context;
        this.state = state;
        this.tools = tools;
        this.trackerSessionId =
            context.parentAgentSessionId || context.agentSessionId;
    }
    /** Execute the agentic loop. Subclasses MUST override. */
    async run() {
        throw new Error(`${this.constructor.name}.run() is abstract — subclasses must override.`);
    }
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  SHARED INFRASTRUCTURE — used by all harness subclasses
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // ── Progress emission ────────────────────────────────────
    /** Emit a generation_progress status event with current session stats. */
    emitGenerationProgress() {
        const { emit } = this.ctx;
        const state = this.state;
        const stats = SessionGenerationTracker.getSessionStats(
        // @ts-ignore - TODO: strict typing
        this.trackerSessionId);
        if (stats.activeRequests > 0 || stats.totalOutputTokens > 0) {
            state.hwmOutputTokens = Math.max(state.hwmOutputTokens, stats.totalOutputTokens);
            state.hwmInputTokens = Math.max(state.hwmInputTokens, stats.totalInputTokens);
            state.hwmTotalTokens = Math.max(state.hwmTotalTokens, stats.totalTokens);
            state.hwmOutputCharacters = Math.max(state.hwmOutputCharacters, state.overallOutputCharacters);
            emit({
                type: "status",
                message: "generation_progress",
                tokPerSec: stats.tokPerSec,
                activeRequests: stats.activeRequests,
                outputTokens: state.hwmOutputTokens,
                inputTokens: state.hwmInputTokens,
                totalTokens: state.hwmTotalTokens,
                outputCharacters: state.hwmOutputCharacters,
                avgTtft: stats.avgTtft,
            });
        }
        state.lastProgressEmitTime = performance.now();
        state.chunksSinceLastProgress = 0;
    }
    /** Check if it's time to emit a progress event. */
    maybeEmitProgress() {
        const state = this.state;
        state.chunksSinceLastProgress++;
        const timeSinceLast = performance.now() - state.lastProgressEmitTime;
        if (state.chunksSinceLastProgress >= state.PROGRESS_CHUNK_INTERVAL ||
            timeSinceLast >= state.PROGRESS_TIME_INTERVAL_MS) {
            this.emitGenerationProgress();
        }
    }
    // ── Context window enforcement ───────────────────────────
    /** Enforce token budget on messages before sending to provider. */
    enforceContextWindow(messages, toolCount) {
        const { modelDef, options, emit } = this.ctx;
        // @ts-ignore - TODO: strict typing
        const contextResult = ContextWindowManager.enforce(messages, {
            maxInputTokens: modelDef?.maxInputTokens || 128_000,
            maxOutputTokens: options.maxTokens || 8192,
            toolCount,
        });
        if (contextResult.truncated) {
            emit({
                type: "status",
                message: "context_truncated",
                strategy: contextResult.strategy,
                estimatedTokens: contextResult.estimatedTokens,
            });
            return contextResult.messages;
        }
        return messages;
    }
    // ── Provider stream creation ──────────────────────────────
    /**
     * Create an LLM text stream from the provider.
     * Handles liveAPI fallback and message expansion.
     */
    createProviderStream(messages, passOptions) {
        const { provider, resolvedModel, modelDef, signal } = this.ctx;
        // @ts-ignore - TODO: strict typing
        const expandedMessages = expandMessagesForFC(messages, {
            filterDeleted: false,
        });
        return modelDef?.liveAPI && provider.generateTextStreamLive
            ? provider.generateTextStreamLive(expandedMessages, resolvedModel, {
                ...passOptions,
                signal,
            })
            : provider.generateTextStream(expandedMessages, resolvedModel, {
                ...passOptions,
                signal,
            });
    }
    // ── Stream consumption ────────────────────────────────────
    /**
     * Consume an LLM stream, routing each chunk through `processStreamChunk`.
     * Handles abort signals and stream teardown.
     */
    async consumeStream(stream, pass, allowedToolNames) {
        for await (const chunk of stream) {
            const result = await this.processStreamChunk(chunk, pass, allowedToolNames);
            if (result.action === "break") {
                const returnable = stream;
                if (typeof returnable.return === "function")
                    returnable.return(undefined);
                break;
            }
        }
    }
    // ── Session tracking helpers ──────────────────────────────
    /** Register a request with SessionGenerationTracker. */
    registerTrackerRequest(passRequestId) {
        const { providerName, resolvedModel, parentAgentSessionId, agentSessionId } = this.ctx;
        // @ts-ignore - TODO: strict typing
        SessionGenerationTracker.register(this.trackerSessionId, passRequestId, {
            provider: providerName,
            model: resolvedModel,
            source: parentAgentSessionId ? "worker" : "orchestrator",
            workerId: parentAgentSessionId ? agentSessionId : null,
        });
    }
    // ── Stream chunk processing ───────────────────────────────
    /**
     * Process a single stream chunk — routes to the appropriate handler.
     * Returns an action descriptor for the caller:
     *   `continue` — chunk was consumed, keep iterating
     *   `toolCall` — a tool call was detected
     *   `skip`     — chunk was filtered/dropped
     *   `break`    — abort signal received
     */
    processStreamChunk(chunk, pass, allowedToolNames) {
        const { emit, signal } = this.ctx;
        const state = this.state;
        const c = chunk;
        // Abort check
        if (signal?.aborted)
            return { action: "break" };
        // ── Usage event ──────────────────────────────────────
        if (c?.type === "usage") {
            // @ts-ignore - TODO: strict typing
            mergeUsage(state.overallUsage, c.usage);
            // @ts-ignore - TODO: strict typing
            mergeUsage(pass.usage, c.usage);
            const reportedInput = c.usage?.inputTokens || c.usage?.promptTokens || 0;
            if (reportedInput > 0) {
                // @ts-ignore - TODO: strict typing
                SessionGenerationTracker.update(pass.requestId, {
                    inputTokens: reportedInput,
                });
            }
            return { action: "continue" };
        }
        // ── Rate limits ──────────────────────────────────────
        if (c?.type === "rateLimits") {
            state.lastRateLimits = c.rateLimits;
            return { action: "continue" };
        }
        // ── Thinking ─────────────────────────────────────────
        if (c?.type === "thinking") {
            this._recordFirstToken(pass);
            this._recordTiming(pass);
            state.streamedThinking += c.content;
            pass.streamedThinking += c.content;
            // Display segment tracking
            if (state.lastDisplaySegType !== "thinking") {
                state.displaySegments.push({
                    type: "thinking",
                    fragmentIndex: state.displayThinkingFragments.length,
                });
                state.displayThinkingFragments.push("");
                state.lastDisplaySegType = "thinking";
            }
            state.displayThinkingFragments[state.displayThinkingFragments.length - 1] += c.content;
            state.overallOutputCharacters += c.content.length;
            SessionGenerationTracker.recordChunkTiming(
            // @ts-ignore - TODO: strict typing
            pass.requestId, c.content.length);
            emit({
                type: "thinking",
                content: c.content,
                outputCharacters: state.overallOutputCharacters,
            });
            this.maybeEmitProgress();
            return { action: "continue" };
        }
        // ── Thinking signature (Anthropic) ───────────────────
        if (c?.type === "thinking_signature") {
            pass.thinkingSignature = c.signature;
            return { action: "continue" };
        }
        // ── Tool call argument delta ─────────────────────────
        if (c?.type === "toolCallDelta") {
            this._recordFirstToken(pass);
            this._recordTiming(pass);
            state.overallOutputCharacters += c.characters;
            SessionGenerationTracker.recordChunkTiming(
            // @ts-ignore - TODO: strict typing
            pass.requestId, c.characters);
            this.maybeEmitProgress();
            return { action: "continue" };
        }
        // ── Tool call ────────────────────────────────────────
        if (c?.type === "toolCall") {
            this._recordFirstToken(pass);
            this._recordTiming(pass);
            SessionGenerationTracker.recordChunkTiming(
            // @ts-ignore - TODO: strict typing
            pass.requestId, JSON.stringify(c.args || {}).length);
            this.maybeEmitProgress();
            // Native MCP tool calls: pass through directly
            if (c.native) {
                if (c.status === "calling") {
                    const tcId = c.id || `ntc-${state.streamedToolCalls.length}`;
                    state.streamedToolCalls.push({
                        id: tcId,
                        name: c.name,
                        args: c.args || {},
                    });
                    this._trackToolDisplaySegment(tcId);
                }
                else if (c.status === "done" || c.status === "error") {
                    const existing = state.streamedToolCalls.find((tc) => (c.id && tc.id === c.id) ||
                        (!c.id && tc.name === c.name));
                    if (existing) {
                        existing.result = c.result;
                        existing.status = c.status;
                        if (c.args && Object.keys(c.args).length > 0)
                            existing.args = c.args;
                    }
                }
                emit({
                    type: "toolCall",
                    id: c.id || null,
                    name: c.name,
                    args: c.args || {},
                    result: c.result || undefined,
                    status: c.status || "calling",
                });
                return { action: "continue" };
            }
            // Schema enforcement
            if (!allowedToolNames.has(c.name)) {
                logger.warn(`[AgenticLoop] Dropped tool call "${c.name}" — not in schema: [${[...allowedToolNames].join(", ")}]`);
                return { action: "skip" };
            }
            const stdTcId = c.id || `tc-${state.streamedToolCalls.length}`;
            const tc = {
                id: stdTcId,
                responsesItemId: c.responsesItemId || undefined,
                name: c.name,
                args: c.args || {},
                thoughtSignature: c.thoughtSignature || undefined,
            };
            pass.pendingToolCalls.push(tc);
            state.streamedToolCalls.push({ ...tc });
            this._trackToolDisplaySegment(stdTcId);
            emit({
                type: "tool_execution",
                tool: { name: c.name, args: c.args || {}, id: stdTcId },
                status: "calling",
            });
            return { action: "toolCall", tc };
        }
        // ── Image ────────────────────────────────────────────
        if (c?.type === "image") {
            return this._handleImageChunk(c, pass);
        }
        // ── Pass-through events ──────────────────────────────
        if (c?.type === "executableCode") {
            emit({
                type: "executableCode",
                code: c.code,
                language: c.language,
            });
            return { action: "continue" };
        }
        if (c?.type === "codeExecutionResult") {
            emit({
                type: "codeExecutionResult",
                output: c.output,
                outcome: c.outcome,
            });
            return { action: "continue" };
        }
        if (c?.type === "webSearchResult") {
            emit({ type: "webSearchResult", results: c.results });
            return { action: "continue" };
        }
        if (c?.type === "audio") {
            emit({ type: "audio", data: c.data, mimeType: c.mimeType });
            if (c.data)
                state.streamedAudioChunks.push(c.data);
            if (c.mimeType) {
                const rateMatch = c.mimeType.match(/rate=(\d+)/);
                if (rateMatch)
                    state.audioSampleRate = parseInt(rateMatch[1], 10);
            }
            return { action: "continue" };
        }
        if (c?.type === "status") {
            const { type: _t, ...statusRest } = c;
            emit({ type: "status", ...statusRest });
            return { action: "continue" };
        }
        // ── Text chunk (default) ─────────────────────────────
        this._recordFirstToken(pass);
        this._recordTiming(pass);
        const rawChunkStr = typeof chunk === "string" ? chunk : "";
        state.overallOutputCharacters += rawChunkStr.length;
        pass.outputCharacters += rawChunkStr.length;
        pass.streamedText += rawChunkStr;
        // Strip tool call XML markup leaked by some local models
        // @ts-ignore - TODO: strict typing
        const cleanedPassText = stripToolCallMarkup(pass.streamedText);
        const chunkStr = cleanedPassText.slice(state.finalStreamedText.length);
        state.finalStreamedText = cleanedPassText;
        if (state.planModeActive)
            state.planModeText += chunkStr;
        // Display segment tracking
        if (state.lastDisplaySegType !== "text") {
            state.displaySegments.push({
                type: "text",
                fragmentIndex: state.displayTextFragments.length,
            });
            state.displayTextFragments.push("");
            state.lastDisplaySegType = "text";
        }
        state.displayTextFragments[state.displayTextFragments.length - 1] +=
            chunkStr;
        SessionGenerationTracker.recordChunkTiming(
        // @ts-ignore - TODO: strict typing
        pass.requestId, rawChunkStr.length);
        if (chunkStr)
            emit({
                type: "chunk",
                content: chunkStr,
                outputCharacters: state.overallOutputCharacters,
            });
        this.maybeEmitProgress();
        return { action: "continue" };
    }
    // ── Iteration logging ─────────────────────────────────────
    /** Log a single iteration to the request log. */
    logIteration(pass, currentMessages) {
        const { resolvedModel, providerName, project, username, agent, agentSessionId, parentAgentSessionId, traceId, } = this.ctx;
        const state = this.state;
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
        const passTotalSec = (performance.now() - pass.start) / 1000;
        const passGenerationSec = pass.firstTokenTime && pass.generationEnd
            ? (pass.generationEnd - pass.firstTokenTime) / 1000
            : null;
        const passTokensPerSec = calculateTokensPerSec(
        // @ts-ignore - TODO: strict typing
        pass.usage.outputTokens, passGenerationSec);
        // @ts-ignore - TODO: strict typing
        const passEstimatedCost = calculateTextCost(pass.usage, pricing);
        RequestLogger.logChatGeneration({
            requestId: `${this.ctx.requestId}-${state.iterations}`,
            endpoint: "/agent",
            operation: "agent:iteration",
            project,
            username,
            clientIp: this.ctx.clientIp,
            agent: agent || null,
            provider: providerName,
            model: resolvedModel,
            agentSessionId,
            parentAgentSessionId: parentAgentSessionId || null,
            traceId: traceId || null,
            success: true,
            usage: pass.usage,
            estimatedCost: passEstimatedCost,
            tokensPerSec: passTokensPerSec,
            timeToGenerationSec: pass.firstTokenTime
                ? (pass.firstTokenTime - pass.start) / 1000
                : null,
            generationSec: passGenerationSec,
            totalSec: passTotalSec,
            options: pass.options,
            messages: currentMessages,
            text: pass.streamedText,
            thinking: pass.streamedThinking,
            images: pass.streamedImages,
            toolCalls: pass.pendingToolCalls,
            outputCharacters: pass.outputCharacters,
            agenticIteration: state.iterations,
        }).catch((error) => logger.error(`[AgenticLoopService] Failed to log intermediate request: ${error.message}`));
    }
    // ── Per-iteration pass state factory ──────────────────────
    /** Create a fresh per-iteration pass state object. */
    createPassState(passOptions) {
        return {
            streamedText: "",
            streamedThinking: "",
            thinkingSignature: "",
            pendingToolCalls: [],
            streamedImages: [],
            start: performance.now(),
            firstTokenTime: null,
            generationEnd: null,
            outputCharacters: 0,
            usage: createUsageAccumulator(),
            options: passOptions,
            requestId: null, // set after tracker registration
        };
    }
    // ── Finalization ──────────────────────────────────────────
    /**
     * Shared finalization logic — cost calculation, persistence,
     * done event, worker snapshot persistence, and afterResponse hooks.
     *
     * Lifted from ReActHarness so all harnesses share the same
     * finalization path without copy-paste.
     */
    async finalize(currentMessages, hooks) {
        const context = this.ctx;
        const state = this.state;
        const { agentSessionId, project, username } = context;
        const requestStart = context.requestStart ?? performance.now();
        const now = performance.now();
        state.overallUsage.requests = state.iterations;
        const { cleanSegments, cleanTextFragments, cleanThinkingFragments } = state.getCleanDisplayData();
        const newTurnMessages = currentMessages.slice(Math.max(0, state.originalMessageCount - 1));
        logger.info(`[AgenticLoop] finalize: session=${agentSessionId} project=${project} ` +
            `originalMsgCount=${state.originalMessageCount} currentMsgs=${currentMessages.length} ` +
            `newTurnMsgs=${newTurnMessages.length} ` +
            `roles=[${newTurnMessages.map((message) => message.role).join(",")}] ` +
            `text=${(state.finalStreamedText || "").length}chars`);
        await finalizeTextGeneration(context, {
            text: state.finalStreamedText.trim(),
            thinking: state.streamedThinking.trim() || "",
            images: state.streamedImages,
            toolCalls: state.streamedToolCalls,
            audioChunks: state.streamedAudioChunks,
            audioSampleRate: state.audioSampleRate,
            usage: state.overallUsage,
            outputCharacters: state.overallOutputCharacters,
            timeToGenerationSec: state.overallFirstTokenTime
                ? (state.overallFirstTokenTime - requestStart) / 1000
                : null,
            generationSec: state.overallFirstTokenTime && state.overallGenerationEnd
                ? (state.overallGenerationEnd - state.overallFirstTokenTime) / 1000
                : null,
            totalSec: (now - requestStart) / 1000,
            rateLimits: state.lastRateLimits,
            contentSegments: cleanSegments,
            textFragments: cleanTextFragments,
            thinkingFragments: cleanThinkingFragments,
        }, 
        // @ts-ignore - TODO: strict typing
        newTurnMessages);
        // Persist worker snapshots for coordinator sessions
        if (state.streamedToolCalls.some((tc) => tc.name === "team_create") &&
            agentSessionId) {
            try {
                const { default: CoordinatorService } = await import("../CoordinatorService.js");
                const workers = CoordinatorService.listWorkers({
                    parentAgentSessionId: agentSessionId,
                });
                if (workers.length > 0) {
                    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_SESSIONS);
                    await collection.updateOne({ id: agentSessionId, project, username }, {
                        $set: {
                            workers,
                            workersUpdatedAt: new Date().toISOString(),
                        },
                    });
                    logger.info(`[AgenticLoop] Persisted ${workers.length} worker(s) to session ${agentSessionId}`);
                }
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error(`[AgenticLoop] Failed to persist workers: ${msg}`);
            }
        }
        // afterResponse hook (fire-and-forget)
        hooks
            // @ts-ignore - TODO: strict typing
            .run("afterResponse", context, {
            text: state.finalStreamedText,
            thinking: state.streamedThinking,
            toolCalls: state.streamedToolCalls,
            messages: currentMessages,
        })
            .catch((error) => logger.error(`[AgenticLoopService] afterResponse hooks failed: ${error.message}`));
    }
    // ── Private helpers ───────────────────────────────────────
    _recordFirstToken(pass) {
        const state = this.state;
        if (!state.overallFirstTokenTime)
            state.overallFirstTokenTime = performance.now();
        if (!pass.firstTokenTime) {
            pass.firstTokenTime = performance.now();
            const ttftSec = (pass.firstTokenTime - pass.start) / 1000;
            // @ts-ignore - TODO: strict typing
            SessionGenerationTracker.update(pass.requestId, { ttft: ttftSec });
            this.ctx.emit({
                type: "status",
                message: "generation_started",
                timeToFirstToken: ttftSec,
            });
        }
    }
    _recordTiming(pass) {
        this.state.overallGenerationEnd = performance.now();
        pass.generationEnd = performance.now();
    }
    _trackToolDisplaySegment(tcId) {
        const state = this.state;
        const lastSeg = state.displaySegments[state.displaySegments.length - 1];
        if (state.lastDisplaySegType === "tools" && lastSeg?.type === "tools") {
            lastSeg.toolIds.push(tcId);
        }
        else {
            state.displaySegments.push({ type: "tools", toolIds: [tcId] });
            state.lastDisplaySegType = "tools";
        }
    }
    async _handleImageChunk(chunk, pass) {
        const { emit, project, username } = this.ctx;
        const state = this.state;
        let minioRef = null;
        if (chunk.data) {
            try {
                const mimeType = chunk.mimeType || "image/png";
                const dataUrl = `data:${mimeType};base64,${chunk.data}`;
                const { ref } = await FileService.uploadFile(dataUrl, "generations", project, username);
                minioRef = ref;
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                logger.error(`MinIO upload failed: ${msg}`);
            }
            const imgRef = minioRef ||
                `data:${chunk.mimeType || "image/png"};base64,${chunk.data}`;
            state.streamedImages.push(imgRef);
            pass.streamedImages.push(imgRef);
        }
        emit({
            type: "image",
            ...(minioRef ? {} : { data: chunk.data }),
            mimeType: chunk.mimeType,
            minioRef,
        });
        return { action: "continue" };
    }
}
//# sourceMappingURL=BaseAgenticHarness.js.map