import logger from "../../utils/logger.ts";
import PromptLocaleService from "../PromptLocaleService.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  TOOL_NAMES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { InternalToolContext } from "./InternalToolRegistry.ts";

interface TodoItemInput {
  content: string;
  status?: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}


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

  schema: {
    name: TOOL_NAMES.WRITE_TODO,
    emoji: ["📝", "📌"],
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
                enum: ["pending", "in_progress", "completed"],
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
  },

  labels: ["coding"],

  async execute(toolArguments: Record<string, unknown>, context: TodoContext) {
    const items = toolArguments.items;
    if (!Array.isArray(items)) {
      return { error: PromptLocaleService.get(PromptLocaleService.getDefaultLocale(), "internal-tools-runtime.write_todo.invalidItems") };
    }

    const normalized: TodoItemNormalized[] = items.map((item, index) => {
      const itemInput = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        id: index + 1,
        content: typeof itemInput.content === "string" ? itemInput.content : "",
        status: typeof itemInput.status === "string" && (itemInput.status === "pending" || itemInput.status === "in_progress" || itemInput.status === "completed") ? itemInput.status : "pending",
        priority: typeof itemInput.priority === "string" && (itemInput.priority === "high" || itemInput.priority === "medium" || itemInput.priority === "low") ? itemInput.priority : "medium",
      };
    });

    const stats: TodoStats = {
      total: normalized.length,
      pending: normalized.filter((todoItem) => todoItem.status === "pending")
        .length,
      in_progress: normalized.filter(
        (todoItem) => todoItem.status === "in_progress",
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
