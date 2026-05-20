// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
// @ts-ignore
import { formatCostTag, roundMs } from "@rodrigo-barraza/utilities-library";
import express from "express";
import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../utils/errors.js";
import { TYPES, getPricing, getModelByName } from "../config.js";
import { calculateAudioCost } from "../utils/CostCalculator.js";
import ConversationService from "../services/ConversationService.js";
import FileService from "../services/FileService.js";
import logger from "../utils/logger.js";
import RequestLogger from "../services/RequestLogger.js";
const router = express.Router();
// ─── used by both REST and WebSocket ────────────────────────
/**
 * Handle an audio (TTS) request.
 *
 * @param {Object}   params              Request parameters
 * @param {string}   params.provider     Provider name (required)
 * @param {string}   params.text         Text to synthesize (required)
 * @param {string}   [params.voice]      Voice identifier
 * @param {string}   [params.instructions] TTS instructions
 * @param {string}   [params.model]      Model name
 * @param {Object}   [params.options]    Extra options
 * @param {string}   [params.conversationId]  Auto-append to conversation
 * @param {Object}   [params.conversationMeta] Title + systemPrompt for storage
 * @param {string}   params.project      Project identifier
 * @param {string}   params.username     Username identifier
 * @param {Function} emitBinary          Callback for binary audio chunks: emitBinary(chunk)
 * @param {Function} emitJSON            Callback for JSON events: emitJSON({ type, ...data })
 * @returns {Promise<string>}            Content type of the audio
 */
