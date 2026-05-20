declare const router: import("express-serve-static-core").Router;
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
export declare function handleVoice(params: any, emitBinary: any, emitJSON: any): Promise<any>;
export default router;
//# sourceMappingURL=AudioRoutes.d.ts.map