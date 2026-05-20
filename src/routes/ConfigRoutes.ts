import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response } from "express";
import {
  PROVIDERS,
  PROVIDER_LIST,
  TYPES,
  VOICES,
  DEFAULT_VOICES,
  getModelOptions,
  getDefaultModels,
} from "../config.ts";
import { listInstances } from "../providers/instance-registry.ts";
import { ARENA_SCORES } from "../arrays.ts";
import ToolOrchestratorService from "../services/ToolOrchestratorService.ts";
import AgentPersonaRegistry from "../services/AgentPersonaRegistry.ts";
import rateLimitStore from "../services/RateLimitStore.ts";
import MinioWrapper from "../wrappers/MinioWrapper.ts";
import LocalProviderGateway from "../services/LocalProviderGateway.ts";
import { COORDINATOR_ONLY_TOOLS } from "../services/CoordinatorPrompt.ts";
import {
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  GOOGLE_API_KEY,
  ELEVENLABS_API_KEY,
  INWORLD_BASIC,
  } from "../../config.ts";

const router = express.Router();

// Map cloud providers to their secrets — provider is "available" when secret is truthy
const CLOUD_PROVIDER_SECRETS = {
  [PROVIDERS.OPENAI]: OPENAI_API_KEY,
  [PROVIDERS.ANTHROPIC]: ANTHROPIC_API_KEY,
  [PROVIDERS.GOOGLE]: GOOGLE_API_KEY,
  [PROVIDERS.ELEVENLABS]: ELEVENLABS_API_KEY,
  [PROVIDERS.INWORLD]: INWORLD_BASIC,
};

// Cloud providers available based on API keys
const AVAILABLE_CLOUD = new Set(
  Object.entries(CLOUD_PROVIDER_SECRETS)
        .filter(([, secret]: any) => !!secret)
        .map((([provider]: any) => provider as any as (value: [string, string | undefined], index: number, array: [string, string | undefined][]) => any)),
);

// Local provider instances from the instance registry
const localInstances = listInstances();

// Combined set: cloud providers + all local instance IDs
const AVAILABLE_PROVIDERS = new Set([
  ...AVAILABLE_CLOUD,
    // @ts-ignore - TODO: strict typing
    ...localInstances.map(((inst: any) => inst.id as any as (value: InstanceEntry, index: number, array: InstanceEntry[]) => any)),
]);

/**
 * Resolve enabledTools entries (may contain "label:X" / "domain:X" prefixes)
 * into a flat Set of concrete tool names using client schemas.
 */
function resolveEnabledToolsToSet(enabledTools: any) {
  if (!enabledTools || !Array.isArray(enabledTools)) return new Set();

  // "*" wildcard means all tools — return null sentinel
  if (enabledTools.includes("*")) return null;

  const hasPrefixed = enabledTools.some(
        (e: any) => (e as any).startsWith("label:") || (e as any).startsWith("domain:"),
  );
  if (!hasPrefixed) return new Set(enabledTools);

  const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
  const resolved = new Set();
    for ( const entry of enabledTools) {
    if (entry.startsWith("label:")) {
      const label = entry.slice(6);
            for ( const t of clientSchemas) {
        if (t.labels?.includes(label)) resolved.add(t.name);
      }
    } else if (entry.startsWith("domain:")) {
      const domain = entry.slice(7);
            for ( const t of clientSchemas) {
        if (t.domain === domain) resolved.add(t.name);
      }
    } else {
      resolved.add(entry);
    }
  }
  return resolved;
}

/** Keep only available provider keys in a models map. */
function filterByAvailableProviders(modelsMap: any) {
  const filtered: any = {};
    for ( const [provider, models] of Object.entries(modelsMap)) {
    if (AVAILABLE_PROVIDERS.has((provider as any as (value: [string, string | undefined], index: number, array: [string, string | undefined][]) => any))) {
            filtered[provider] = models;
    }
  }
  return filtered;
}