export async function handleVoice(params, emitBinary, emitJSON) {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    const { provider: providerName, text, voice, instructions, model, options: extraOptions, conversationId: incomingConversationId, conversationMeta: incomingConversationMeta, traceId: incomingTraceId, skipConversation, project = "unknown", username = "unknown", clientIp = null, } = params;
    // ── Auto-conversation: every AI request gets tracked ────────────
    let conversationId = skipConversation ? null : incomingConversationId;
    let conversationMeta = skipConversation ? null : incomingConversationMeta;
    if (!skipConversation && !conversationId) {
        conversationId = crypto.randomUUID();
        // @ts-ignore - TODO: strict typing
        const titleSnippet = (text || "").slice(0, 100).trim() || "TTS Request";
        conversationMeta = conversationMeta || { title: titleSnippet };
    }
    // ── Trace: passthrough ────────────────────────────────────
    // TraceId is generated client-side and passed on every request.
    const traceId = incomingTraceId || null;
    // Inject traceId into conversationMeta for storage
    if (traceId && conversationMeta) {
        // @ts-ignore - TODO: strict typing
        conversationMeta.traceId = traceId;
    }
    else if (traceId) {
        conversationMeta = { traceId };
    }
    try {
        if (!providerName) {
            throw new ProviderError("server", "Missing required field: provider", 400);
        }
        if (!text) {
            throw new ProviderError("server", "Missing required field: text", 400);
        }
        // @ts-ignore - TODO: strict typing
        const provider = getProvider(providerName);
        if (!provider.generateSpeech) {
            throw new ProviderError(
            // @ts-ignore - TODO: strict typing
            providerName, `Provider "${providerName}" does not support text-to-speech`, 400);
        }
        // Mark conversation as generating (creates a stub doc via upsert)
        if (conversationId) {
            ConversationService.setGenerating(
            // @ts-ignore - TODO: strict typing
            conversationId, project, username, true).catch((error) => logger.error(`Failed to set isGenerating: ${error.message}`));
        }
        // @ts-ignore - TODO: strict typing
        const options = { instructions, model, ...extraOptions };
        const result = await provider.generateSpeech(text, voice, options);
        const totalSec = (performance.now() - requestStart) / 1000;
        const contentType = result.contentType || "audio/mpeg";
        // Collect audio chunks for MinIO upload when conversationId is provided
        const audioChunks = conversationId ? [] : null;
        if (result.stream.pipe) {
            // Node.js readable stream
            if (audioChunks) {
                // @ts-ignore
                result.stream.on("data", (chunk) => audioChunks.push(chunk));
            }
            // @ts-ignore
            for await (const chunk of result.stream) {
                // @ts-ignore - TODO: strict typing
                emitBinary(chunk);
            }
        }
        else {
            // Web ReadableStream (from fetch)
            const reader = result.stream.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                // @ts-ignore
                if (audioChunks)
                    audioChunks.push(Buffer.from(value));
                // @ts-ignore - TODO: strict typing
                emitBinary(value);
            }
        }
        logger.request(
        // @ts-ignore - TODO: strict typing
        project, username, clientIp, `[audio] ${providerName} model=${model || "default"} — ` +
            `total: ${totalSec.toFixed(2)}s`);
        RequestLogger.log({
            requestId,
            endpoint: "text-to-audio",
            project,
            username,
            clientIp,
            provider: providerName,
            model: model || null,
            conversationId: conversationId || null,
            traceId: traceId || null,
            success: true,
            // @ts-ignore - TODO: strict typing
            inputCharacters: text.length,
            totalTime: roundMs(totalSec),
        });
        // @ts-ignore - TODO: strict typing
        emitJSON({ type: "done" });
        // Auto-append to conversation
        if (conversationId && audioChunks) {
            let audioRef = null;
            try {
                const audioBuffer = Buffer.concat(audioChunks);
                const dataUrl = `data:${contentType};base64,${audioBuffer.toString("base64")}`;
                const { ref } = await FileService.uploadFile(dataUrl, "generations", 
                // @ts-ignore - TODO: strict typing
                project, username);
                audioRef = ref;
            }
            catch (error) {
                // @ts-ignore - TODO: strict typing
                logger.error(`Failed to upload TTS audio: ${error.message}`);
            }
            const messagesToAppend = [];
            // Derive user message from text
            messagesToAppend.push({
                role: "user",
                content: text,
                timestamp: new Date().toISOString(),
            });
            messagesToAppend.push({
                role: "assistant",
                content: "",
                ...(audioRef && { audio: audioRef }),
                model: model || undefined,
                provider: providerName,
                voice: voice || undefined,
                timestamp: new Date().toISOString(),
                totalTime: roundMs(totalSec),
            });
            const meta = conversationMeta
                ? { ...conversationMeta, settings: { provider: providerName, model } }
                : undefined;
            ConversationService.appendMessages(
            // @ts-ignore - TODO: strict typing
            conversationId, project, username, messagesToAppend, meta)
                .then(() => ConversationService.setGenerating(
            // @ts-ignore - TODO: strict typing
            conversationId, project, username, false))
                .catch((error) => logger.error(`Failed to append messages to conversation ${conversationId}: ${error.message}`));
        }
        return contentType;
    }
    catch (error) {
        // Clear isGenerating flag on error
        if (conversationId) {
            ConversationService.setGenerating(
            // @ts-ignore - TODO: strict typing
            conversationId, project, username, false).catch((error) => logger.error(`Failed to clear isGenerating on error: ${error.message}`));
        }
        const totalSec = (performance.now() - requestStart) / 1000;
        RequestLogger.log({
            requestId,
            endpoint: "text-to-audio",
            project,
            username,
            clientIp,
            provider: providerName,
            model: model || null,
            traceId: traceId || null,
            success: false,
            // @ts-ignore - TODO: strict typing
            errorMessage: error.message,
            totalTime: totalSec,
        });
        // @ts-ignore - TODO: strict typing
        emitJSON({ type: "error", message: error.message });
        throw error;
    }
}
// ─── chunked binary audio ───────────────────────────────────
/**
 * POST /text-to-audio
 * Body: { provider, text, voice?, instructions?, model?, options?, conversationId?, conversationMeta? }
 *
 * Default:          Binary audio stream with content-type header
 * ?format=dataUrl:  JSON response { audioDataUrl, contentType }
 */
