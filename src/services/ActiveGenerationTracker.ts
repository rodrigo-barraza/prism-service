import WebhookEventBus from "./WebhookEventBus.ts";

let activeCount = 0;

const ActiveGenerationTracker = {
  /** Increment the active generation counter. */
  increment(metadata?: {
    agent?: string | null;
    model?: string | null;
    provider?: string | null;
    conversationId?: string | null;
  }) {
    activeCount++;
    WebhookEventBus.emit("generation.started", {
      activeCount,
      ...(metadata || {}),
    });
  },

  /** Decrement the active generation counter (floor at 0). */
  decrement() {
    activeCount = Math.max(0, activeCount - 1);
    WebhookEventBus.emit("generation.completed", {
      activeCount,
    });
  },

  /** Current number of in-flight provider calls. */
  get count() {
    return activeCount;
  },
};

export default ActiveGenerationTracker;
