import { EventEmitter } from "events";
import logger from "../utils/logger.js";
/**
 * AgentHooks — EventEmitter-based lifecycle system for the agentic loop.
 *
 * Events:
 *   beforePrompt     — Fires before each LLM call. Listeners receive (ctx) and
 *                       can mutate ctx.messages (e.g. inject system prompt context).
 *   beforeToolCall   — Fires before each tool execution. Listeners receive
 *                       (toolCall, ctx) and can return { approved: false } to block.
 *   afterToolCall    — Fires after each tool returns. Listeners receive
 *                       (toolCall, result, ctx).
 *   afterResponse    — Fires when the loop exits with a final response.
 *                       Listeners receive (ctx, { text, thinking, toolCalls, messages }).
 *   onError          — Fires on any loop error. Listeners receive (error, ctx).
 *
 * Usage:
 *   const hooks = new AgentHooks();
 *   hooks.register("beforePrompt", async (ctx) => { ... });
 *   await hooks.emit("beforePrompt", ctx);
 */
export default class AgentHooks extends EventEmitter {
    constructor() {
        super();
        // @ts-ignore
        this._hooks = new Map();
    }
    /**
     * Register a named async hook for a lifecycle event.
     * Hooks run sequentially in registration order.
     *
  
  
     */
    register(event, handler, name) {
        // @ts-ignore
        if (!this._hooks.has(event)) {
            // @ts-ignore
            this._hooks.set(event, []);
        }
        // @ts-ignore
        this._hooks
            .get(event)
            .push({ handler, name: name || handler.name || "anonymous" });
    }
    /**
     * Run all registered hooks for an event sequentially.
     * Each hook can mutate ctx or return a control object.
     *
  
  
     * @returns {Promise<object|undefined>} Merged results from handlers
     */
    // @ts-ignore - TODO: strict typing
    async run(event, ...args) {
        // @ts-ignore
        const hooks = this._hooks.get(event) || [];
        let result;
        // @ts-ignore
        for (const { handler, name } of hooks) {
            try {
                // @ts-ignore - TODO: strict typing
                const hookResult = await handler(...args);
                if (hookResult && typeof hookResult === "object") {
                    // @ts-ignore - TODO: strict typing
                    result = { ...result, ...hookResult };
                }
            }
            catch (error) {
                logger.error(
                // @ts-ignore - TODO: strict typing
                `[AgentHooks] Hook "${name}" on "${event}" failed: ${error.message}`);
            }
        }
        // @ts-ignore - TODO: strict typing
        return result;
    }
    /**
     * Check if any hooks are registered for an event.
  
  
     */
    hasHooks(event) {
        // @ts-ignore
        return (this._hooks.get(event) || []).length > 0;
    }
}
//# sourceMappingURL=AgentHooks.js.map