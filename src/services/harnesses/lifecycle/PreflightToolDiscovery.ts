// ── Pre-flight Tool Discovery ────────────────────────────────
//
// Runs the same deterministic BM25 catalog search that backs
// `discover_and_enable_tools` — but BEFORE iteration 1, against the user's
// message text — and pre-enables the top matches. With the matched tools
// already in the initial tool array:
//   - the tool set stays stable across the loop, so the provider prompt-cache
//     prefix survives (a mid-run tool-set change invalidates it entirely);
//   - no <tool-update> documentation addendum needs injecting for them;
//   - the discovery LLM iteration itself is eliminated in the common case.
//
// The model keeps `discover_and_enable_tools` for anything missed — this is
// an optimization of the common "discover on iteration 1" pattern, not a
// replacement for runtime discovery.

import logger from "#src/utils/logger";
import { TOOLS } from "#src/constants";
import ToolContext from "#src/services/ToolContext";
import SettingsService from "#src/services/SettingsService";
import ToolOrchestratorService from "#src/services/tool-orchestrator/ToolOrchestratorService";
import {
  getCurrentDynamicTools,
  getDynamicSeedTools,
} from "#src/services/tool-definitions/utils/DynamicToolHelpers";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import type { AgenticContext, ConversationMessage } from "../types.ts";

interface PreflightParams {
  context: AgenticContext;
  /** Result of the first AgenticToolResolver.resolve() call. */
  resolvedTools: {
    finalTools: ReadonlyArray<{ name: string }>;
    resolvedEnabledTools: string[] | null;
  };
}

export interface PreflightResult {
  /** Tool names newly merged into dynamicEnabledTools (empty = no change). */
  enabledTools: string[];
}

/** Extract the trailing user message's text (string or text-part array). */
function extractLastUserMessageText(
  messages: ConversationMessage[],
): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as Record<string, unknown>;
    if (message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === "object" && typeof part.text === "string"
            ? part.text
            : "",
        )
        .join(" ")
        .trim();
    }
    return "";
  }
  return "";
}

/**
 * Pre-enable catalog tools matching the user's message. Fail-open: any
 * error or gate miss returns `{ enabledTools: [] }` and the loop proceeds
 * with the originally resolved tool set.
 *
 * IMPORTANT: merges into `dynamicEnabledTools` via ToolContext.set WITHOUT
 * setting `toolSetDirty` — persistDynamicTools would flag the set as dirty
 * and cause checkAndApplyToolSetChanges() to fire after iteration 1,
 * re-introducing the cache thrash this module exists to prevent. The caller
 * re-resolves tools immediately, so the flag has no work to do.
 */
export async function runPreflightToolDiscovery({
  context,
  resolvedTools,
}: PreflightParams): Promise<PreflightResult> {
  const none: PreflightResult = { enabledTools: [] };
  try {
    const { options, agentConversationId, messages } = context;

    // ── Gates (cheapest first) ─────────────────────────────
    if (options.isSubAgent) return none; // orchestrator hands sub-agents explicit tool sets
    if (!agentConversationId) return none;

    // Persona resolved to "all tools" — nothing to add.
    if (resolvedTools.resolvedEnabledTools === null) return none;

    const agentSettings = await SettingsService.getSection("agents");
    if (agentSettings?.dynamicToolActivation === false) return none;
    if (agentSettings?.preflightToolDiscovery === false) return none;

    const query = extractLastUserMessageText(messages).slice(
      0,
      TOOLS.MAX_PREFLIGHT_QUERY_CHARACTERS,
    );
    if (!query) return none;

    const currentDynamicTools = getCurrentDynamicTools(agentConversationId);
    // Cap DISCOVERY GROWTH, not total set size: dynamicEnabledTools is seeded
    // with the full client/persona baseline (often >30 tools), so counting it
    // raw would permanently gate preflight off for exactly the conversations
    // that need it.
    const seedTools = new Set(getDynamicSeedTools(agentConversationId));
    const discoveredCount = currentDynamicTools.filter(
      (name) => !seedTools.has(name),
    ).length;
    if (discoveredCount >= TOOLS.MAX_PREFLIGHT_DYNAMIC_TOOL_TOTAL) {
      return none; // discovery already grew the set a lot — marginal matches not worth further prompt growth
    }

    // ── Search (bounded — must never delay time-to-first-token) ──
    const searchPromise = ToolOrchestratorService.executeSearchToolsWithMCP(
      { query, limit: TOOLS.MAX_DYNAMIC_TOOLS_PER_ACTIVATION },
      {
        project: context.project,
        username: context.username,
        // Persona id scopes the search to the agent's reachable universe —
        // blocked-domain tools are filtered from matches server-side.
        agent: context.agent,
        agentConversationId,
        enabledTools: resolvedTools.resolvedEnabledTools,
      },
    );
    const searchResult = await Promise.race([
      searchPromise,
      new Promise<null>((resolve) =>
        setTimeout(
          () => resolve(null),
          TOOLS.PREFLIGHT_SEARCH_TIMEOUT_MILLISECONDS,
        ),
      ),
    ]);
    if (!searchResult || !Array.isArray(searchResult.matches)) {
      if (!searchResult) {
        logger.warn(
          `[PreflightToolDiscovery] Search timed out after ${TOOLS.PREFLIGHT_SEARCH_TIMEOUT_MILLISECONDS}ms — skipping`,
        );
      }
      return none;
    }

    // ── Select: drop already-available tools, cap the rest ──
    const alreadyAvailable = new Set(
      resolvedTools.finalTools.map((tool) => tool.name),
    );
    const candidates = searchResult.matches
      .map((match) => match.name)
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          name.length > 0 &&
          // "recipe:*" entries are multi-tool plans, not enableable tools —
          // their constituent tools ride along as regular matches.
          !name.startsWith("recipe:") &&
          !alreadyAvailable.has(name),
      )
      .slice(0, TOOLS.MAX_PREFLIGHT_TOOLS);
    if (candidates.length === 0) return none;

    // ── Persist: merge into dynamicEnabledTools (write-through), NO dirty flag ──
    const mergedToolSet = new Set([...currentDynamicTools, ...candidates]);
    ToolContext.set(agentConversationId, "dynamicEnabledTools", [
      ...mergedToolSet,
    ]);

    logger.info(
      `[PreflightToolDiscovery] conversation=${agentConversationId} query="${query.slice(0, 80)}" → pre-enabled ${candidates.length} tools: [${candidates.join(", ")}]`,
    );
    return { enabledTools: candidates };
  } catch (error: unknown) {
    logger.warn(
      `[PreflightToolDiscovery] Failed (continuing without pre-flight): ${getErrorMessage(error)}`,
    );
    return none;
  }
}

export default runPreflightToolDiscovery;