/** Filter defaults to only include available providers. */
function filterDefaults(defaults: any) {
  const filtered: any = {};
    for ( const [provider, model] of Object.entries(defaults)) {
    if (AVAILABLE_PROVIDERS.has((provider as any as (value: [string, string | undefined], index: number, array: [string, string | undefined][]) => any))) {
            filtered[provider] = model;
    }
  }
  return filtered;
}

/**
 * Look up arena scores for a model name from ARENA_SCORES.
 * Tries exact match first, then checks if an arena entry name
 * is contained within the model name (for versioned names like
 * "claude-haiku-4-5-20251001" matching "claude-haiku-4-5-20251001").
 *
 * Returns an arena object like { text: 1406, code: 1310, ... } or null.
 */
function lookupArenaScores(modelName: any) {
  const arena: any = {};
    const key = (modelName as any).toLowerCase();

  // Strip path prefix (e.g. "google/gemma-3-12b" → "gemma-3-12b")
  // and quantization suffix (e.g. "qwen3-32b@q4_k_m" → "qwen3-32b")
  const stripped = key.includes("/") ? key.split("/").pop() : key;
  const cleaned = stripped.includes("@") ? stripped.split("@")[0] : stripped;

    for ( const [category, scores] of Object.entries(ARENA_SCORES)) {
    if (!scores || typeof scores !== "object") continue;

    let bestMatch = null;
    let bestLen = 0;

        for ( const [arenaName, score] of Object.entries(scores)) {
      const an = arenaName.toLowerCase();

      // Exact match on raw key or cleaned key
      if (key === an || cleaned === an) {
        bestMatch = score;
        break;
      }

      // Check both directions of startsWith/includes using cleaned key
      const matched =
        cleaned.startsWith(an) ||
        an.startsWith(cleaned) ||
        key.includes(an) ||
        an.includes(cleaned);

      if (matched && an.length > bestLen) {
        bestMatch = score;
        bestLen = an.length;
      }
    }

    if (bestMatch !== null) {
            arena[category] = bestMatch;
    }
  }

  return Object.keys(arena).length > 0 ? arena : null;
}

/**
 * Enrich all models in a provider map with arena scores from ARENA_SCORES.
 * Merges with any existing arena data on the model (existing takes priority).
 */
function enrichModelsWithArenaScores(modelsMap: any) {
    for ( const provider of Object.keys(modelsMap)) {
        for ( const model of (modelsMap as any)[provider]) {
      const scores = lookupArenaScores(model.name);
      if (scores) {
        // Merge: existing hardcoded arena data takes priority
        model.arena = { ...scores, ...(model.arena || {}) };
      }
    }
  }
  return modelsMap;
}

// ── Model capability detection ──────────────────────────────────
// Patterns and helpers now live in LocalProviderGateway.
// All local model fetchers (getLmStudioModelOptions, getVllmModelOptions,
// getOllamaModelOptions, getLlamaCppModelOptions) are replaced by
// LocalProviderGateway.discoverModels().

// ── Local provider instance metadata ────────────────────────────
// Built from the instance registry. Model fetching is now delegated
// to LocalProviderGateway.discoverModels() in GET /config-local.
const LOCAL_PROVIDERS = localInstances.map((inst: any) => {
  const entry = {
    key: inst.id,
    type: inst.type,
    instanceNumber: inst.instanceNumber,
    concurrency: inst.concurrency,
  };
    if (inst.nickname) (entry as any).nickname = inst.nickname;
  return entry;
});

