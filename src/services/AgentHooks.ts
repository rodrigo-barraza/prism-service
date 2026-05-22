import logger from "../utils/logger.ts";
import { errorMessage } from "../utils/errorMessage.ts";

/**
 * AgentHooks — typed lifecycle system for the agentic loop.
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
 *   await hooks.run("beforePrompt", ctx);
 */

type HookEvent =
  | "beforePrompt"
  | "beforeToolCall"
  | "afterToolCall"
  | "afterResponse"
  | "onError";

// Hook handlers have heterogeneous signatures per event (beforePrompt receives
// a context object, beforeToolCall receives (toolCall, ctx), afterResponse
// receives (ctx, output), etc.). A single function type can't express this
// without a complex generic event map, so we use a callable interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookHandler = (...args: any[]) => Promise<object | void> | object | void;

interface RegisteredHook {
  handler: HookHandler;
  name: string;
}

export default class AgentHooks {
  private _hooks: Map<HookEvent, RegisteredHook[]>;

  constructor() {
    this._hooks = new Map();
  }

  /**
   * Register a named async hook for a lifecycle event.
   * Hooks run sequentially in registration order.
   */
  register(event: HookEvent, handler: HookHandler, name: string): void {
    if (!this._hooks.has(event)) {
      this._hooks.set(event, []);
    }
    this._hooks
      .get(event)!
      .push({ handler, name: name || handler.name || "anonymous" });
  }

  /**
   * Run all registered hooks for an event sequentially.
   * Each hook can mutate ctx or return a control object.
   */
  async run(event: HookEvent, ...args: unknown[]): Promise<Record<string, unknown> | undefined> {
    const hooks = this._hooks.get(event) || [];
    let result: Record<string, unknown> | undefined;

    for (const { handler, name } of hooks) {
      try {
        const hookResult = await handler(...args);
        if (hookResult && typeof hookResult === "object") {
          result = { ...result, ...hookResult };
        }
      } catch (error: unknown) {
        logger.error(
          `[AgentHooks] Hook "${name}" on "${event}" failed: ${errorMessage(error)}`,
        );
      }
    }

    return result;
  }

  hasHooks(event: HookEvent): boolean {
    return (this._hooks.get(event) || []).length > 0;
  }
}
