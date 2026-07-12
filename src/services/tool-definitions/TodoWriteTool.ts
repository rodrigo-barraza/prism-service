import logger from "#src/utils/logger";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  SERVER_SENT_EVENT_TYPES,
  TOOL_NAMES,
  DOMAINS,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { INTERNAL_TOOL_EMOJIS } from "#src/services/tool-orchestrator/InternalToolEmojis";
import { SYSTEM_STATUSES, TODO_PRIORITIES } from "#src/constants";
import { InternalToolContext } from "./InternalToolRegistry.ts";


interface TodoItemNormalized {
  id: number;
  content: string;
  status: string;
  priority: string;
}

interface TodoStats {
  total: number;
  pending: number;
  in_progress: number;
  completed: number;
}

interface TodoEmitEvent {
  type: typeof SERVER_SENT_EVENT_TYPES.TODO_UPDATE;
  items: TodoItemNormalized[];
  stats: TodoStats;
}

interface TodoContext extends InternalToolContext {
  _emit?: (event: TodoEmitEvent) => void;
}

export default {
  name: TOOL_NAMES.WRITE_TODO,

  emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.WRITE_TODO],
  description:
    "Write or update a persistent TODO checklist for the current project. " +
    "Maintains a structured list of items with completion status. " +
    "Use this to track multi-step work, record progress, and keep a living " +
    "checklist that persists across conversation turns. " +
    "Each item has a status: 'pending', 'in_progress', or 'completed'. " +
    "Call with the full updated list — it replaces the previous state.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "The todo item text." },
            status: {
              type: "string",
              enum: [
                SYSTEM_STATUSES.PENDING,
                SYSTEM_STATUSES.IN_PROGRESS,
                SYSTEM_STATUSES.COMPLETED,
              ],
              description: "Item status. Default: 'pending'.",
            },
            priority: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "Optional priority level.",
            },
          },
          required: ["content"],
        },
        description:
          "Full list of todo items. Replaces the previous list entirely.",
      },
    },
    required: ["items"],
  },
  display: {
    activeVerb: "Updating checklist",
    completedVerb: "Updated checklist",
    subjectParam: "items",
    subjectFormat: "truncate" as const,
  },

  domain: DOMAINS.CORE_HARNESS.displayName,
  labels: ["coding"],

  async execute(toolArguments: Record<string, unknown>, context: TodoContext) {
    const items = toolArguments.items;
    if (!Array.isArray(items)) {
      return {
        error: PromptLocaleService.get(
          PromptLocaleService.getDefaultLocale(),
          "internal-tools-runtime.write_todo.invalidItems",
        ),
      };
    }

    const normalized: TodoItemNormalized[] = items.map((item, index) => {
      const itemInput =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      return {
        id: index + 1,
        content: typeof itemInput.content === "string" ? itemInput.content : "",
        status:
          typeof itemInput.status === "string" &&
          (itemInput.status === SYSTEM_STATUSES.PENDING ||
            itemInput.status === SYSTEM_STATUSES.IN_PROGRESS ||
            itemInput.status === SYSTEM_STATUSES.COMPLETED)
            ? itemInput.status
            : SYSTEM_STATUSES.PENDING,
        priority:
          typeof itemInput.priority === "string" &&
          (itemInput.priority === TODO_PRIORITIES.HIGH ||
            itemInput.priority === TODO_PRIORITIES.MEDIUM ||
            itemInput.priority === TODO_PRIORITIES.LOW)
            ? itemInput.priority
            : TODO_PRIORITIES.MEDIUM,
      };
    });

    const stats: TodoStats = {
      total: normalized.length,
      pending: normalized.filter(
        (todoItem) => todoItem.status === SYSTEM_STATUSES.PENDING,
      ).length,
      in_progress: normalized.filter(
        (todoItem) => todoItem.status === SYSTEM_STATUSES.IN_PROGRESS,
      ).length,
      completed: normalized.filter(
        (todoItem) => todoItem.status === "completed",
      ).length,
    };

    logger.info(
      `[TodoWrite] ${stats.total} items (${stats.completed} done, ${stats.in_progress} in progress, ${stats.pending} pending)`,
    );

    if (context._emit) {
      context._emit({
        type: SERVER_SENT_EVENT_TYPES.TODO_UPDATE,
        items: normalized,
        stats,
      });
    }

    return { acknowledged: true, items: normalized, stats };
  },
};
