import logger from "../../utils/logger.ts";
import { SSE_EVENT_TYPES, TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

interface TodoItemInput {
  content: string;
  status?: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
}

interface TodoWriteArgs {
  items: TodoItemInput[];
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
  type: typeof SSE_EVENT_TYPES.TODO_UPDATE;
  items: TodoItemNormalized[];
  stats: TodoStats;
}

interface TodoContext {
  _emit?: (event: TodoEmitEvent) => void;
}

export default {
  name: TOOL_NAMES.WRITE_TODO,

  schema: {
    name: TOOL_NAMES.WRITE_TODO,
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

  async execute(args: Record<string, unknown>, context: Record<string, unknown>) {
    const writeArgs = args as unknown as TodoWriteArgs;
    const typedContext = context as unknown as TodoContext;
    const { items } = writeArgs;
    if (!Array.isArray(items)) {
      return { error: "'items' must be an array of todo objects" };
    }

    const normalized: TodoItemNormalized[] = items.map((item, i) => ({
      id: i + 1,
      content: item.content || "",
      status: item.status || "pending",
      priority: item.priority || "medium",
    }));

    const stats: TodoStats = {
      total: normalized.length,
      pending: normalized.filter((i) => i.status === "pending").length,
      in_progress: normalized.filter((i) => i.status === "in_progress").length,
      completed: normalized.filter((i) => i.status === "completed").length,
    };

    logger.info(
      `[TodoWrite] ${stats.total} items (${stats.completed} done, ${stats.in_progress} in progress, ${stats.pending} pending)`,
    );

    if (typedContext._emit) {
      typedContext._emit({ type: SSE_EVENT_TYPES.TODO_UPDATE, items: normalized, stats });
    }

    return { acknowledged: true, items: normalized, stats };
  },
};
