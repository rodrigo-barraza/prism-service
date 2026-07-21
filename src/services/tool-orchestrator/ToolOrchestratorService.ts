import { TOOLS_SERVICE_URL } from "#config";
import { IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/service";
import MCPClientService from "#src/services/MCPClientService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import {
  partitionByDiscoverableUniverse,
  isScopedPersona,
} from "#src/services/ToolDiscoveryScope";
import logger from "#src/utils/logger";
import {
  getErrorMessage,
  resolveToolDisplaySummary,
  humanizeToolName,
  type ToolDisplayMetadata,
} from "@rodrigo-barraza/utilities-library";
import { ORCHESTRATOR_ONLY_TOOLS } from "#src/services/OrchestratorPrompt";
import { createAbortController } from "#src/utils/AbortController";
import {
  DOMAINS,
  TOOL_NAMES,
  TOOL_INPUT_MODALITIES,
  TOPOLOGIES,
  DEFAULT_TOPOLOGY,
  isCoreDomain,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  TOOL_SCHEMA_FETCH_TIMEOUT_MILLISECONDS,
  TOOL_CONFIG_FETCH_TIMEOUT_MILLISECONDS,
  TOOL_WORKSPACE_UPDATE_TIMEOUT_MILLISECONDS,
  TOOL_WORKSPACE_VALIDATE_TIMEOUT_MILLISECONDS,
  TOOL_API_HEALTH_TIMEOUT_MILLISECONDS,
  FILE_CATEGORIES,
  TOOL_SCHEMA_FETCH_RETRY_COOLDOWN_MILLISECONDS,
  TOOL_PROXY_TIMEOUT_MILLISECONDS,
  AGENT_DIRECTIVES,
} from "#src/constants";
import FileService from "#src/services/FileService";
import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";
import SettingsService from "#src/services/SettingsService";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  injectVoiceCatalog,
  TTS_VOICE_CATALOG_PLACEHOLDER,
} from "#src/utils/VoiceCatalog";
import { Bm25ToolIndex } from "@rodrigo-barraza/utilities-library/search";
import type { OrchestratorContext, TeamMember } from "#src/types/orchestrator";
import {
  type ToolSchemaFull,
  type ToolExecutionContext,
  type ToolsApiConfig,
  type WorktreeState,
  type TransformedSearchToolsResult,
  type GenerateImageToolResult,
  type BrowserActionToolResult,
  type ToolEndpoint,
} from "./types.ts";
import { INTERNAL_TOOL_EMOJIS } from "./InternalToolEmojis.ts";

// ────────────────────────────────────────────────────────────
// Schema Cache — fetched from tools-api at startup
// ────────────────────────────────────────────────────────────

/** @type {Array} Full tool schemas (with endpoint metadata) */
let cachedSchemas: ToolSchemaFull[] = [];

/** @type {Array} Clean schemas for LLM (without endpoint metadata) */
let cachedAISchemas: ToolSchemaFull[] = [];

/** @type {Array} Client-facing schemas (with domain/dataSource, without endpoint) */
let cachedClientSchemas: ToolSchemaFull[] = [];

/**
 * Per-locale caches for remote tool schemas.
 * The default locale populates cachedClientSchemas/cachedAISchemas directly.
 * Non-default locales (e.g. "caveman") are stored here so that
 * getClientToolSchemas(topology, "caveman") returns localized descriptions
 * from the tools-service instead of the default English schemas.
 */
const localizedClientSchemasCache = new Map<string, ToolSchemaFull[]>();
const localizedAISchemasCache = new Map<string, ToolSchemaFull[]>();
const localeFetchAttemptTimes = new Map<string, number>();

/** @type {Map<string, ToolSchemaFull>} Tool name → full schema (for routing) */
const toolMap = new Map<string, ToolSchemaFull>();

/** @type {string[]} Allowed workspace root paths (fetched from tools-api) */
let cachedWorkspaceRoots: string[] = [];



/** @type {boolean} Whether initial fetch has completed */
let initialized = false;
let lastFetchAttemptTime = 0;

/** Recursion guard for client-facing schema resolution */
let isResolvingClientSchemas = false;

/**
 * Active worktree sessions — keyed by agentConversationId.
 * When the main agent calls enter_worktree, its session's workspace root
 * is redirected to the worktree path. All file/git/shell tool calls
 * then operate in the worktree until exit_worktree is called.
 */
const activeWorktrees = new Map<string, WorktreeState>();

/**
 * Fetch tool schemas from tools-api and populate caches.
 * Called eagerly at module load — non-blocking, graceful fallback.
 * Always fetches default English schemas to populate default caches.
 */
async function fetchSchemas() {
  lastFetchAttemptTime = Date.now();
  try {
    const controller = createAbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      TOOL_SCHEMA_FETCH_TIMEOUT_MILLISECONDS,
    );

    const response = await fetch(`${TOOLS_SERVICE_URL}/admin/tool-schemas`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn(
        `[ToolOrchestrator] Failed to fetch tool schemas: ${response.status} ${response.statusText}`,
      );
      return;
    }

    const schemas = (await response.json()) as ToolSchemaFull[];

    if (!Array.isArray(schemas) || schemas.length === 0) {
      logger.warn(
        "[ToolOrchestrator] Tool schemas response was empty or invalid",
      );
      return;
    }

    cachedSchemas = schemas;

    // Client-facing schemas: keep domain/dataSource for UI grouping, strip only endpoint
    cachedClientSchemas = schemas.map(
      ({ endpoint: _endpoint, ...rest }) => rest,
    );

    // Strip endpoint, dataSource, and domain metadata for LLM consumption
    cachedAISchemas = schemas.map(
      ({
        endpoint: _endpoint,
        dataSource: _dataSource,
        domain: _domain,
        ...rest
      }) => rest,
    );

    // Build lookup map for executor
    toolMap.clear();
    for (const schema of schemas) {
      toolMap.set(schema.name, schema);
    }

    initialized = true;

    logger.info(
      `[ToolOrchestrator] Loaded ${schemas.length} tool schemas from tools-api`,
    );

    // Fetch workspace config from tools-api (single source of truth)
    try {
      const configResponse = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
        signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MILLISECONDS),
      });
      if (configResponse.ok) {
        const config = (await configResponse.json()) as ToolsApiConfig;
        if (Array.isArray(config.workspaceRoots)) {
          cachedWorkspaceRoots = config.workspaceRoots;
          logger.info(
            `[ToolOrchestrator] Workspace roots: ${cachedWorkspaceRoots.join(", ")}`,
          );
        }

      }
    } catch (configError: unknown) {
      logger.warn(
        `[ToolOrchestrator] Could not fetch workspace config: ${getErrorMessage(configError)}`,
      );
    }
  } catch (error: unknown) {
    logger.warn(
      `[ToolOrchestrator] Could not reach tools-api for schemas: ${getErrorMessage(error)}`,
    );
  }
}

/**
 * Fetch localized remote tool schemas for a specific non-default locale.
 * Populates the per-locale caches so that getClientToolSchemas(topology, locale)
 * returns tool descriptions in the correct language.
 */
async function fetchSchemasForLocale(locale: string) {
  if (locale === "en" || localizedClientSchemasCache.has(locale)) return;
  const lastAttempt = localeFetchAttemptTimes.get(locale) || 0;
  if (Date.now() - lastAttempt < TOOL_SCHEMA_FETCH_RETRY_COOLDOWN_MILLISECONDS)
    return;
  localeFetchAttemptTimes.set(locale, Date.now());
  try {
    const localeParam = `?locale=${encodeURIComponent(locale)}`;
    const response = await fetch(
      `${TOOLS_SERVICE_URL}/admin/tool-schemas${localeParam}`,
      { signal: AbortSignal.timeout(TOOL_SCHEMA_FETCH_TIMEOUT_MILLISECONDS) },
    );
    if (!response.ok) {
      logger.warn(
        `[ToolOrchestrator] Failed to fetch locale "${locale}" schemas: ${response.status}`,
      );
      return;
    }
    const schemas = (await response.json()) as ToolSchemaFull[];
    if (!Array.isArray(schemas) || schemas.length === 0) return;

    localizedClientSchemasCache.set(
      locale,
      schemas.map(({ endpoint: _endpoint, ...rest }) => rest),
    );
    localizedAISchemasCache.set(
      locale,
      schemas.map(
        ({
          endpoint: _endpoint,
          dataSource: _dataSource,
          domain: _domain,
          ...rest
        }) => rest,
      ),
    );
    logger.info(
      `[ToolOrchestrator] Loaded ${schemas.length} localized tool schemas for locale "${locale}"`,
    );
  } catch (error: unknown) {
    logger.warn(
      `[ToolOrchestrator] Could not fetch locale "${locale}" schemas: ${getErrorMessage(error)}`,
    );
  }
}

/**
 * Prefetch tool schemas for all known non-default locales.
 * Called after the initial fetchSchemas() completes so that
 * per-conversation locale requests are served from cache.
 */
async function prefetchAllLocaleSchemas() {
  const defaultLocale = PromptLocaleService.getDefaultLocale();
  const allLocales = PromptLocaleService.getAvailableLocales();
  const nonDefaultLocales = allLocales.filter(
    (localeName) => localeName !== defaultLocale,
  );
  if (nonDefaultLocales.length === 0) return;
  logger.info(
    `[ToolOrchestrator] Prefetching remote tool schemas for locale(s): ${nonDefaultLocales.join(", ")}`,
  );
  await Promise.allSettled(
    nonDefaultLocales.map((localeName) => fetchSchemasForLocale(localeName)),
  );
}

// Kick off schema fetch eagerly at module load (non-blocking).
// If tools-api is unreachable, schemas stay empty until the first
// consumer calls ensureSchemas(), which fetches on-demand.
fetchSchemas().then(() => prefetchAllLocaleSchemas());

// ────────────────────────────────────────────────────────────
// Generic URL Builder — uses endpoint metadata
// ────────────────────────────────────────────────────────────

export function buildUrlFromEndpoint(
  endpoint: ToolEndpoint,
  args: Record<string, unknown> = {},
) {
  let path = endpoint.path;
  if (endpoint.conditionalPath) {
    const { param, template } = endpoint.conditionalPath;
    if (args[param]) {
      path = template;
    }
  }

  const dynamicParams = new Set<string>();
  const matchResult = path.match(/:[a-zA-Z_][a-zA-Z0-9_]*/g);
  if (matchResult) {
    for (const match of matchResult) {
      dynamicParams.add(match.slice(1));
    }
  }

  const pathParams = new Set([
    ...(endpoint.pathParams || []),
    ...dynamicParams,
  ]);
  for (const parameter of pathParams) {
    const parameterValue = args[parameter];
    if (parameterValue !== undefined && parameterValue !== null) {
      path = path.replace(
        `:${parameter}`,
        encodeURIComponent(String(parameterValue)),
      );
    }
  }

  const params = new URLSearchParams();

  const queryParams = endpoint.queryParams || [];
  for (const key of queryParams) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== "") {
      const serializedValue =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      params.set(key, serializedValue);
    }
  }

  if (args.fields) {
    const fieldsString = Array.isArray(args.fields)
      ? args.fields.join(",")
      : String(args.fields);
    params.set("fields", fieldsString);
  }

  const queryString = params.toString();
  return `${TOOLS_SERVICE_URL}${path}${queryString ? `?${queryString}` : ""}`;
}

