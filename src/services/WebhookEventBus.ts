import crypto from "crypto";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { WEBHOOK } from "#src/constants";

export interface WebhookEvent {
  webhookEventId: string;
  webhookTimestamp: string;
  eventType: string;
  data: Record<string, unknown>;
}

export type WebhookEventCallback = (event: WebhookEvent) => void;

/**
 * The "needs you" events: a conversation waits on its user, its goal moved,
 * or its turn ended. (The request.* / generation.* events are emitted by
 * name where they happen.)
 */
export const NEEDS_YOU_WEBHOOK_EVENTS = {
  APPROVAL_REQUIRED: "approval.required",
  QUESTION_ASKED: "question.asked",
  GOAL_UPDATED: "goal.updated",
  TURN_COMPLETED: "turn.completed",
  TURN_FAILED: "turn.failed",
} as const;

const REPLAY_BUFFER_CAPACITY = WEBHOOK.REPLAY_BUFFER_CAPACITY;

const listeners = new Set<WebhookEventCallback>();
const replayBuffer: WebhookEvent[] = [];

const WebhookEventBus = {
  emit(eventType: string, data: Record<string, unknown>) {
    const event: WebhookEvent = {
      webhookEventId: crypto.randomUUID(),
      webhookTimestamp: new Date().toISOString(),
      eventType,
      data,
    };

    replayBuffer.push(event);
    if (replayBuffer.length > REPLAY_BUFFER_CAPACITY) {
      replayBuffer.shift();
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        logger.error(`WebhookEventBus listener error: ${errorMessage(error)}`);
      }
    }
  },

  subscribe(callback: WebhookEventCallback) {
    listeners.add(callback);
  },

  unsubscribe(callback: WebhookEventCallback) {
    listeners.delete(callback);
  },

  getReplayBuffer(since?: string): WebhookEvent[] {
    if (!since) return [...replayBuffer];
    return replayBuffer.filter((event) => event.webhookTimestamp > since);
  },

  get listenerCount() {
    return listeners.size;
  },
};

export default WebhookEventBus;
