/**
 * Factory: create an LM Studio provider instance targeting a specific baseUrl.


 * @returns {object} Provider object with all LM Studio methods
 */
export declare function createLmStudioProvider(baseUrl: any, instanceId?: any): {
    name: any;
    generateText(messages: any, model?: any, options?: any): Promise<{
        text: any;
        thinking: any;
        usage: {
            inputTokens: any;
            outputTokens: any;
        };
    }>;
    generateTextStream(messages: any, model?: any, options?: any): AsyncGenerator<any, void, unknown>;
    /**
     * OpenAI-compat streaming path — used when coordinator tools are enabled.
     * Sends a standard /v1/chat/completions request with `tools` array.
     * Tool calls yield as non-native events, so Prism's agentic loop
     * executes them (including team_create, send_message, stop_agent).
     *
     * @private
     */
    _streamOpenAICompat(prepared: any, model: any, options: any, baseUrl: any): AsyncGenerator<any, void, unknown>;
    /**
     * Generate an embedding via the OpenAI-compatible /v1/embeddings endpoint.
     * LM Studio exposes this for any loaded embedding model (e.g. Granite,
     * nomic-embed, etc.).
     *


     * @returns {Promise<{ embedding: number[], dimensions: number }>}
     */
    generateEmbedding(content: any, model: any, options?: any): Promise<{
        embedding: any;
        dimensions: any;
    }>;
    captionImage(images: any, prompt: any | undefined, model: any | undefined, systemPrompt: any): Promise<{
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
    ensureModelLoaded(modelKey: any, loadOptions: any | undefined, signal: any, onStatus: any): Promise<{
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
    loadModel(model: any, options: any | undefined, signal: any): Promise<unknown>;
    /**
     * Unload a model from LM Studio by its model key.
     * Looks up the loaded instance ID and unloads it.
     */
    unloadModelByKey(modelKey: any): Promise<void>;
    /**
     * Unload a model from LM Studio memory.
     */
    unloadModel(instanceId: any): Promise<unknown>;
};
//# sourceMappingURL=lm-studio.d.ts.map