export const ARG_REMAPS: Record<string, Record<string, string>> = {
  search_events: { query: "q" },
  search_products: { query: "q" },
};

async function executeToolGeneric(
  name: string,
  args: Record<string, unknown> = {},
  context: ToolExecutionContext = {},
) {
  const schema = toolMap.get(name);
  if (!schema || !schema.endpoint) {
    return { error: `Unknown tool: ${name}` };
  }

  const remaps = ARG_REMAPS[name as keyof typeof ARG_REMAPS];
  let resolvedArgs: Record<string, unknown> = args;
  if (remaps) {
    resolvedArgs = { ...args };
    for (const [from, to] of Object.entries(remaps)) {
      if (resolvedArgs[from] !== undefined) {
        resolvedArgs[to] = resolvedArgs[from];
        delete resolvedArgs[from];
      }
    }
  }

  // Build caller-context headers for tools-api telemetry
  const contextHeaders = buildContextHeaders(context);

  // Body-carrying methods send args as JSON body
  const bodyMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (schema.endpoint.method && bodyMethods.has(schema.endpoint.method)) {
    const url = buildUrlFromEndpoint(schema.endpoint, resolvedArgs).split(
      "?",
    )[0];
    // Inject trusted session context into body — the model's args never
    // include these fields (they're stripped from schemas), so they can
    // only come from the orchestrator's session context.
    const body: Record<string, unknown> = { ...resolvedArgs };
    if (context.project) body.project = context.project;
    if (context.agent) body.agent = context.agent;
    if (context.username) body.username = context.username;

    // Worktree path rewriting — redirect file paths to the worktree directory
    // when the session has an active worktree.
    if (
      context.agentConversationId &&
      activeWorktrees.has(context.agentConversationId)
    ) {
      const worktreeState = activeWorktrees.get(context.agentConversationId)!;
      const rewritePath = (
        targetPath: string | number | boolean | object | null | undefined,
      ): string | number | boolean | object | null | undefined => {
        if (typeof targetPath !== "string") return targetPath;
        if (targetPath.startsWith(worktreeState.originalRoot)) {
          return (
            worktreeState.worktreePath +
            targetPath.slice(worktreeState.originalRoot.length)
          );
        }
        return targetPath;
      };

      // Rewrite common path fields used by file/git/shell tools
      if (body.path) body.path = rewritePath(body.path as string);
      if (body.filePath) body.filePath = rewritePath(body.filePath as string);
      if (body.oldPath) body.oldPath = rewritePath(body.oldPath as string);
      if (body.newPath) body.newPath = rewritePath(body.newPath as string);
      if (body.cwd) body.cwd = rewritePath(body.cwd as string);
      if (body.directory) body.directory = rewritePath(body.directory as string);

      // Inject workspace override header so tools-api sandbox validation passes
      contextHeaders[IDENTITY_HEADERS.workspaceOverride] =
        worktreeState.worktreePath;
    }

    return fetchJsonWithBody(
      url,
      schema.endpoint.method,
      body,
      contextHeaders,
      context.signal,
    );
  }

  const url = buildUrlFromEndpoint(schema.endpoint, resolvedArgs);
  return fetchJson(url, contextHeaders, context.signal);
}

/**
 * Build X-context headers from the caller context object.
 * These are consumed by tools-api's ToolCallLoggerMiddleware.

 */
function buildContextHeaders(
  context: ToolExecutionContext = {},
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (context.project) headers[IDENTITY_HEADERS.project] = context.project;
  if (context.username) headers[IDENTITY_HEADERS.username] = context.username;
  if (context.agent) headers[IDENTITY_HEADERS.agent] = context.agent;
  if (context.requestId)
    headers[IDENTITY_HEADERS.requestId] = context.requestId;
  if (context.traceId) headers["X-Trace-Id"] = context.traceId;
  if (context.agentConversationId)
    headers["X-Agent-Conversation-Id"] = context.agentConversationId;
  if (context.conversationId)
    headers[IDENTITY_HEADERS.conversationId] = context.conversationId;
  if (context.iteration !== undefined && context.iteration !== null)
    headers[IDENTITY_HEADERS.iteration] = String(context.iteration);
  // Multi-workspace: when the user has selected a non-default workspace root,
  // send it to tools-api so file/git/shell tools resolve within it.
  if (context.workspaceRoot)
    headers[IDENTITY_HEADERS.workspaceRoot] = context.workspaceRoot;
  if (context.enabledTools && Array.isArray(context.enabledTools)) {
    headers["X-Enabled-Tools"] = context.enabledTools.join(",");
  }
  if (context._providerName) headers["X-Provider"] = context._providerName;
  if (context._resolvedModel) headers["X-Model"] = context._resolvedModel;
  return headers;
}

async function fetchJson(
  url: string,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
) {
  try {
    const response = await fetch(url, {
      headers: { ...extraHeaders },
      ...(signal && { signal }),
    });
    if (!response.ok) {
      try {
        const errorBody = (await response.json()) as Record<string, unknown>;
        return {
          error:
            errorBody.error ||
            `API returned ${response.status}: ${response.statusText}`,
        };
      } catch {
        return {
          error: `API returned ${response.status}: ${response.statusText}`,
        };
      }
    }
    return await response.json();
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      return { error: "Tool execution aborted" };
    }
    return { error: `Failed to reach API: ${getErrorMessage(error)}` };
  }
}

async function fetchJsonWithBody(
  url: string,
  method: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
) {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify(body),
      ...(signal && { signal }),
    });
    if (!response.ok) {
      // Forward the actual error body from tools-api for debugging
      try {
        const errorBody = (await response.json()) as Record<string, unknown>;
        return {
          error:
            errorBody.error ||
            `API returned ${response.status}: ${response.statusText}`,
        };
      } catch {
        return {
          error: `API returned ${response.status}: ${response.statusText}`,
        };
      }
    }
    return await response.json();
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      return { error: "Tool execution aborted" };
    }
    return { error: `Failed to reach API: ${getErrorMessage(error)}` };
  }
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// Orchestrator Tool Schemas — Prism-local, not routed to tools-api
// ────────────────────────────────────────────────────────────

/**
 * Dynamically builds the `agent` parameter description for the
 * create_subagents schema by reading all registered persona IDs from
 * the AgentPersonaRegistry. This avoids hard-coding persona names
 * like "Lupos" or "Coding" which caused the LLM to misuse the field.
 */
function buildAgentParameterDescription(locale?: string, toolName: string = "create_subagents"): string {
  const activeLocale = locale || PromptLocaleService.getDefaultLocale();
  const registeredAgents = AgentPersonaRegistry.list();
  const agentNames = registeredAgents
    .map((entry) => `'${entry.name}'`)
    .join(", ");

  const agentKey = toolName === "create_subagent"
    ? "orchestrator.tools.create_subagent.parameters.agent"
    : "orchestrator.tools.create_subagents.parameters.memberAgent";
  const defaultKey = toolName === "create_subagent"
    ? "orchestrator.tools.create_subagent.parameters.agentDefault"
    : "orchestrator.tools.create_subagents.parameters.memberAgentDefault";

  if (agentNames) {
    return PromptLocaleService.get(
      activeLocale,
      agentKey,
      {
        agentNames,
      },
    );
  }

  return PromptLocaleService.get(
    activeLocale,
    defaultKey,
  );
}