/**
 * GET /config
 * Returns the full catalog of providers, models, voices, and capabilities.
 * Cloud providers resolve instantly; local providers are excluded here
 * and served via GET /config/local-models for progressive loading.
 */
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    // Get static model options (cloud-only — no network calls)
    let textToTextModels = getModelOptions(TYPES.TEXT, TYPES.TEXT);
    let textToImageModels = getModelOptions(TYPES.TEXT, TYPES.IMAGE);

    // Enrich ALL model lists with arena scores from the scraped leaderboard data
    enrichModelsWithArenaScores(textToTextModels);
    enrichModelsWithArenaScores(textToImageModels);

    // Filter to only available providers
    textToTextModels = filterByAvailableProviders(textToTextModels);
    textToImageModels = filterByAvailableProviders(textToImageModels);

        const availableProviderList = PROVIDER_LIST.filter((p: any) =>
      AVAILABLE_PROVIDERS.has((p as any as (value: [string, string | undefined], index: number, array: [string, string | undefined][]) => any)),
    );
    const availableProviderMap: any = {};
        for ( const [key, value] of Object.entries(PROVIDERS)) {
            if (AVAILABLE_PROVIDERS.has((value as any as (value: [string, string | undefined], index: number, array: [string, string | undefined][]) => any))) availableProviderMap[key] = value;
    }

    // Build the dynamic Tool Calling system prompt
    const schemas = ToolOrchestratorService.getToolSchemas() || [];
    const toolNames = schemas
            .map(((s: any) => s.name || (s.function as any)?.name as any as (value: any, index: number, array: any[]) => any))
      .filter(Boolean)
      .map((name: string) => {
        return name.replace(/^get_/, "").replace(/_/g, " ");
      });
    const toolList =
      toolNames.length > 0
        ? toolNames.join(", ")
        : "general web search and computation";

    const fcSystemPrompt = `You are a helpful AI assistant with access to real-time data APIs. You have tools for ${toolList}.

Guidelines:
- When asked about weather, events, prices, trends, or similar data, ALWAYS use the appropriate tool to fetch real-time data. Never guess or make up data.
- You may call multiple tools in a single response if the question requires data from multiple sources.
- Present data clearly with relevant formatting — use tables, bullet points, and emojis where appropriate.
- When data includes numbers, format them appropriately (currencies, percentages, temperatures).
- If a tool returns an error, inform the user and suggest alternatives.
- Be conversational and helpful, not just a data dump.
- For questions that don't require API data, respond naturally without tool calls.
- The current local date/time is: {{CURRENT_DATE_TIME}}`;

    // Flag which local provider instances are configured so the client knows to poll
    const localProviders = LOCAL_PROVIDERS.map(
      ({ key, type, instanceNumber, concurrency, nickname }: any) => {
        const entry = { id: key, type, instanceNumber, concurrency };
                if (nickname) (entry as any).nickname = nickname;
        return entry;
      },
    );

    res.json({
      // Direct MinIO URL for resolving minio:// file refs on the client
      // e.g. "http://<host>:9000/prism"
      fileBaseUrl: MinioWrapper.getBucketUrl() || null,
      fcSystemPrompt,
      providers: availableProviderMap,
      providerList: availableProviderList,
      availableProviders: availableProviderList,
      localProviders,
      textToText: {
        models: textToTextModels,
        defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.TEXT)),
      },
      textToSpeech: {
        models: filterByAvailableProviders(
          getModelOptions(TYPES.TEXT, TYPES.AUDIO),
        ),
        defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.AUDIO)),
        voices: VOICES,
        defaultVoices: DEFAULT_VOICES,
      },
      textToImage: {
        models: textToImageModels,
        defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.IMAGE)),
      },
      imageToText: {
        models: filterByAvailableProviders(
          getModelOptions(TYPES.IMAGE, TYPES.TEXT),
        ),
        defaults: filterDefaults(getDefaultModels(TYPES.IMAGE, TYPES.TEXT)),
      },
      embedding: {
        models: filterByAvailableProviders(
          getModelOptions(TYPES.TEXT, TYPES.EMBEDDING),
        ),
        defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)),
      },
      audioToText: {
        models: filterByAvailableProviders(
          getModelOptions(TYPES.AUDIO, TYPES.TEXT),
        ),
        defaults: filterDefaults(getDefaultModels(TYPES.AUDIO, TYPES.TEXT)),
      },
    });
  }),
);

