import crypto from "crypto";
import logger from "../utils/logger.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";

export interface WebhookEvent {
  webhookEventId: string;
  webhookTimestamp: string;
  eventType: string;
  data: Record<string, unknown>;
}

export type WebhookEventCallback = (event: WebhookEvent) => void;

const REPLAY_BUFFER_CAPACITY = 200;

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
        logger.error(
          `WebhookEventBus listener error: ${errorMessage(error)}`,
        );
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