function getOrchestratorToolSchemas(
  defaultTopology: string = DEFAULT_TOPOLOGY,
  locale?: string,
) {
  const activeLocale = locale || PromptLocaleService.getDefaultLocale();

  const normalizedTopology =
    defaultTopology === TOPOLOGIES.PEER_TO_PEER
      ? TOPOLOGIES.PEER_TO_PEER
      : defaultTopology === TOPOLOGIES.SEQUENTIAL
        ? TOPOLOGIES.SEQUENTIAL
        : defaultTopology === TOPOLOGIES.HIERARCHICAL_AGGREGATION
          ? TOPOLOGIES.HIERARCHICAL_AGGREGATION
          : TOPOLOGIES.HIERARCHICAL;

  const isHierarchical = normalizedTopology === TOPOLOGIES.HIERARCHICAL;
  const isHierarchicalAggregation =
    normalizedTopology === TOPOLOGIES.HIERARCHICAL_AGGREGATION;
  const isSequential = normalizedTopology === TOPOLOGIES.SEQUENTIAL;
  const isPeerToPeer = normalizedTopology === TOPOLOGIES.PEER_TO_PEER;

  const hierarchicalLabel = isHierarchical
    ? `${TOPOLOGIES.HIERARCHICAL} (default)`
    : TOPOLOGIES.HIERARCHICAL;
  const hierarchicalAggregationLabel = isHierarchicalAggregation
    ? `${TOPOLOGIES.HIERARCHICAL_AGGREGATION} (default)`
    : TOPOLOGIES.HIERARCHICAL_AGGREGATION;
  const sequentialLabel = isSequential
    ? `${TOPOLOGIES.SEQUENTIAL} (default)`
    : TOPOLOGIES.SEQUENTIAL;
  const peerToPeerLabel = isPeerToPeer
    ? `${TOPOLOGIES.PEER_TO_PEER} (default)`
    : TOPOLOGIES.PEER_TO_PEER;
  const tournamentLabel =
    defaultTopology === TOPOLOGIES.TOURNAMENT
      ? `${TOPOLOGIES.TOURNAMENT} (default)`
      : TOPOLOGIES.TOURNAMENT;
  const criticLoopLabel =
    defaultTopology === TOPOLOGIES.CRITIC_LOOP
      ? `${TOPOLOGIES.CRITIC_LOOP} (default)`
      : TOPOLOGIES.CRITIC_LOOP;
  const divideAndConquerLabel =
    defaultTopology === TOPOLOGIES.DIVIDE_AND_CONQUER
      ? `${TOPOLOGIES.DIVIDE_AND_CONQUER} (default)`
      : TOPOLOGIES.DIVIDE_AND_CONQUER;
  const mctsLabel =
    defaultTopology === TOPOLOGIES.MCTS
      ? `${TOPOLOGIES.MCTS} (default)`
      : TOPOLOGIES.MCTS;

  const hierarchicalDesc = isHierarchical
    ? "'hierarchical' (default)"
    : "'hierarchical'";
  const hierarchicalAggregationDesc = isHierarchicalAggregation
    ? "'hierarchical_aggregation' (default)"
    : "'hierarchical_aggregation'";
  const sequentialDesc = isSequential
    ? "'sequential' (default)"
    : "'sequential'";
  const peerToPeerDesc = isPeerToPeer
    ? "'peer_to_peer' (default)"
    : "'peer_to_peer'";
  const tournamentDesc =
    defaultTopology === TOPOLOGIES.TOURNAMENT
      ? "'tournament' (default)"
      : "'tournament'";
  const criticLoopDesc =
    defaultTopology === TOPOLOGIES.CRITIC_LOOP
      ? "'critic_loop' (default)"
      : "'critic_loop'";
  const divideAndConquerDesc =
    defaultTopology === TOPOLOGIES.DIVIDE_AND_CONQUER
      ? "'divide_and_conquer' (default)"
      : "'divide_and_conquer'";
  const mctsDesc =
    defaultTopology === TOPOLOGIES.MCTS ? "'mcts' (default)" : "'mcts'";

  return [
    {
      name: TOOL_NAMES.CREATE_SUBAGENT,
      emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.CREATE_SUBAGENT],
      description: PromptLocaleService.get(
        activeLocale,
        "orchestrator.tools.create_subagent.description",
      ),
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.create_subagent.parameters.description",
            ),
          },
          prompt: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.create_subagent.parameters.prompt",
            ),
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.create_subagent.parameters.files",
            ),
          },
          model: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.create_subagent.parameters.model",
            ),
          },
          agent: {
            type: "string",
            description: buildAgentParameterDescription(activeLocale, "create_subagent"),
          },
        },
        required: ["description", "prompt"],
      },
    },
    {
      name: TOOL_NAMES.CREATE_SUBAGENTS,
      emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.CREATE_SUBAGENTS],
      description: PromptLocaleService.get(
        activeLocale,
        "orchestrator.tools.create_subagents.description",
        {
          hierarchicalDesc,
          hierarchicalAggregationDesc,
          sequentialDesc,
          peerToPeerDesc,
          tournamentDesc,
          criticLoopDesc,
          divideAndConquerDesc,
          mctsDesc,
        },
      ),
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.create_subagents.parameters.name",
            ),
          },
          topology: {
            type: "string",
            enum: [
              TOPOLOGIES.HIERARCHICAL,
              TOPOLOGIES.HIERARCHICAL_AGGREGATION,
              TOPOLOGIES.SEQUENTIAL,
              TOPOLOGIES.PEER_TO_PEER,
              TOPOLOGIES.TOURNAMENT,
              TOPOLOGIES.CRITIC_LOOP,
              TOPOLOGIES.DIVIDE_AND_CONQUER,
              TOPOLOGIES.MCTS,
            ],
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.create_subagents.parameters.topology",
              {
                hierarchicalLabel,
                hierarchicalAggregationLabel,
                sequentialLabel,
                peerToPeerLabel,
                tournamentLabel,
                criticLoopLabel,
                divideAndConquerLabel,
                mctsLabel,
              },
            ),
          },
          topologyConfig: {
            type: "object",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.create_subagents.parameters.topologyConfig",
            ),
            properties: {
              actorCount: {
                type: "integer",
                description: PromptLocaleService.get(
                  activeLocale,
                  "orchestrator.tools.create_subagents.parameters.actorCount",
                ),
              },
              maxRounds: {
                type: "integer",
                description: PromptLocaleService.get(
                  activeLocale,
                  "orchestrator.tools.create_subagents.parameters.maxRounds",
                ),
              },
              branchFactor: {
                type: "integer",
                description: PromptLocaleService.get(
                  activeLocale,
                  "orchestrator.tools.create_subagents.parameters.branchFactor",
                ),
              },
              maxDepth: {
                type: "integer",
                description: PromptLocaleService.get(
                  activeLocale,
                  "orchestrator.tools.create_subagents.parameters.maxDepth",
                ),
              },
              maxSubtasks: {
                type: "integer",
                description: PromptLocaleService.get(
                  activeLocale,
                  "orchestrator.tools.create_subagents.parameters.maxSubtasks",
                ),
              },
            },
          },
          members: {
            type: "array",
            maxItems: 10,
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.create_subagents.parameters.members",
            ),
            items: {
              type: "object",
              properties: {
                description: {
                  type: "string",
                  description: PromptLocaleService.get(
                    activeLocale,
                    "orchestrator.tools.create_subagents.parameters.memberDescription",
                  ),
                },
                prompt: {
                  type: "string",
                  description: PromptLocaleService.get(
                    activeLocale,
                    "orchestrator.tools.create_subagents.parameters.memberPrompt",
                  ),
                },
                files: {
                  type: "array",
                  items: { type: "string" },
                  description: PromptLocaleService.get(
                    activeLocale,
                    "orchestrator.tools.create_subagents.parameters.memberFiles",
                  ),
                },
                model: {
                  type: "string",
                  description: PromptLocaleService.get(
                    activeLocale,
                    "orchestrator.tools.create_subagents.parameters.memberModel",
                  ),
                },
                agent: {
                  type: "string",
                  description: buildAgentParameterDescription(activeLocale),
                },
              },
              required: ["description", "prompt"],
            },
          },
        },
        required: ["name", "members"],
      },
    },
    {
      name: TOOL_NAMES.SEND_SUBAGENT_MESSAGE,
      emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.SEND_SUBAGENT_MESSAGE],
      description: PromptLocaleService.get(
        activeLocale,
        "orchestrator.tools.send_subagent_message.description",
      ),
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.send_subagent_message.parameters.to",
            ),
          },
          message: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.send_subagent_message.parameters.message",
            ),
          },
        },
        required: ["to", "message"],
      },
    },
    {
      name: TOOL_NAMES.STOP_SUBAGENT,
      emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.STOP_SUBAGENT],
      description: PromptLocaleService.get(
        activeLocale,
        "orchestrator.tools.stop_subagent.description",
      ),
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.stop_subagent.parameters.agent_id",
            ),
          },
        },
        required: ["agent_id"],
      },
    },
    {
      name: TOOL_NAMES.GET_SUBAGENT_OUTPUT,
      emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.GET_SUBAGENT_OUTPUT],
      description: PromptLocaleService.get(
        activeLocale,
        "orchestrator.tools.get_subagent_output.description",
      ),
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.get_subagent_output.parameters.agent_id",
            ),
          },
        },
        required: ["agent_id"],
      },
    },
    {
      name: TOOL_NAMES.DELETE_SUBAGENTS,
      emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.DELETE_SUBAGENTS],
      description: PromptLocaleService.get(
        activeLocale,
        "orchestrator.tools.delete_subagents.description",
      ),
      parameters: {
        type: "object",
        properties: {
          teamName: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.delete_subagents.parameters.teamName",
            ),
          },
        },
        required: ["teamName"],
      },
    },
    {
      name: TOOL_NAMES.RESUME_SUBAGENT,
      emoji: INTERNAL_TOOL_EMOJIS[TOOL_NAMES.RESUME_SUBAGENT],
      description: PromptLocaleService.get(
        activeLocale,
        "orchestrator.tools.resume_subagent.description",
      ),
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.resume_subagent.parameters.agent_id",
            ),
          },
          prompt: {
            type: "string",
            description: PromptLocaleService.get(
              activeLocale,
              "orchestrator.tools.resume_subagent.parameters.prompt",
            ),
          },
        },
        required: ["agent_id", "prompt"],
      },
    },
  ];
}

/** Conversation-message media fields the input resolver can draw from. */
type MediaMessageField = "images" | "audio" | "video" | "pdf" | "documents";

/** Minimal message shape for media-input resolution. */
interface MediaMessage {
  role: string;
  images?: string[];
  audio?: string[];
  video?: string[];
  pdf?: string[];
  documents?: string[];
}

export default class ToolOrchestratorService {
  /**
   * Ensure tool schemas are loaded from tools-api.
   * No-op if already initialized; fetches on-demand otherwise.
   * Eliminates boot-order dependency between prism and tools-api.
   */
  static async ensureSchemas(locale?: string) {
    if (!initialized && Date.now() - lastFetchAttemptTime > TOOL_SCHEMA_FETCH_RETRY_COOLDOWN_MILLISECONDS) {
      logger.info("[ToolOrchestrator] Schemas not loaded — fetching on-demand");
      await fetchSchemas();
    }
    if (locale && locale !== "en" && !localizedClientSchemasCache.has(locale)) {
      await fetchSchemasForLocale(locale);
    }
  }

  /** AI-clean schemas (no endpoint/domain/dataSource) — for LLM tool arrays */
  static getToolSchemas(defaultTopology?: string, locale?: string) {
    const creativeSettings = SettingsService.getCached().creative;
    const textToSpeechProvider =
      creativeSettings?.textToSpeechProvider || "elevenlabs";
    const textToSpeechModel = creativeSettings?.textToSpeechModel || "";

    const localeAISchemas =
      locale && locale !== "en" && localizedAISchemasCache.has(locale)
        ? localizedAISchemasCache.get(locale)!
        : cachedAISchemas;

    const resolvedSchemas = localeAISchemas.map((schema) => {
      if (schema.name !== "synthesize_speech") return schema;

      const parameters = schema.parameters as
        | Record<string, unknown>
        | undefined;
      const properties = parameters?.properties as
        | Record<string, Record<string, unknown>>
        | undefined;
      const voiceDescription = properties?.voice?.description as
        | string
        | undefined;

      if (
        !voiceDescription ||
        !voiceDescription.includes(TTS_VOICE_CATALOG_PLACEHOLDER)
      ) {
        return schema;
      }

      return {
        ...schema,
        parameters: {
          ...parameters,
          properties: {
            ...properties,
            voice: {
              ...properties!.voice,
              description: injectVoiceCatalog(
                voiceDescription,
                textToSpeechProvider,
                textToSpeechModel,
              ),
            },
          },
        },
      };
    });

    const activeLocale =
      locale ||
      (typeof SettingsService.getCached === "function"
        ? SettingsService.getCached().agents?.locale || "en"
        : "en");

    return [
      ...resolvedSchemas,
      ...InternalToolRegistry.getSchemas(activeLocale),
      ...getOrchestratorToolSchemas(defaultTopology, activeLocale),
    ];
  }