/**
 * GET /config-local
 * Fetches models from local/self-hosted providers (LM Studio, vLLM, Ollama)
 * with a 3-second timeout per provider so unreachable services fail fast.
 * Returns { models: { [provider]: [...] } } for the client to merge.
 * Mounted at /config-local (top-level, not under /config).
 *
 * Delegates all model discovery, normalization, and HF enrichment
 * to LocalProviderGateway.discoverModels(). Arena score enrichment
 * is applied here since it's a config-route concern.
 */
const localConfigRouter = express.Router();
localConfigRouter.get("/", async (_req: Request, res: Response) => {
  const models = await LocalProviderGateway.discoverModels({
    timeoutMs: 3000,
    enrich: true,
  });

  // Enrich each instance's models with arena scores
    for ( const key of Object.keys(models)) {
        const wrapped = { [key]: models[key] };
    enrichModelsWithArenaScores(wrapped);
        models[key] = wrapped[key];
  }

  res.json({ models });
});

export { localConfigRouter };

/**
 * GET /config/agents
 * Returns the list of registered agent personas with metadata for the frontend picker.
 */
router.get("/agents", (_req: Request, res: Response) => {
  const agents = AgentPersonaRegistry.list().map((a: any) => {
        const persona = AgentPersonaRegistry.get((a.id as any));
    const resolvedTools = resolveEnabledToolsToSet(persona?.enabledTools);
    // null sentinel means "*" wildcard → all tools
    const isWildcard = resolvedTools === null;
    return {
      id: a.id,
      name: a.name,
      description: persona?.description || "",
      custom: a.custom || false,
      icon: persona?.icon || "",
      color: persona?.color || "",
      backgroundImage: persona?.backgroundImage || "",
      project: persona?.project,
      toolCount: isWildcard ? -1 : resolvedTools.size,
      enabledToolNames: isWildcard ? ["*"] : [...resolvedTools],
      canSpawnWorkers: COORDINATOR_ONLY_TOOLS.includes("team_create"),
      usesDirectoryTree: persona?.usesDirectoryTree || false,
      usesCodingGuidelines: persona?.usesCodingGuidelines || false,
    };
  });
  res.json(agents);
});

/**
 * GET /config/tools
 * Returns tool schemas. Optionally filter by agent persona via ?agent=CODING.
 */
router.get("/tools", (_req: Request, res: Response) => {
  const schemas = ToolOrchestratorService.getClientToolSchemas() || [];
  const agentId = _req.query.agent;

  if (agentId) {
        const persona = AgentPersonaRegistry.get((agentId as any));
    if (persona?.enabledTools) {
      const enabledSet = resolveEnabledToolsToSet(persona.enabledTools);
      // null = wildcard ("*") → return all schemas unfiltered
      if (enabledSet !== null) {
        return res.json(schemas.filter((t: any) => enabledSet.has(t.name)));
      }
    }
  }

  res.json(schemas);
});

/**
 * POST /config/tools/refresh
 * Re-fetches tool schemas from tools-api and updates the cache.
 * Returns the updated schema count.
 */
router.post(
  "/tools/refresh",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const count = await ToolOrchestratorService.refreshSchemas();
      res.json({ ok: true, count });
    } catch (error: any) {
            res.status(500).json({ error: (error as Error).message });
    }
  }),
);

/**
 * GET /config/rate-limits
 * Returns the latest rate-limit snapshots for all cloud providers.
 * OpenAI and Anthropic update dynamically from API response headers.
 * Google is seeded with static tier-2 limits.
 */
router.get("/rate-limits", (_req: Request, res: Response) => {
  res.json(rateLimitStore.getAll());
});

export default router;
