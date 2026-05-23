import MongoWrapper from "../../../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../../../config.ts";
import logger from "../../../utils/logger.ts";

import type { ToolCall, ResolvedTools, EmitFn } from "../types.ts";

/**
 * ToolHotReloader — refreshes custom tools mid-session without restart.
 *
 * When a custom tool is created, updated, or deleted during an agentic loop,
 * this module re-fetches the custom tools from MongoDB and rebuilds
 * the live customToolMap and finalTools arrays.
 *
 * Extracted from ReActHarness to be reusable across harnesses.
 */

/** Tool names that trigger a custom tool reload when executed. */
const CUSTOM_TOOL_MUTATION_NAMES = new Set([
  "create_custom_tool",
  "create_privileged_tool",
  "update_custom_tool",
  "delete_custom_tool",
]);

/**
 * Check whether any tool calls in this batch mutated custom tools,
 * and if so, reload the custom tool definitions from MongoDB.
 * Returns true if tools were reloaded.
 */
export async function reloadIfCustomToolsMutated(
  executedToolCalls: ToolCall[],
  tools: ResolvedTools,
  project: string,
  username: string,
  emit: EmitFn,
): Promise<boolean> {
  const hasMutations = executedToolCalls.some((toolCall) =>
    CUSTOM_TOOL_MUTATION_NAMES.has(toolCall.name),
  );

  if (!hasMutations) return false;

  try {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return false;

    const freshCustomTools = await database
      .collection("custom_tools")
      .find({ project, username, enabled: true })
      .toArray();

    // Rebuild the customToolMap
    tools.customToolMap.clear();
    for (const customTool of freshCustomTools) {
      tools.customToolMap.set(customTool.name, customTool);
    }

    // Rebuild finalTools: remove old custom tools, add fresh ones
    const builtInTools = tools.finalTools.filter(
      (tool) => !tool._isCustom,
    );
    const freshSchemas = freshCustomTools.map((customTool: Record<string, unknown>) => ({
      name: customTool.name as string,
      description: customTool.description as string,
      _isCustom: true as const,
      parameters: {
        type: "object" as const,
        properties: Object.fromEntries(
          ((customTool.parameters || []) as Record<string, unknown>[]).map((param) => [
            param.name,
            {
              type: (param.type as string) || "string",
              description: (param.description as string) || "",
              ...((param.enum as string[])?.length ? { enum: param.enum } : {}),
            },
          ]),
        ),
        required: ((customTool.parameters || []) as Record<string, unknown>[])
          .filter((param) => param.required)
          .map((param) => param.name as string),
      },
    }));

    tools.finalTools = [...builtInTools, ...freshSchemas];

    logger.info(
      `[ToolHotReloader] Reloaded ${freshCustomTools.length} custom tool(s) into live session`,
    );

    emit({ type: "status", message: "custom_tools_updated" });
    return true;
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? (error as Error).message : String(error);
    logger.warn(`[ToolHotReloader] Failed to reload custom tools: ${errorMessage}`);
    return false;
  }
}