  /** Client-facing schemas (with domain/domainKey/dataSource, no endpoint) — for Prism Client UI */
  static getClientToolSchemas(
    defaultTopology?: string,
    locale?: string,
  ): ToolSchemaFull[] {
    if (isResolvingClientSchemas) {
      // Break recursion cycle when internal tool getters (e.g. discover_and_enable_tools)
      // fetch schemas dynamically from this same catalog.
      return cachedClientSchemas;
    }
    isResolvingClientSchemas = true;
    try {
      // Reverse map: display name → domainKey (e.g. "Core Harness Tools" → "core_harness")
      const domainDisplayNameToKey = new Map<string, string>();
      for (const entry of Object.values(DOMAINS)) {
        if (!domainDisplayNameToKey.has(entry.displayName)) {
          domainDisplayNameToKey.set(entry.displayName, entry.key);
        }
      }
      const resolveDomainKey = (domain: string) =>
        domainDisplayNameToKey.get(domain) ||
        domain
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "");

      const activeLocale =
        locale ||
        (typeof SettingsService.getCached === "function"
          ? SettingsService.getCached().agents?.locale || "en"
          : "en");

      // Orchestrator tools are Prism-local — add domain metadata for UI grouping
      const orchestratorClient = getOrchestratorToolSchemas(
        defaultTopology,
        activeLocale,
      ).map((tool) => ({
        ...tool,
        domain: DOMAINS.CORE_ORCHESTRATOR.displayName,
        domainKey: "core_orchestrator",
        system: true,
      }));

      const internalClient = InternalToolRegistry.getClientSchemas(
        activeLocale,
      ).map((tool) => ({
        ...tool,
        domainKey: resolveDomainKey(
          tool.domain || DOMAINS.CORE_HARNESS.displayName,
        ),
        // Internal tools are always-on regardless of display domain (artifact
        // tools group under Creative, MCP tools under MCP) — system:true keeps
        // them out of the client's toggle/disabledTools flow, matching the
        // resolver's PRISM_LOCAL_TOOL_NAMES bypass.
        system: true,
      }));

      const localeClientSchemas =
        activeLocale &&
        activeLocale !== "en" &&
        localizedClientSchemasCache.has(activeLocale)
          ? localizedClientSchemasCache.get(activeLocale)!
          : cachedClientSchemas;

      const clientSchemasEnriched = localeClientSchemas.map((tool) => ({
        ...tool,
        domainKey:
          (tool.domainKey as string) ||
          resolveDomainKey(tool.domain || "Other"),
        system: isCoreDomain(tool.domain || ""),
        ...(TOOL_INPUT_MODALITIES[tool.name] && {
          inputModalities: [...TOOL_INPUT_MODALITIES[tool.name]],
        }),
      }));

      const mcpClient = ToolOrchestratorService.getMCPToolSchemas().map(
        (tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          domain: tool.domain || `Model Context Protocol: ${tool._mcpServer}`,
          domainKey: "mcp",
          system: false,
        }),
      );

      const allTools = [
        ...clientSchemasEnriched,
        ...internalClient,
        ...orchestratorClient,
        ...mcpClient,
      ];

      // Deduplicate by name, prioritizing system:true
      const uniqueTools = new Map<string, ToolSchemaFull>();
      for (const tool of allTools) {
        if (!uniqueTools.has(tool.name) || tool.system) {
          uniqueTools.set(tool.name, tool);
        }
      }

