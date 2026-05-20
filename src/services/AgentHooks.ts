import { EventEmitter } from "events";
import logger from "../utils/logger.ts";

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
        (this as any)._hooks = new Map();
  }

  /**
   * Register a named async hook for a lifecycle event.
   * Hooks run sequentially in registration order.
   */
  register(event: any, handler: any, name: string) {
        if (!(this as any)._hooks.has(event)) {
            (this as any)._hooks.set(event, []);
    }
        (this as any)._hooks
      .get(event)
      .push({ handler, name: name || handler.name || "anonymous" });
  }

  /**
   * Run all registered hooks for an event sequentially.
   * Each hook can mutate ctx or return a control object.
   */
    async run(event: any, ...args: any) {
        const hooks = (this as any)._hooks.get(event) || [];
    let result: any;

        for ( const { handler, name } of hooks) {
      try {
                const hookResult = await handler(...args);
        if (hookResult && typeof hookResult === "object") {
                    result = { ...result, ...hookResult };
        }
      } catch (error: unknown) {
        logger.error(
                    `[AgentHooks] Hook "${name}" on "${event}" failed: ${(error as Error).message}`,
        );
      }
    }

        return result;
  }
  hasHooks(event: any) {
        return ((this as any)._hooks.get(event) || []).length > 0;
  }
}
