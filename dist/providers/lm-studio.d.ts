import { ProviderOptions, ChatMessage } from "../types/ProviderTypes.ts";
/**
 * Factory: create an LM Studio provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all LM Studio methods
 */
export declare function createLmStudioProvider(baseUrl: string, instanceId?: string): {
    name: string;
    generateText(messages: ChatMessage[], model?: string, options?: ProviderOptions): Promise<{
        text: any;
        thinking: any;
        usage: {
            inputTokens: {};
            outputTokens: {};
        };
    }>;
    generateTextStream(messages: ChatMessage[], model?: string, options?: ProviderOptions): AsyncGenerator<any, void, unknown>;
    /**
     * OpenAI-compat streaming path — used when coordinator tools are enabled.
     * Sends a standard /v1/chat/completions request with `tools` array.
     * Tool calls yield as non-native events, so Prism's agentic loop
     * executes them (including team_create, send_message, stop_agent).
     *
     * @private
     */
    _streamOpenAICompat(prepared: Record<string, unknown>, model: Record<string, unknown>, options: ProviderOptions, baseUrl: string): AsyncGenerator<any, void, unknown>;
    /**
     * Generate an embedding via the OpenAI-compatible /v1/embeddings endpoint.
     * LM Studio exposes this for any loaded embedding model (e.g. Granite,
     * nomic-embed, etc.).
     *


     * @returns {Promise<{ embedding: number[], dimensions: number }>}
     */
    generateEmbedding(content: Record<string, unknown>, model: Record<string, unknown>, options?: ProviderOptions): Promise<{
        embedding: any;
        dimensions: any;
    }>;
    captionImage(images: string[], prompt?: string, model?: string, systemPrompt?: string): Promise<{
        text: any;
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    /**
     * Ensure exactly one model is loaded in LM Studio.
     * - If the requested model is already loaded, returns immediately with its context info.
     * - If a different model is loaded, unloads it first.
     * - If no model is loaded, loads the requested one.
     *


     * @returns {{ alreadyLoaded: boolean, contextLength: number|null }} - Info about the loaded model.
     */
    ensureModelLoaded(modelKey: Record<string, unknown>, loadOptions: Record<string, unknown> | undefined, signal: Record<string, unknown>, onStatus: Record<string, unknown>): Promise<{
        alreadyLoaded: boolean;
        contextLength: any;
    }>;
    /**
     * List all models available in LM Studio.
     * Uses the proprietary GET /api/v1/models endpoint.
     */
    listModels(): Promise<unknown>;
    /**
     * Load a model into LM Studio memory.
     */
    loadModel(model: Record<string, unknown>, options: ProviderOptions | undefined, signal: Record<string, unknown>): Promise<unknown>;
    /**
     * Unload a model from LM Studio by its model key.
     * Looks up the loaded instance ID and unloads it.
     */
    unloadModelByKey(modelKey: Record<string, unknown>): Promise<void>;
    /**
     * Unload a model from LM Studio memory.
     */
    unloadModel(instanceId: string): Promise<unknown>;
};
//# sourceMappingURL=lm-studio.d.ts.map