router.post("/", asyncHandler(async (req, res, next) => {
    // Skip TTS handler when mounted at /audio-to-text
    if (req.baseUrl.includes("audio-to-text"))
        return next();
    try {
        // ── Data URL format: collect chunks → base64-encode → return JSON ──
        if (req.query.format === "dataUrl") {
            // @ts-ignore
            const audioChunks = [];
            const resultContentType = await handleVoice({
                ...req.body,
                project: req.project,
                username: req.username,
                clientIp: req.clientIp,
            }, 
            // @ts-ignore - TODO: strict typing
            (chunk) => audioChunks.push(Buffer.from(chunk)), (_event) => {
                /* JSON events not needed for dataUrl format */
            });
            const ct = resultContentType || "audio/mpeg";
            // @ts-ignore
            const audioDataUrl = `data:${ct};base64,${Buffer.concat(audioChunks).toString("base64")}`;
            return res.json({ audioDataUrl, contentType: ct });
        }
        // ── Default: stream binary audio chunks ──
        let contentType = "audio/mpeg";
        const resultContentType = await handleVoice({
            ...req.body,
            project: req.project,
            username: req.username,
            clientIp: req.clientIp,
        }, 
        // @ts-ignore - TODO: strict typing
        (chunk) => {
            // Set headers on first chunk
            if (!res.headersSent) {
                res.setHeader("Content-Type", contentType);
                res.setHeader("Transfer-Encoding", "chunked");
            }
            res.write(chunk);
        }, (_event) => {
            /* REST doesn't send JSON events to client */
        });
        if (resultContentType) {
            contentType = resultContentType;
        }
        res.end();
    }
    catch (error) {
        if (!res.headersSent) {
            next(error);
        }
    }
}));
// ─── audio transcription (speech-to-text) ───────────────────
/**
 * POST /audio-to-text
 * Body: { provider, audio (base64 string or data URL), model?, language?, prompt? }
 * Response: { text, usage? }
 */
