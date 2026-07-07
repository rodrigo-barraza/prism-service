/**
 * AgentNotificationService — standardized notification handling for
 * agentic tasks, sub-agents, and background events.
 *
 * This service provides a centralized way to format and dispatch
 * <task-notification> XML-wrapped messages that allow parent agents
 * (or humans) to understand the status and results of delegated work.
 */

import { NOTIFICATION_SOURCES } from "#src/constants";
import type { ConversationMessage } from "./harnesses/types.ts";

export interface TaskNotificationOptions {
  status: string;
  summary: string;
  toolUses?: number;
  durationMilliseconds?: number;
  resultBody: string;
  source: string;
}

export default class AgentNotificationService {
  /**
   * Format a task notification into a standardized <task-notification> XML structure.
   */
  static formatTaskNotification(options: TaskNotificationOptions): string {
    const {
      status,
      summary,
      toolUses = 0,
      durationMilliseconds = 0,
      resultBody,
    } = options;

    return [
      `<task-notification>`,
      `<status>${status}</status>`,
      `<summary>${summary}</summary>`,
      `<tool_uses>${toolUses}</tool_uses>`,
      `<duration_ms>${durationMilliseconds}</duration_ms>`,
      `<result>`,
      resultBody,
      `</result>`,
      `</task-notification>`,
    ].join("\n");
  }

  /**
   * Create a ConversationMessage representing a task notification.
   */
  static createNotificationMessage(
    options: TaskNotificationOptions,
    notificationId?: string,
  ): ConversationMessage {
    const timestamp = new Date().toISOString();
    const content = this.formatTaskNotification(options);

    return {
      role: "user",
      content,
      timestamp,
      _alreadyPersisted: true,
      _notificationSource: options.source,
      _notificationId:
        notificationId || `${options.source}:${options.summary}:${timestamp}`,
    } as ConversationMessage;
  }
}
