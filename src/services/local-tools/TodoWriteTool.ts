import logger from "../../utils/logger.ts";

export default {
  name: "todo_write",

  schema: {
    name: "todo_write",
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

  domain: "Agentic: Task Management",
  labels: ["coding"],

  async execute(args: Record<string, unknown>, context: Record<string, unknown>) {
    const { items } = args;
    if (!Array.isArray(items)) {
      return { error: "'items' must be an array of todo objects" };
    }

    // @ts-ignore - TODO: strict typing
    const normalized = items.map((item: Record<string, unknown>, i: Record<string, unknown>) => ({
      // @ts-ignore - TODO: strict typing
      id: i + 1,
      content: item.content || "",
      status: item.status || "pending",
      priority: item.priority || "medium",
    }));

    const stats = {
      total: normalized.length,
      pending: normalized.filter((i: Record<string, unknown>) => i.status === "pending").length,
      in_progress: normalized.filter((i: Record<string, unknown>) => i.status === "in_progress")
        .length,
      completed: normalized.filter((i: Record<string, unknown>) => i.status === "completed").length,
    };

    logger.info(
      `[TodoWrite] ${stats.total} items (${stats.completed} done, ${stats.in_progress} in progress, ${stats.pending} pending)`,
    );

    if (context._emit) {
      // @ts-ignore - TODO: strict typing
      context._emit({ type: "todo_update", items: normalized, stats });
    }

    return { acknowledged: true, items: normalized, stats };
  },
};