router.post("/", asyncHandler(async (req, res, next) => {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();
    const { provider: providerName, audio, model, language, prompt: transcriptionPrompt, conversationId: incomingConversationId, conversationMeta: incomingConversationMeta, traceId: incomingTraceId, skipConversation, } = req.body;
    // Auto-generate conversationId when caller omits it (mirrors chat route)
    let conversationId = skipConversation
        ? null
        : incomingConversationId || null;
    let conversationMeta = skipConversation
        ? null
        : incomingConversationMeta || null;
    if (!skipConversation && !conversationId) {
        conversationId = crypto.randomUUID();
        conversationMeta = conversationMeta || { title: "Audio Transcription" };
    }
    // ── Trace: passthrough ────────────────────────────────────
    // TraceId is generated client-side and passed on every request.
    const traceId = incomingTraceId || null;
    // Inject traceId into conversationMeta for storage
    if (traceId && conversationMeta) {
        conversationMeta.traceId = traceId;
    }
    else if (traceId) {
        conversationMeta = { traceId };
    }
    try {
        if (!providerName) {
            throw new ProviderError("server", "Missing required field: provider", 400);
        }
        if (!audio) {
            throw new ProviderError("server", "Missing required field: audio", 400);
        }
        // Mark conversation as generating (creates a stub doc via upsert)
        // so the frontend can fetch the conversation by ID immediately.
        if (conversationId) {
            ConversationService.setGenerating(conversationId, 
            // @ts-ignore - TODO: strict typing
            req.project, req.username, true).catch((error) => logger.error(`Failed to set isGenerating: ${error.message}`));
        }
        const provider = getProvider(providerName);
        if (!provider.transcribeAudio) {
            throw new ProviderError(providerName, `Provider "${providerName}" does not support audio transcription`, 400);
        }
        // Parse audio — accept either data URL or raw base64
        let audioBuffer;
        let mimeType = "audio/mpeg";
        const dataUrlMatch = audio.match(/^data:([^;]+);base64,(.+)$/);
        if (dataUrlMatch) {
            mimeType = dataUrlMatch[1];
            // @ts-ignore - TODO: strict typing
            audioBuffer = Buffer.from(dataUrlMatch[2], "base64");
        }
        else {
            // @ts-ignore - TODO: strict typing
            audioBuffer = Buffer.from(audio, "base64");
        }
        const options = {};
        // @ts-ignore
        if (language)
            options.language = language;
        // @ts-ignore
        if (transcriptionPrompt)
            options.prompt = transcriptionPrompt;
        const result = await provider.transcribeAudio(audioBuffer, mimeType, model, options);
        const totalSec = (performance.now() - requestStart) / 1000;
        // ── Cost estimation ─────────────────────────────────────────
        const modelDef = getModelByName(model);
        const pricing = 
        // @ts-ignore
        modelDef?.pricing ||
            // @ts-ignore
            getPricing(TYPES.AUDIO, TYPES.TEXT)[model] ||
            null;
        const estimatedCost = calculateAudioCost(result.usage, pricing);
        // ── Logging ────────────────────────────────────────────────
        const costStr = formatCostTag(estimatedCost);
        logger.request(
        // @ts-ignore - TODO: strict typing
        req.project, req.username, req.clientIp, `[audio/transcribe] ${providerName} model=${model || "default"} — ` +
            `total: ${totalSec.toFixed(2)}s${costStr}`);
        RequestLogger.log({
            requestId,
            endpoint: "audio-to-text",
            project: req.project,
            username: req.username,
            clientIp: req.clientIp,
            provider: providerName,
            model: model || null,
            conversationId,
            traceId: traceId || null,
            success: true,
            inputTokens: result.usage?.inputTokens || 0,
            outputTokens: result.usage?.outputTokens || 0,
            estimatedCost,
            totalTime: roundMs(totalSec),
        });
        // ── Conversation persistence ────────────────────────────────
        if (conversationId) {
            // Upload audio to MinIO for storage
            let audioRef = audio;
            try {
                const { ref } = await FileService.uploadFile(audio, "uploads", req.project, req.username);
                audioRef = ref;
            }
            catch (error) {
                // @ts-ignore - TODO: strict typing
                logger.error(`Failed to upload STT audio: ${error.message}`);
            }
            const messagesToAppend = [
                {
                    role: "user",
                    content: transcriptionPrompt || "Transcribe this audio",
                    images: [audioRef],
                    timestamp: new Date().toISOString(),
                },
                {
                    role: "assistant",
                    content: result.text || "",
                    model: model || undefined,
                    provider: providerName,
                    timestamp: new Date().toISOString(),
                    totalTime: roundMs(totalSec),
                    estimatedCost,
                    usage: result.usage || undefined,
                },
            ];
            const meta = conversationMeta
                ? {
                    ...conversationMeta,
                    settings: { provider: providerName, model },
                }
                : undefined;
            ConversationService.appendMessages(conversationId, 
            // @ts-ignore - TODO: strict typing
            req.project, req.username, messagesToAppend, meta)
                .then(() => ConversationService.setGenerating(conversationId, 
            // @ts-ignore - TODO: strict typing
            req.project, req.username, false))
                .catch((error) => logger.error(`Failed to append messages to conversation ${conversationId}: ${error.message}`));
        }
        res.json({
            text: result.text,
            usage: result.usage || {},
            estimatedCost,
            totalTime: roundMs(totalSec),
            ...(traceId && { traceId }),
        });
    }
    catch (error) {
        // Clear isGenerating flag on error
        if (conversationId) {
            ConversationService.setGenerating(conversationId, 
            // @ts-ignore - TODO: strict typing
            req.project, req.username, false).catch((error) => logger.error(`Failed to clear isGenerating on error: ${error.message}`));
        }
        const totalSec = (performance.now() - requestStart) / 1000;
        RequestLogger.log({
            requestId,
            endpoint: "audio-to-text",
            project: req.project,
            username: req.username,
            clientIp: req.clientIp,
            provider: providerName,
            model: model || null,
            conversationId,
            traceId: traceId || null,
            success: false,
            // @ts-ignore - TODO: strict typing
            errorMessage: error.message,
            totalTime: totalSec,
        });
        next(error);
    }
}));
export default router;
//# sourceMappingURL=AudioRoutes.js.map