      return Array.from(uniqueTools.values());
    } finally {
      isResolvingClientSchemas = false;
    }
  }

  /** Workspace root paths from tools-api (single source of truth) */
  static getWorkspaceRoots() {
    return cachedWorkspaceRoots;
  }

  /** Primary workspace root (first entry) */
  static getWorkspaceRoot() {
    return cachedWorkspaceRoots[0] || null;
  }



  /**
   * Check if any workspace agent is currently connected to tools-api.
   * Mirrors the same `/admin/config` → `agents[].roots` check used by
   * `GET /workspaces` to set `isAgentServed` on the client.
   */
  static async isWorkspaceAgentConnected(): Promise<boolean> {
    try {
      const configResponse = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
        signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MILLISECONDS),
      });
      if (!configResponse.ok) return false;
      const config = (await configResponse.json()) as ToolsApiConfig & {
        agents?: { roots?: string[] }[];
      };
      const agents = config.agents || [];
      for (const agent of agents) {
        if (agent.roots && agent.roots.length > 0) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Re-fetch workspace roots from tools-api config */
  static async refreshWorkspaceRoots() {
    try {
      const configResponse = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
        signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MILLISECONDS),
      });
      if (configResponse.ok) {
        const config = (await configResponse.json()) as ToolsApiConfig;
        if (Array.isArray(config.workspaceRoots)) {
          cachedWorkspaceRoots = config.workspaceRoots;
        }
      }
    } catch (error: unknown) {
      logger.warn(
        `[ToolOrchestrator] refreshWorkspaceRoots failed: ${getErrorMessage(error)}`,
      );
    }
  }
  static async updateWorkspaceRoots(roots: string[]) {
    const response = await fetch(
      `${TOOLS_SERVICE_URL}/admin/config/workspaces`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roots }),
        signal: AbortSignal.timeout(TOOL_WORKSPACE_UPDATE_TIMEOUT_MILLISECONDS),
      },
    );
    const result = (await response.json()) as ToolsApiConfig & {
      error?: string;
    };
    if (!response.ok)
      throw new Error(result.error || "Failed to update workspace roots");

    // Refresh local cache
    if (Array.isArray(result.workspaceRoots)) {
      cachedWorkspaceRoots = result.workspaceRoots;
    }

    return result;
  }
  static async validateWorkspacePath(path: string) {
    const response = await fetch(
      `${TOOLS_SERVICE_URL}/admin/config/workspaces/validate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
        signal: AbortSignal.timeout(TOOL_WORKSPACE_VALIDATE_TIMEOUT_MILLISECONDS),
      },
    );
    return response.json();
  }

  /**
   * Get the effective workspace root for a session.
   * Returns the worktree path if the session is in an isolated worktree,
   * or the normal workspace root otherwise.


   */
  static getEffectiveWorkspaceRoot(
    agentConversationId: string | null | undefined,
  ) {
    if (agentConversationId && activeWorktrees.has(agentConversationId)) {
      return activeWorktrees.get(agentConversationId)!.worktreePath;
    }
    return cachedWorkspaceRoots[0] || null;
  }
  static getWorktreeState(agentConversationId: string | null | undefined) {
    if (!agentConversationId) return null;
    return activeWorktrees.get(agentConversationId) || null;
  }

  static getToolEmoji(toolName: string): string | null {
    const schema = toolMap.get(toolName);
    if (schema?.emoji) return schema.emoji as string;

    const emojiValue = INTERNAL_TOOL_EMOJIS[toolName];
    if (!emojiValue) return null;

    if (Array.isArray(emojiValue)) {
      return emojiValue[0];
    }
    return emojiValue;
  }

  /**
   * Human-readable label for a tool call, argument-aware when the tool's
   * display metadata names a subject param — "Searching Spotify for
   * \"phonk\"" instead of `search_spotify`. Falls back to the bare verb
   * (trailing preposition trimmed) before args stream in, then to a
   * humanized tool name for tools without display metadata. Stamped on
   * tool_execution SSE frames so consumers (lupos-bot presence, admin
   * live view) never have to render raw snake_case names.
   */
  static getToolLabel(
    toolName: string,
    args: Record<string, unknown> | undefined,
    isActive: boolean,
  ): string {
    const display =
      (toolMap.get(toolName)?.display as ToolDisplayMetadata | undefined) ??
      InternalToolRegistry.getDisplay(toolName);
    const summary = resolveToolDisplaySummary(toolName, args || {}, {
      isActive,
      display,
    });
    if (summary?.verb) {
      return summary.subject
        ? `${summary.verb} ${summary.subject}`
        : summary.verb;
    }
    if (display) {
      const verb = isActive ? display.activeVerb : display.completedVerb;
      return verb.replace(/\s+(for|to|from|in|of|with|on|about)$/i, "");
    }
    return humanizeToolName(toolName);
  }

  static getToolFields(toolName: string) {
    const tool = cachedAISchemas.find((tool) => tool.name === toolName);
    if (!tool) return null;
    const params = tool.parameters as Record<string, unknown> | undefined;
    const props = params?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    return (props?.fields?.items as Record<string, unknown>)?.enum || null;
  }

  static async checkApiHealth() {
    const toolNames = cachedSchemas.map((tool) => tool.name);

    let online: boolean;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        TOOL_API_HEALTH_TIMEOUT_MILLISECONDS,
      );
      const response = await fetch(`${TOOLS_SERVICE_URL}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      online = response.ok;
    } catch {
      online = false;
    }

    const apiStatus = { [TOOLS_SERVICE_URL as string]: online };

    const offline = new Set();
    if (!online) {
      for (const name of toolNames) {
        offline.add(name);
      }
    }

    return { offline, apiStatus };
  }

  static async refreshSchemas() {
    await fetchSchemas();
    return cachedSchemas.length;
  }

  static isInitialized() {
    return initialized;
  }

  /**
   * Media-consuming tools → the argument naming their media source and
   * which conversation message fields can satisfy it, in priority order.
   * trim_video also falls back to `images` because Discord clients attach
   * videos through `images[]` (providers handle video natively there).
   * `explicitOnly` marks OPTIONAL media args: they are substituted only
   * when the model explicitly asked for conversation media ('attached'
   * sentinel or an unreproducible data URI) — never when omitted, since
   * omission is the normal case for those tools (e.g. a generate_audio
   * add_channel call for a plain synth channel).
   * `multi` marks array-capable args: the 'attached' sentinel expands to
   * ALL usable attachments on the most recent media-bearing user message
   * (public URLs preferred over base64) instead of just the first one.
   * Names not yet in the shared taxonomy are literals until the next
   * utilities-library taxonomy bump.
   */
  static MEDIA_INPUT_TOOL_ARGS: Record<
    string,
    {
      arg: string;
      fields: MediaMessageField[];
      explicitOnly?: boolean;
      multi?: boolean;
    }
  > = {
    [TOOL_NAMES.CONVERT_IMAGE_TO_ASCII]: { arg: "input", fields: ["images"] },
    [TOOL_NAMES.MANIPULATE_IMAGE]: { arg: "input", fields: ["images"] },
    scan_barcode: { arg: "input", fields: ["images"] },
    read_image_text: { arg: "input", fields: ["images"] },
    detect_objects: { arg: "image", fields: ["images"] },
    remove_background: { arg: "image", fields: ["images"] },
    remix_audio: { arg: "input", fields: ["audio"] },
    transcribe_audio: { arg: "audioUrl", fields: ["audio"] },
    generate_audio: { arg: "sampleSource", fields: ["audio"], explicitOnly: true },
    [TOOL_NAMES.TRIM_VIDEO]: { arg: "url", fields: ["video", "images"] },
    // Document readers (tools-service /agentic/web/*-read + read_csv) —
    // accept http(s) URLs and data: URIs, so uploaded documents resolve
    // directly via the "attached" sentinel or an omitted arg.
    read_pdf: { arg: "url", fields: ["pdf", "documents"] },
    read_docx: { arg: "url", fields: ["documents"] },
    read_spreadsheet: { arg: "url", fields: ["documents"] },
    read_csv: { arg: "source", fields: ["documents"] },
    // Python sandbox — inputFiles is OPTIONAL and multi-valued (array of
    // http(s)/data: strings, or a single string). Python runs constantly
    // without attachments, so files are substituted ONLY on the explicit
    // "attached" sentinel, never on omitted args.
    execute_python: {
      arg: "inputFiles",
      fields: ["documents", "images", "audio", "video", "pdf"],
      explicitOnly: true,
      multi: true,
    },
  };

  /**
   * Resolve the media-source argument of media-consuming tools from
   * conversation context. Clients attach media to messages as raw content
   * (`messages[].images` / `audio` / `video`), so the model can perceive an
   * attachment while having no URL/handle in text to pass as a tool
   * argument. The tool docs allow the model to pass the sentinel
   * "attached" (or omit the arg) and the harness substitutes the most
   * recent attached media here. A model-typed base64 data URI is also
   * replaced — models cannot reproduce base64 faithfully. Anything else
   * the model passes (http URL, imageId from a previous call, workspace
   * path) is respected so chained edit pipelines keep working.
   */
  static resolveMediaInputArg(
    name: string,
    args: Record<string, unknown>,
    messages?: MediaMessage[],
  ): Record<string, unknown> {
    const mapping = ToolOrchestratorService.MEDIA_INPUT_TOOL_ARGS[name];
    if (!mapping || !messages) return args;

    const currentValue = args[mapping.arg];

    // Array-valued media args (execute_python inputFiles) — substitute
    // only explicit sentinel/data: ENTRIES; real URLs/paths are respected.
    if (Array.isArray(currentValue)) {
      return ToolOrchestratorService.resolveMediaInputArrayEntries(
        name,
        args,
        mapping,
        currentValue,
        messages,
      );
    }

    const isExplicitRequest =
      typeof currentValue === "string" &&
      (currentValue.trim().toLowerCase() === "attached" ||
        currentValue.startsWith("data:"));
    const needsResolution = mapping.explicitOnly
      ? isExplicitRequest
      : isExplicitRequest ||
        currentValue == null ||
        (typeof currentValue === "string" && currentValue.trim() === "");
    if (!needsResolution) return args;

    // Multi-capable args expand the sentinel to ALL attachments of the
    // most recent media-bearing user message (public URLs first).
    if (mapping.multi) {
      const allMedia = ToolOrchestratorService.findLastUserMediaAll(
        messages,
        mapping.fields,
      );
      if (allMedia.length > 0) {
        logger.info(
          `[ToolOrchestrator] ${name}: resolving '${mapping.arg}' to ${allMedia.length} attachment(s) from conversation context`,
        );
        return { ...args, [mapping.arg]: allMedia };
      }
    }

    const conversationMedia = ToolOrchestratorService.findLastUserMedia(
      messages,
      mapping.fields,
    );
    if (conversationMedia) {
      logger.info(
        `[ToolOrchestrator] ${name}: resolving '${mapping.arg}' from conversation context (${conversationMedia.startsWith("data:") ? `${(conversationMedia.length / 1024).toFixed(0)} KB base64` : conversationMedia.substring(0, 80)})`,
      );
      return { ...args, [mapping.arg]: conversationMedia };
    }
    if (typeof currentValue === "string" && currentValue.startsWith("data:")) {
      // No conversation media to substitute — let the model-typed data URI
      // through as a last resort rather than dropping the call.
      logger.warn(
        `[ToolOrchestrator] ${name}: no conversation media found; passing model-provided data URI through unchanged`,
      );
      return args;
    }
    logger.warn(
      `[ToolOrchestrator] ${name}: '${mapping.arg}' unresolved (value=${JSON.stringify(currentValue)}) and no ${mapping.fields.join("/")} found on any user message`,
    );
    return args;
  }

  /**
   * Most recent usable media entry (http URL or data URI) attached to a
   * user message, scanning messages backwards and the given fields in
   * priority order within each message. Used to resolve media-source tool
   * arguments the model cannot supply itself — it perceives attachments
   * as raw content but has no text handle for them.
   */
  /**
   * Map a stored media entry to a form tools-api can consume: http(s) and
   * data: pass through; `minio://` storage refs (MediaResolutionService
   * compacts uploads in place) map to their public bucket URL. Returns
   * null for unusable entries.
   */
  static toFetchableMediaUrl(entry: string): string | null {
    if (entry.startsWith("http") || entry.startsWith("data:")) return entry;
    if (entry.startsWith("minio://")) return FileService.getPublicUrl(entry);
    return null;
  }

  static findLastUserMedia(
    messages: MediaMessage[],
    fields: MediaMessageField[],
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      for (const field of fields) {
        const entries = message[field];
        if (!Array.isArray(entries) || entries.length === 0) continue;
        for (const entry of entries) {
          if (typeof entry !== "string") continue;
          const fetchable =
            ToolOrchestratorService.toFetchableMediaUrl(entry);
          if (fetchable) return fetchable;
        }
      }
      // Stop at the most recent user message carrying any of the fields —
      // older messages are stale context, same rule as before.
      if (fields.some((field) => (message[field]?.length ?? 0) > 0)) {
        return null;
      }
    }
    return null;
  }

  /**
   * All usable media entries (http URL or data URI) on the most recent
   * user message carrying any of the given fields — same stop-at-newest
   * rule as findLastUserMedia. Entries are field-priority ordered with
   * public http(s) URLs sorted before data: URIs, since tool payloads
   * prefer lightweight URLs over inlined base64.
   */
  static findLastUserMediaAll(
    messages: MediaMessage[],
    fields: MediaMessageField[],
  ): string[] {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "user") continue;
      if (!fields.some((field) => (message[field]?.length ?? 0) > 0)) continue;
      const usable: string[] = [];
      for (const field of fields) {
        const entries = message[field];
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (typeof entry !== "string") continue;
          const fetchable =
            ToolOrchestratorService.toFetchableMediaUrl(entry);
          if (fetchable) usable.push(fetchable);
        }
      }
      const httpEntries = usable.filter((entry) => entry.startsWith("http"));
      const dataEntries = usable.filter((entry) => !entry.startsWith("http"));
      return [...new Set([...httpEntries, ...dataEntries])];
    }
    return [];
  }

  /**
   * Resolve sentinel/data: entries inside an ARRAY-valued media arg
   * (execute_python inputFiles). "attached" entries expand to all
   * attachments of the most recent media-bearing user message; model-typed
   * data: URIs are replaced with the most recent attachment (models cannot
   * reproduce base64 faithfully). Anything else passes through untouched.
   */
  static resolveMediaInputArrayEntries(
    name: string,
    args: Record<string, unknown>,
    mapping: { arg: string; fields: MediaMessageField[] },
    currentValue: unknown[],
    messages: MediaMessage[],
  ): Record<string, unknown> {
    const isSentinelEntry = (entry: unknown): entry is string =>
      typeof entry === "string" &&
      (entry.trim().toLowerCase() === "attached" || entry.startsWith("data:"));
    if (!currentValue.some(isSentinelEntry)) return args;

    const allMedia = ToolOrchestratorService.findLastUserMediaAll(
      messages,
      mapping.fields,
    );
    if (allMedia.length === 0) {
      logger.warn(
        `[ToolOrchestrator] ${name}: '${mapping.arg}' contains the "attached" sentinel but no ${mapping.fields.join("/")} found on any user message`,
      );
      return args;
    }
    const resolved: unknown[] = [];
    for (const entry of currentValue) {
      if (isSentinelEntry(entry) && entry.trim().toLowerCase() === "attached") {
        resolved.push(...allMedia);
      } else if (isSentinelEntry(entry)) {
        resolved.push(allMedia[0]);
      } else {
        resolved.push(entry);
      }
    }
    const deduped = [...new Set(resolved)];
    logger.info(
      `[ToolOrchestrator] ${name}: resolved '${mapping.arg}' array entries from conversation context (${deduped.length} value(s))`,
    );
    return { ...args, [mapping.arg]: deduped };
  }

  /**
   * Normalize a reference-image entry to a form the tools-api /creative
   * routes accept (http(s) or data: URL). Conversation storage holds
   * `minio://` refs (MediaResolutionService compacts uploads in place
   * before the provider call), and tools-api has no MinIO access — so
   * those must be inlined as base64 here. Returns null for unusable
   * entries.
   */
  static async resolveReferenceImageEntry(
    reference: string,
  ): Promise<string | null> {
    if (
      reference.startsWith("http://") ||
      reference.startsWith("https://") ||
      reference.startsWith("data:")
    ) {
      return reference;
    }
    if (reference.startsWith("minio://")) {
      // Prefer the lightweight public bucket URL (same contract as document
      // references); inline base64 only when no public URL is configured.
      const publicUrl = FileService.getPublicUrl(reference);
      if (publicUrl) return publicUrl;
      try {
        const key = FileService.extractKey(reference);
        const file = await FileService.getFile(key);
        if (!file) return null;
        const chunks: Buffer[] = [];
        for await (const chunk of file.stream) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        return `data:${file.contentType};base64,${buffer.toString("base64")}`;
      } catch (error: unknown) {
        logger.warn(
          `[ToolOrchestrator] failed to resolve minio image ref ${reference.substring(0, 80)}: ${getErrorMessage(error)}`,
        );
        return null;
      }
    }
    return null;
  }

  /**
   * Parse the ordered per-image labels out of a message's
   * `<attached-reference-images>` block. Platforms (lupos-bot) build the
   * block index-aligned with the message's `images[]` array — entry N
   * describes images[N-1] — so the returned `labels` array maps by
   * position. `labelByUrl` additionally maps the block's http(s) URL
   * lines back to their labels, so agent-copied reference URLs can be
   * labeled too. Without this mapping the tools-api image model receives
   * the references as an anonymous pile and binds prompt names to faces
   * by guesswork (observed live: group portraits labeling the wrong
   * people).
   */
  static parseReferenceImageLabels(content: unknown): {
    labels: string[];
    labelByUrl: Map<string, string>;
  } {
    const labels: string[] = [];
    const labelByUrl = new Map<string, string>();
    if (typeof content !== "string") return { labels, labelByUrl };
    // Take the LAST block — it is appended after the message envelope and
    // reflects the images actually attached to this message.
    const blocks = content.match(
      /<attached-reference-images>([\s\S]*?)<\/attached-reference-images>/g,
    );
    if (!blocks || blocks.length === 0) return { labels, labelByUrl };
    const block = blocks[blocks.length - 1];
    let currentIndex = -1;
    for (const line of block.split("\n")) {
      const entryMatch = line.match(/^(\d+)\.\s+(.*\S)\s*$/);
      if (entryMatch) {
        currentIndex = parseInt(entryMatch[1], 10) - 1;
        if (currentIndex >= 0) labels[currentIndex] = entryMatch[2];
        continue;
      }
      const urlMatch = line.match(/^\s+URL:\s+(https?:\/\/\S+)\s*$/);
      if (urlMatch && currentIndex >= 0 && labels[currentIndex]) {
        labelByUrl.set(urlMatch[1], labels[currentIndex]);
      }
    }
    return { labels, labelByUrl };
  }

  static async executeTool(
    name: string,
    args: Record<string, unknown> = {},
    context: ToolExecutionContext = {},
  ) {
    // ── Internal tools — delegated to InternalToolRegistry ──────
    if (InternalToolRegistry.has(name)) {
      return InternalToolRegistry.execute(name, args, {
        ...context,
        agentConversationId: context.agentConversationId || undefined,
        project: context.project || undefined,
        username: context.username || undefined,
      });
    }

    // Route orchestrator tools to OrchestratorService (Prism-local)
    if (ORCHESTRATOR_ONLY_TOOLS.includes(name)) {
      return ToolOrchestratorService.executeOrchestratorTool(
        name,
        args,
        context,
      );
    }

    // Route MCP tools to MCPClientService — thread the loop's abort signal
    // so user stops / per-tool timeouts actually cancel the in-flight call.
    if (MCPClientService.isMCPTool(name)) {
      return ToolOrchestratorService.executeMCPTool(name, args, {
        signal: context.signal,
      });
    }

    // Intercept search_tools to merge MCP tool results from connected servers.
    // Tools-api only knows about its own catalog — MCP tools live in Prism's
    // MCPClientService memory and must be merged locally.
    if (name === TOOL_NAMES.SEARCH_TOOLS) {
      return ToolOrchestratorService.executeSearchToolsWithMCP(args, context);
    }

    // Inject reference images from conversation context into generate_image args.
    // The tools-api endpoint needs these as explicit args since it doesn't have
    // access to Prism's conversation messages.
    // IMPORTANT: Only extract from the LAST user message to avoid collecting
    // stale images from conversation history.
    // The agent may ALSO pass referenceImages explicitly (e.g. a participant's
    // avatar URL when the platform didn't attach it) — those are kept and the
    // conversation-attached images are unioned in behind them.
    if (name === TOOL_NAMES.GENERATE_IMAGE && context.messages) {
      const rawAgentReferences = Array.isArray(
        (args as { referenceImages?: unknown }).referenceImages,
      )
        ? (
            (args as { referenceImages: unknown[] }).referenceImages
          ).filter((image): image is string => typeof image === "string")
        : [];
      const agentProvidedReferences: string[] = [];
      // Keep the agent's original entries index-aligned with the resolved
      // ones so block labels (keyed by original http URL) can be matched.
      const agentProvidedOriginals: string[] = [];
      for (const image of rawAgentReferences) {
        const resolved =
          await ToolOrchestratorService.resolveReferenceImageEntry(image);
        if (resolved && !agentProvidedReferences.includes(resolved)) {
          agentProvidedReferences.push(resolved);
          agentProvidedOriginals.push(image);
        }
      }
      const referenceImages: string[] = [...agentProvidedReferences];
      // Per-image labels aligned with referenceImages — preserves the
      // name↔face binding through to the image model (empty = unlabeled).
      const referenceLabels: string[] = agentProvidedReferences.map(() => "");
      // Find the last user message with images
      for (let i = context.messages.length - 1; i >= 0; i--) {
        const message = context.messages[i];
        if (
          message.role === "user" &&
          message.images &&
          Array.isArray(message.images) &&
          message.images.length > 0
        ) {
          logger.info(
            `[ToolOrchestrator] generate_image: found ${message.images.length} image(s) on last user message`,
          );
          // Entry N of the message's <attached-reference-images> block
          // describes images[N-1]; the URL map labels agent-copied refs.
          const { labels: blockLabels, labelByUrl } =
            ToolOrchestratorService.parseReferenceImageLabels(message.content);
          for (let agentIndex = 0; agentIndex < agentProvidedReferences.length; agentIndex++) {
            referenceLabels[agentIndex] =
              labelByUrl.get(agentProvidedOriginals[agentIndex]) ||
              labelByUrl.get(agentProvidedReferences[agentIndex]) ||
              "";
          }
          for (let imageIndex = 0; imageIndex < message.images.length; imageIndex++) {
            const image = message.images[imageIndex];
            if (typeof image !== "string") {
              logger.warn(
                `[ToolOrchestrator] generate_image: REJECTED image ref (type=${typeof image})`,
              );
              continue;
            }
            if (referenceImages.includes(image)) {
              // Already provided explicitly by the agent — backfill its
              // label from the block if the URL match didn't cover it.
              const existingIndex = referenceImages.indexOf(image);
              if (!referenceLabels[existingIndex] && blockLabels[imageIndex]) {
                referenceLabels[existingIndex] = blockLabels[imageIndex];
              }
              continue;
            }
            const resolved =
              await ToolOrchestratorService.resolveReferenceImageEntry(image);
            if (resolved && !referenceImages.includes(resolved)) {
              referenceImages.push(resolved);
              referenceLabels.push(blockLabels[imageIndex] || "");
              logger.info(
                `[ToolOrchestrator] generate_image: accepted image ref (${image.substring(0, 80)}...)`,
              );
            } else if (!resolved) {
              logger.warn(
                `[ToolOrchestrator] generate_image: REJECTED image ref (prefix=${image.substring(0, 30)})`,
              );
            }
          }
          break; // Only check the last user message
        }
      }
      if (referenceImages.length > 0) {
        args = { ...args, referenceImages };
        if (referenceLabels.some((label) => label)) {
          args = { ...args, referenceLabels };
        }
        logger.info(
          `[ToolOrchestrator] generate_image: injecting ${referenceImages.length} reference image(s) into tool args (${agentProvidedReferences.length} agent-provided, ${referenceLabels.filter((label) => label).length} labeled)`,
        );
      } else if (
        (args as { referenceImages?: unknown }).referenceImages !== undefined
      ) {
        // Agent passed something but nothing survived validation — strip the
        // arg so the route doesn't receive malformed entries.
        const { referenceImages: _invalid, ...rest } = args as Record<
          string,
          unknown
        >;
        args = rest;
        logger.warn(
          `[ToolOrchestrator] generate_image: agent-provided referenceImages had no valid entries — stripped`,
        );
      } else {
        logger.info(
          `[ToolOrchestrator] generate_image: no reference images found in conversation`,
        );
      }
    }

    // Resolve the media-source argument of media-consuming tools from
    // conversation context (see resolveMediaInputArg).
    args = ToolOrchestratorService.resolveMediaInputArg(
      name,
      args,
      context.messages,
    );

    // Inject the user's attached image as a texture URL or default image URL.
    // Models cannot reproduce base64 data in tool arguments — they see the image in
    // conversation context but have no mechanism to pass it into the deeply-nested
    // properties. Resolve the image to a browser-loadable data URL
    // and inject it as a top-level reference argument.
    const THREE_DIMENSIONAL_TEXTURE_TOOLS = ["create_3d_scene"];
    const VECTOR_ANIMATION_TOOLS = ["create_vector_animation"];
    const isThreeDimensionalTextureTool =
      THREE_DIMENSIONAL_TEXTURE_TOOLS.includes(name);
    const isVectorAnimationTool = VECTOR_ANIMATION_TOOLS.includes(name);

    if (
      (isThreeDimensionalTextureTool || isVectorAnimationTool) &&
      context.messages
    ) {
      for (
        let messageIndex = context.messages.length - 1;
        messageIndex >= 0;
        messageIndex--
      ) {
        const message = context.messages[messageIndex];
        if (
          message.role === "user" &&
          message.images &&
          Array.isArray(message.images) &&
          message.images.length > 0
        ) {
          const imageReference = message.images[0];
          if (typeof imageReference === "string") {
            let resolvedImageUrl: string | null = null;

            if (imageReference.startsWith("data:")) {
              resolvedImageUrl = imageReference;
              logger.info(
                `[ToolOrchestrator] ${name}: using data URL as image (${(imageReference.length / 1024).toFixed(0)} KB)`,
              );
            } else if (imageReference.startsWith("minio://")) {
              try {
                const FileService = (await import("#src/services/FileService")).default;
                const key = FileService.extractKey(imageReference);
                const file = await FileService.getFile(key);
                if (file) {
                  const chunks: Buffer[] = [];
                  for await (const chunk of file.stream) {
                    chunks.push(chunk);
                  }
                  const buffer = Buffer.concat(chunks);
                  const base64 = buffer.toString("base64");
                  resolvedImageUrl = `data:${file.contentType};base64,${base64}`;
                  logger.info(
                    `[ToolOrchestrator] ${name}: resolved minio ref to data URL image (${(resolvedImageUrl.length / 1024).toFixed(0)} KB)`,
                  );
                }
              } catch (error: unknown) {
                logger.warn(
                  `[ToolOrchestrator] ${name}: failed to resolve minio image: ${getErrorMessage(error)}`,
                );
              }
            } else if (
              imageReference.startsWith("http://") ||
              imageReference.startsWith("https://")
            ) {
              resolvedImageUrl = imageReference;
              logger.info(
                `[ToolOrchestrator] ${name}: using HTTP URL as image (${imageReference.substring(0, 80)})`,
              );
            }

            if (resolvedImageUrl) {
              if (isThreeDimensionalTextureTool) {
                args = { ...args, referenceTextureUrl: resolvedImageUrl };
                logger.info(
                  `[ToolOrchestrator] ${name}: injected referenceTextureUrl into tool args`,
                );
              } else if (isVectorAnimationTool) {
                args = { ...args, referenceImageUrl: resolvedImageUrl };
                logger.info(
                  `[ToolOrchestrator] ${name}: injected referenceImageUrl into tool args`,
                );
              }
            }
          }
          break;
        }
      }
    }

    const result = await executeToolGeneric(name, args, context);

    // Post-process: upload generated images to MinIO
    const imageResult = result as GenerateImageToolResult;
    if (
      name === TOOL_NAMES.GENERATE_IMAGE &&
      imageResult.image &&
      !imageResult.error
    ) {
      try {
        const FileService = (await import("#src/services/FileService")).default;
        const image = imageResult.image;
        const dataUrl = `data:${image.mimeType || "image/png"};base64,${image.data}`;
        const { ref } = await FileService.uploadFile(
          dataUrl,
          FILE_CATEGORIES.GENERATIONS,
          context.project || null,
          context.username || null,
        );
        image.minioRef = ref;
      } catch (error: unknown) {
        logger.warn(
          `[ToolOrchestrator] Image MinIO upload failed: ${getErrorMessage(error)}`,
        );
      }
    }

    // Post-process: upload browser screenshots to MinIO
    const browserResult = result as BrowserActionToolResult;
    if (
      name === TOOL_NAMES.BROWSER_ACTION &&
      browserResult.screenshot &&
      !browserResult.error
    ) {
      try {
        const FileService = (await import("#src/services/FileService")).default;
        const dataUrl = `data:${browserResult.mimeType || "image/png"};base64,${browserResult.screenshot}`;
        const { ref } = await FileService.uploadFile(
          dataUrl,
          FILE_CATEGORIES.SCREENSHOTS,
          context.project || null,
          context.username || null,
        );
        browserResult.screenshotRef = ref;
        delete browserResult.screenshot;
      } catch (error: unknown) {
        logger.warn(
          `[ToolOrchestrator] Screenshot MinIO upload failed: ${getErrorMessage(error)}`,
        );
      }
    }

    // Register visual outputs (display{kind,url} media/embeds, generated
    // images) in the artifacts gallery. Fire-and-forget — never blocks or
    // fails the tool call.
    if (name !== TOOL_NAMES.BROWSER_ACTION) {
      const { default: ArtifactsService } = await import(
        "#src/services/ArtifactsService"
      );
      ArtifactsService.captureToolResult(name, result, {
        project: context.project,
        username: context.username,
        agent: context.agent,
        conversationId: context.conversationId,
        agentConversationId: context.agentConversationId,
      });
    }

    return result;
  }

  /**
   * Execute a orchestrator tool (create_subagents, send_subagent_message, stop_subagent).
   * These are Prism-local — they dispatch to OrchestratorService in-process.
   */
  static async executeOrchestratorTool(
    name: string,
    args: Record<string, unknown> = {},
    context: ToolExecutionContext = {},
  ) {
    const { default: OrchestratorService } =
      await import("#src/services/OrchestratorService");

    // Build orchestratorContext from the loop's context
    const orchestratorContext = {
      project: context.project,
      username: context.username,
      agent: context.agent,
      providerName: context._providerName,
      resolvedModel: context._resolvedModel,
      agentConversationId: context.agentConversationId,
      conversationId: context.conversationId,
      traceId: context.traceId,
      workspaceRoot: context.workspaceRoot || null,
      workspaceEnabled: context._workspaceEnabled !== false,

      // Pass the parent's emit so sub-agents can forward live events
      emit: context._emit || null,

      // User-configured max iterations for sub-agents
      maxSubAgentIterations: context._maxSubAgentIterations,

      // Inherit context window size so sub-agents load with the same context
      minContextLength: context._minContextLength,

      // Inherit the exact list of tools enabled in the parent context
      enabledTools: context.enabledTools || null,

      // Topology to use for sub-agent coordination
      topology: context._topology || null,

      // Recursive spawning depth tracking — propagated from parent context
      recursionDepth: context._recursionDepth ?? 0,
      maxRecursionDepth: context._maxRecursionDepth,

      // Inherit parent's thinking/reasoning settings so sub-agents use the same mode
      thinkingEnabled: context._thinkingEnabled,
      reasoningEffort: context._reasoningEffort,
      thinkingBudget: context._thinkingBudget,

      // Inherit the parent's approval mode, policies, critic settings, and
      // cost budget — sub-agents must run under the same safety envelope as
      // the loop that spawned them.
      autoApprove: context._autoApprove === true,
      policies: context._policies,
      enableCriticGate: context._enableCriticGate,
      criticModel: context._criticModel,
      maxCostDollars: context._maxCostDollars,
      sharedCostBudget: context._sharedCostBudget,
    };

    switch (name) {
      case TOOL_NAMES.CREATE_SUBAGENT: {
        // Wrap flat singular args into the createTeam format (single member, no topology)
        const singularArgs = args as { description?: string; prompt?: string; files?: string[]; model?: string; agent?: string };
        const teamName = (singularArgs.description || "subagent").toLowerCase().replace(/\s+/g, "_").slice(0, 32);
        const wrappedArgs = {
          name: teamName,
          members: [{
            description: singularArgs.description,
            prompt: singularArgs.prompt,
            files: singularArgs.files,
            model: singularArgs.model,
            agent: singularArgs.agent,
          }],
        };
        const singleResult = await OrchestratorService.createTeam(
          wrappedArgs as unknown as { name: string; members: TeamMember[] },
          orchestratorContext as OrchestratorContext,
        );

        const singleCallerDepth = orchestratorContext.recursionDepth ?? 0;
        if (singleCallerDepth > 0) {
          return singleResult;
        }

        const hasSingleRunning = Array.isArray(singleResult) && singleResult.some(
          (agentResult) => "status" in agentResult && agentResult.status === "running",
        );

        if (!hasSingleRunning) {
          return singleResult;
        }

        return {
          _directive: AGENT_DIRECTIVES.NON_BLOCKING_DISPATCH,
          instruction: "Sub-agent is running in the background. You will be automatically notified with a [SUB-AGENT TEAM COMPLETED] message when it finishes. END YOUR TURN NOW — do not call get_subagent_output or delay_execution. Simply respond to the user that the sub-agent has been dispatched and you will report back when it completes.",
          agents: singleResult,
        };
      }

      case TOOL_NAMES.CREATE_SUBAGENTS: {
        const createTeamResults = await OrchestratorService.createTeam(
          args as unknown as { name: string; members: TeamMember[]; topology?: string },
          orchestratorContext as OrchestratorContext,
        );

        // Sub-agents (recursionDepth > 0) use blocking create_subagents — the
        // results are already complete, so return them directly without
        // the non-blocking directive.
        const callerRecursionDepth = orchestratorContext.recursionDepth ?? 0;
        if (callerRecursionDepth > 0) {
          return createTeamResults;
        }

        // Check if all results are errors (validation failures, depth limit, etc.)
        // In that case, return the raw errors without the non-blocking directive.
        const hasRunningAgents = Array.isArray(createTeamResults) && createTeamResults.some(
          (agentResult) => "status" in agentResult && agentResult.status === "running",
        );

        if (!hasRunningAgents) {
          return createTeamResults;
        }

        // Wrap with a stop directive so the LLM knows to end its turn
        // instead of polling get_subagent_output in a loop.
        return {
          _directive: AGENT_DIRECTIVES.NON_BLOCKING_DISPATCH,
          instruction: "Sub-agents are running in the background. You will be automatically notified with a [SUB-AGENT TEAM COMPLETED] message when they finish. END YOUR TURN NOW — do not call get_subagent_output or delay_execution. Simply respond to the user that the sub-agents have been dispatched and you will report back when they complete.",
          agents: createTeamResults,
        };
      }

      case TOOL_NAMES.SEND_SUBAGENT_MESSAGE:
        return OrchestratorService.sendMessage(
          args.to as string,
          args.message as string,
          orchestratorContext as OrchestratorContext,
        );

      case TOOL_NAMES.STOP_SUBAGENT:
        return OrchestratorService.stopAgent(args.agent_id as string);

      case TOOL_NAMES.GET_SUBAGENT_OUTPUT:
        return OrchestratorService.getTaskOutput(args.agent_id as string);

      case TOOL_NAMES.DELETE_SUBAGENTS:
        return OrchestratorService.deleteTeam(
          args.teamName as string,
          orchestratorContext as OrchestratorContext,
        );

      case TOOL_NAMES.RESUME_SUBAGENT:
        return OrchestratorService.resumeAgent(
          args.agent_id as string,
          args.prompt as string,
          orchestratorContext as OrchestratorContext,
        );

      default:
        return { error: `Unknown orchestrator tool: ${name}` };
    }
  }

  /**
   * Execute a tool on an MCP server.
   * Parses the namespaced tool name and delegates to MCPClientService.
   */
  static async executeMCPTool(
    fullName: string,
    args: Record<string, unknown> = {},
    options: { signal?: AbortSignal; timeoutMilliseconds?: number } = {},
  ) {
    const parsed = MCPClientService.parseMCPToolName(fullName);
    if (!parsed) {
      return { error: `Invalid MCP tool name: ${fullName}` };
    }
    return MCPClientService.callTool(
      parsed.serverName,
      parsed.toolName,
      args,
      options,
    );
  }
  static getMCPToolSchemas() {
    return MCPClientService.getToolSchemas();
  }

  /**
   * Execute search_tools with MCP tool merging.
   * Calls tools-api for the built-in catalog search, then scores connected
   * MCP server tools locally using the same heuristics as AgenticToolSearchService
   * and merges them into a unified result set.
   */
  static async executeSearchToolsWithMCP(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<TransformedSearchToolsResult> {
    const toolsApiResult = (await executeToolGeneric(
      TOOL_NAMES.SEARCH_TOOLS,
      args,
      context,
    )) as unknown as TransformedSearchToolsResult;

    // Scope results to the calling persona's reachable universe — matches
    // on the persona denylist are dropped so a scoped agent never sees
    // tools it cannot enable. Applied before the MCP merge so every
    // return path below carries the filtered set.
    const scopePersona = context.agent
      ? AgentPersonaRegistry.get(context.agent)
      : null;
    if (
      isScopedPersona(scopePersona) &&
      Array.isArray(toolsApiResult?.matches)
    ) {
      const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
      // "recipe:*" matches are advisory multi-tool plans, not enableable
      // tools — they bypass name-based partitioning, but a recipe whose
      // REQUIRED tools fall outside the persona's universe is dropped:
      // a plan the persona cannot execute is worse than no plan.
      const recipeRequiredTools = toolsApiResult.matches
        .filter((matchEntry) =>
          (matchEntry.name as string).startsWith("recipe:"),
        )
        .flatMap(
          (matchEntry) =>
            ((matchEntry as { recipe?: { requiredTools?: string[] } }).recipe
              ?.requiredTools ?? []),
        );
      const { blocked } = partitionByDiscoverableUniverse(
        scopePersona,
        clientSchemas,
        [
          ...toolsApiResult.matches
            .map((matchEntry) => matchEntry.name as string)
            .filter((name) => !name.startsWith("recipe:")),
          ...recipeRequiredTools,
        ],
      );
      if (blocked.length > 0) {
        const blockedSet = new Set(blocked);
        const matchCountBeforeFilter = toolsApiResult.matches.length;
        toolsApiResult.matches = toolsApiResult.matches.filter(
          (matchEntry) => {
            const entryName = matchEntry.name as string;
            if (entryName.startsWith("recipe:")) {
              const requiredTools =
                (matchEntry as { recipe?: { requiredTools?: string[] } })
                  .recipe?.requiredTools ?? [];
              return !requiredTools.some((toolName) =>
                blockedSet.has(toolName),
              );
            }
            return !blockedSet.has(entryName);
          },
        );
        const removedCount =
          matchCountBeforeFilter - toolsApiResult.matches.length;
        if (typeof toolsApiResult.total === "number") {
          toolsApiResult.total = Math.max(
            0,
            toolsApiResult.total - removedCount,
          );
        }
        logger.info(
          `[ToolOrchestrator] search_tools: agent=${context.agent} filtered ${removedCount} out-of-universe matches`,
        );
      }
    }

    const mcpSchemas = MCPClientService.getToolSchemas();
    if (mcpSchemas.length === 0) return toolsApiResult;

    const queryText = typeof args.query === "string" ? args.query.trim() : "";
    const domainFilter =
      typeof args.domain === "string" ? args.domain.toLowerCase() : null;
    const limit =
      typeof args.limit === "number"
        ? Math.min(Math.max(1, args.limit), 50)
        : 20;

    if (!queryText && !domainFilter) return toolsApiResult;

    // Filter MCP schemas by domain when a domain filter is specified
    let candidateSchemas = mcpSchemas;
    if (domainFilter) {
      candidateSchemas = mcpSchemas.filter((schema) => {
        const schemaDomain = (
          schema.domain || `Model Context Protocol: ${schema._mcpServer}`
        ).toLowerCase();
        return (
          schemaDomain === domainFilter || schemaDomain.includes(domainFilter)
        );
      });
    }

    // Score matches using BM25 over name + description + parameter names
    const searchIndex = new Bm25ToolIndex(candidateSchemas);
    const indexResults = searchIndex.search(queryText, limit);

    if (indexResults.length === 0) return toolsApiResult;

    // Build enabled set for isEnabled annotation (mirrors AgenticToolSearchService)
    const enabledToolsArray = context.enabledTools;
    const hasEnabledContext =
      Array.isArray(enabledToolsArray) &&
      enabledToolsArray.length > 0 &&
      !enabledToolsArray.includes("*");
    const enabledToolsSet = hasEnabledContext
      ? new Set(enabledToolsArray)
      : null;

    let mcpMatches = indexResults.map((matchEntry) => ({
      name: matchEntry.document.name,
      description: matchEntry.document.description,
      domain:
        matchEntry.document.domain ||
        `Model Context Protocol: ${(matchEntry.document as unknown as Record<string, unknown>)._mcpServer}`,
      parameters: matchEntry.document.parameters || null,
      ...(enabledToolsSet && {
        isEnabled: enabledToolsSet.has(matchEntry.document.name),
      }),
    }));

    // Same persona universe scoping for MCP matches as for catalog matches.
    if (isScopedPersona(scopePersona) && mcpMatches.length > 0) {
      const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
      const { blocked } = partitionByDiscoverableUniverse(
        scopePersona,
        clientSchemas,
        mcpMatches.map((matchEntry) => matchEntry.name),
      );
      if (blocked.length > 0) {
        const blockedSet = new Set(blocked);
        mcpMatches = mcpMatches.filter(
          (matchEntry) => !blockedSet.has(matchEntry.name),
        );
      }
    }

    const existingMatches = Array.isArray(toolsApiResult.matches)
      ? (toolsApiResult.matches as TransformedSearchToolsResult["matches"])
      : [];
    const existingTotal =
      typeof toolsApiResult.total === "number"
        ? toolsApiResult.total
        : existingMatches.length;
    const mergedMatches = [...existingMatches, ...mcpMatches].slice(0, limit);

    const hasDisabledMcpMatches =
      enabledToolsSet &&
      mcpMatches.some((matchEntry) => !enabledToolsSet.has(matchEntry.name));

    return {
      ...toolsApiResult,
      matches: mergedMatches,
      total: existingTotal + indexResults.length,
      ...(hasDisabledMcpMatches &&
        !toolsApiResult.action_required &&
        !toolsApiResult.actionRequired &&
        (() => {
          const nudgeText = PromptLocaleService.get(
            PromptLocaleService.getDefaultLocale(),
            "internal-tools-runtime.shared.searchActionNudgeDisabled",
          );
          return {
            actionRequired: nudgeText,
            action_required: nudgeText,
          };
        })()),
    };
  }

  /**
   * Map of tool names to their streaming SSE endpoint paths.
   * Only process-based tools that spawn subprocesses benefit from streaming.
   */
  static STREAMABLE_TOOLS: Record<string, string> = {
    [TOOL_NAMES.EXECUTE_SHELL]: "/compute/shell/stream",
    [TOOL_NAMES.EXECUTE_PYTHON]: "/utility/python/stream",
    [TOOL_NAMES.EXECUTE_JAVASCRIPT]: "/compute/js/stream",
    [TOOL_NAMES.RUN_COMMAND]: "/agentic/command/stream",
  };

  static isStreamable(toolName: string) {
    return toolName in ToolOrchestratorService.STREAMABLE_TOOLS;
  }

  /**
   * Execute a tool using the streaming SSE endpoint.
   * Calls `onChunk(event, data)` for each stdout/stderr chunk.
   * Returns the full result as a JSON object (same shape as executeTool).
   */
  static async executeToolStreaming(
    name: string,
    args: Record<string, unknown> = {},
    onChunk:
      | ((
          event: string,
          data: string | null,
          meta?: Record<string, unknown>,
        ) => void)
      | null,
    context: ToolExecutionContext = {},
  ) {
    const streamPath = ToolOrchestratorService.STREAMABLE_TOOLS[name];
    if (!streamPath) {
      return ToolOrchestratorService.executeTool(name, args, context);
    }

    const remaps = ARG_REMAPS[name as keyof typeof ARG_REMAPS];
    let resolvedArgs: Record<string, unknown> = args;
    if (remaps) {
      resolvedArgs = { ...args };
      for (const [from, to] of Object.entries(remaps)) {
        if (resolvedArgs[from] !== undefined) {
          resolvedArgs[to] = resolvedArgs[from];
          delete resolvedArgs[from];
        }
      }
    }

    const url = `${TOOLS_SERVICE_URL}${streamPath}`;
    const contextHeaders = buildContextHeaders(context);

    try {
      // Combine session abort signal with a 65s timeout.
      // If the user cancels the session, the fetch aborts immediately.
      // If 65s elapses, the fetch aborts via timeout.
      const controller = createAbortController();
      const timeout = setTimeout(() => controller.abort(), TOOL_PROXY_TIMEOUT_MILLISECONDS); // generous timeout

      // If session signal exists, abort the local controller when session aborts
      if (context.signal && !context.signal.aborted) {
        const onSessionAbort = () => controller.abort();
        context.signal.addEventListener("abort", onSessionAbort, {
          once: true,
        });
        // Clean up listener when controller aborts from timeout (not session)
        controller.signal.addEventListener(
          "abort",
          () => {
            context.signal!.removeEventListener("abort", onSessionAbort);
          },
          { once: true },
        );
      } else if (context.signal?.aborted) {
        controller.abort();
      }

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...contextHeaders },
        body: JSON.stringify(resolvedArgs),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        return {
          error: `API returned ${response.status}: ${response.statusText}`,
        };
      }

      // Parse the SSE stream — accumulate stdout/stderr so the final result
      // includes the full output for persistence (TerminalRenderer reads
      // result.stdout after page refresh when streamingOutput is gone).
      if (!response.body) {
        return { error: "Response body is not readable" };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult = null;
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];

      while (true) {
        const { done: isDone, value } = await reader.read();
        if (isDone) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.event === "stdout") {
              stdoutChunks.push(event.data || "");
              onChunk?.(event.event, event.data);
            } else if (event.event === "stderr") {
              stderrChunks.push(event.data || "");
              onChunk?.(event.event, event.data);
            } else if (event.event === "exit") {
              finalResult = {
                success: event.success,
                stdout: stdoutChunks.join(""),
                stderr: stderrChunks.join(""),
                exitCode: event.exitCode,
                executionTimeMilliseconds: event.executionTimeMilliseconds,
                timedOut: event.timedOut || false,
                ...(event.error && { error: event.error }),
              };
              onChunk?.("exit", null, finalResult);
            } else if (event.event === "start") {
              onChunk?.("start", null, event);
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }

      // If we never got an exit event, return accumulated output anyway
      if (
        !finalResult &&
        (stdoutChunks.length > 0 || stderrChunks.length > 0)
      ) {
        finalResult = {
          success: false,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
          exitCode: null,
          error: "Stream ended without exit event",
        };
      }
      return finalResult || { error: "Stream ended without exit event" };
    } catch (error: unknown) {
      return { error: `Streaming failed: ${getErrorMessage(error)}` };
    }
  }

  static async executeToolCalls(
    toolCalls: Array<{
      name: string;
      id: string;
      args?: Record<string, unknown>;
    }>,
  ) {
    return Promise.all(
      toolCalls.map(async (toolCall) => ({
        name: toolCall.name,
        id: toolCall.id,
        result: await ToolOrchestratorService.executeTool(
          toolCall.name,
          toolCall.args || {},
        ),
      })),
    );
  }

  // ── Worktree State Helpers — used by WorktreeTools.js ──────
  /** @internal */ static _setWorktree(
    agentConversationId: string,
    state: WorktreeState,
  ) {
    activeWorktrees.set(agentConversationId, state);
  }
  /** @internal */ static _clearWorktree(agentConversationId: string) {
    activeWorktrees.delete(agentConversationId);
  }
  /** @internal */ static _resetCaches() {
    cachedSchemas = [];
    cachedAISchemas = [];
    cachedClientSchemas = [];
    localizedClientSchemasCache.clear();
    localizedAISchemasCache.clear();
    localeFetchAttemptTimes.clear();
    toolMap.clear();
    initialized = false;
    lastFetchAttemptTime = 0;
  }
  /** @internal */ static async _proxyPost(
    path: string,
    body: Record<string, unknown>,
    context: ToolExecutionContext,
  ) {
    return fetchJsonWithBody(
      `${TOOLS_SERVICE_URL}${path}`,
      "POST",
      body,
      buildContextHeaders(context),
      context.signal,
    );
  }
}

import { registerGlobalToolOrchestratorService } from "#src/types/GlobalToolOrchestratorRegistry";
registerGlobalToolOrchestratorService(ToolOrchestratorService);
