import {
  getModelRoleChainFromEnvironment,
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  GOOGLE_CLOUD_GEMINI_API_KEY,
  MOONSHOT_API_KEY,
} from "#config";
import { PROVIDERS } from "#src/constants";
import { MODALITY_TYPES, resolveRecommendedDefault } from "#src/config";
import { getProvider } from "#src/providers/index";
import { listInstances } from "#src/providers/instance-registry";
import SettingsService from "#src/services/SettingsService";
import { isTransientProviderError } from "#src/utils/ProviderStreamResilience";
import { ProviderError } from "#src/utils/errors";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// ModelRoleRouter — role-based model routing with fallback chains
// ────────────────────────────────────────────────────────────
// Port of oh-my-pi's model roles: named roles (utility, critic,
// plan, vision, ...) each resolve to an ORDERED fallback chain of
// (provider, model) pairs instead of a single hard-wired knob.
//
// Resolution order per role:
//   0. Agent definitions — a pin in the running agent's definition
//      (`modelRoles.<role>`), custom agents before built-in personas
//      (see routing/AgentModelPins). Only when the caller names agents.
//   1. Explicit env config — MODEL_ROLE_<ROLE>="provider=model,..."
//   2. DB config — the role's SettingsService knob (see ROLE_SETTINGS)
//   3. Caller-supplied fallback (e.g. the conversation's own model)
//   4. Built-in defaults — for `utility`: the first configured local
//      instance (vLLM / LM Studio / Ollama / llama-cpp) with a
//      discoverable model, else the cheapest available cloud model.
//      `critic`, `memory`, `compaction`, `classifier` and `reader` default
//      to the utility chain.
//
// The conversation-level roles (`main`, `subagent`, `oracle`) resolve
// to ONE decision, not a chain: routing/RoleModelResolver.
//
// The `utility` role is NEVER silently disabled: when no explicit
// config exists it degrades to local-instance → cheap-cloud defaults,
// and resolving to an empty chain is logged at error level.
//
// Execution: `runWithChain` advances to the next chain entry on
// transient provider failures (connection refused, 429, 5xx, timeout
// — classified by isTransientProviderError) and on a 400
// `invalid_request_error` (the model rejected the request surface — e.g.
// a sampling parameter or thinking mode it does not accept), with a
// structured log line per advance. Other errors propagate immediately.
// ────────────────────────────────────────────────────────────

export const MODEL_ROLES = {
  DEFAULT: "default",
  UTILITY: "utility",
  CRITIC: "critic",
  PLAN: "plan",
  VISION: "vision",
  /** Memory extraction — its own knob, so it can run cheaper than compaction. */
  MEMORY: "memory",
  /** The model a conversation runs on — decided once, at its start. */
  MAIN: "main",
  /** The model a sub-agent runs on — decided at each spawn. */
  SUBAGENT: "subagent",
  /** A stronger second opinion (prompt 17's ask_oracle consults it). */
  ORACLE: "oracle",
  /** Conversation summarization (CompactionService). */
  COMPACTION: "compaction",
  /** Short labelling calls (prompt 12's auto-mode classifier). */
  CLASSIFIER: "classifier",
  /**
   * The quarantined reader (read_untrusted): a no-tools call that turns
   * untrusted text into schema-valid JSON. A local model by default.
   */
  READER: "reader",
} as const;

/** Roles whose default is the utility chain. */
const UTILITY_DERIVED_ROLES: ReadonlySet<string> = new Set([
  MODEL_ROLES.CRITIC,
  MODEL_ROLES.MEMORY,
  MODEL_ROLES.COMPACTION,
  MODEL_ROLES.CLASSIFIER,
  MODEL_ROLES.READER,
]);

/** Extensible — any string is a valid role; the named ones get defaults. */
export type ModelRole = string;

export interface RoleChainEntry {
  provider: string;
  model: string;
}

export interface ResolveChainOptions {
  /** Appended after env/DB config (e.g. the conversation's own model). */
  fallback?: RoleChainEntry | null;
  /**
   * Agents whose definitions may pin this role (`modelRoles.<role>`),
   * most specific first. Their pins head the chain.
   */
  agents?: Array<string | null | undefined>;
}

/** DB knobs per role: settings section + provider/model field names. */
const ROLE_SETTINGS: Record<
  string,
  { section: string; providerField: string; modelField: string } | undefined
> = {
  [MODEL_ROLES.UTILITY]: {
    section: "memory",
    providerField: "extractionProvider",
    modelField: "extractionModel",
  },
  [MODEL_ROLES.CRITIC]: {
    section: "agents",
    providerField: "criticProvider",
    modelField: "criticModel",
  },
  [MODEL_ROLES.PLAN]: {
    section: "agents",
    providerField: "planProvider",
    modelField: "planModel",
  },
  [MODEL_ROLES.VISION]: {
    section: "creative",
    providerField: "visionProvider",
    modelField: "visionModel",
  },
  // Same knob the utility role reads (Settings → Memory Models). The env
  // override MODEL_ROLE_MEMORY is what moves extraction alone.
  [MODEL_ROLES.MEMORY]: {
    section: "memory",
    providerField: "extractionProvider",
    modelField: "extractionModel",
  },
  // Settings → Harness Models → Model roles.
  [MODEL_ROLES.MAIN]: {
    section: "agents",
    providerField: "mainProvider",
    modelField: "mainModel",
  },
  // The knob Settings has long called "Sub-Agent Model"; before role
  // routing it was only read when every local instance was busy.
  [MODEL_ROLES.SUBAGENT]: {
    section: "agents",
    providerField: "subAgentProvider",
    modelField: "subAgentModel",
  },
  [MODEL_ROLES.ORACLE]: {
    section: "agents",
    providerField: "oracleProvider",
    modelField: "oracleModel",
  },
  [MODEL_ROLES.COMPACTION]: {
    section: "agents",
    providerField: "compactionProvider",
    modelField: "compactionModel",
  },
  [MODEL_ROLES.CLASSIFIER]: {
    section: "agents",
    providerField: "classifierProvider",
    modelField: "classifierModel",
  },
};

/** Local instance types preferred for the utility role, in order. */
const UTILITY_LOCAL_INSTANCE_TYPE_ORDER: string[] = [
  PROVIDERS.VLLM,
  PROVIDERS.LM_STUDIO,
  PROVIDERS.OLLAMA,
  PROVIDERS.LLAMA_CPP,
];

const INSTANCE_MODEL_CACHE_TTL_MILLISECONDS = 60_000;
const INSTANCE_MODEL_DISCOVERY_TIMEOUT_MILLISECONDS = 3_000;

interface InstanceModelCacheEntry {
  model: string | null;
  cachedAt: number;
}

const instanceModelCache = new Map<string, InstanceModelCacheEntry>();

interface ListedModel {
  key?: string;
  loaded_instances?: Array<{ id?: string }>;
}

/**
 * Discover the model served by a local instance via its /v1/models-style
 * listing. Prefers a loaded model; falls back to the first listed one.
 * Cached briefly so chain resolution stays cheap. Returns null when the
 * instance is unreachable or serves nothing.
 */
async function discoverInstanceModel(
  instanceId: string,
): Promise<string | null> {
  const cached = instanceModelCache.get(instanceId);
  if (
    cached &&
    performance.now() - cached.cachedAt < INSTANCE_MODEL_CACHE_TTL_MILLISECONDS
  ) {
    return cached.model;
  }

  let model: string | null = null;
  try {
    const provider = getProvider(instanceId) as unknown as {
      listModels?: () => Promise<{ models?: ListedModel[] }>;
    };
    if (typeof provider.listModels === "function") {
      const listing = await Promise.race([
        provider.listModels(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("model discovery timed out")),
            INSTANCE_MODEL_DISCOVERY_TIMEOUT_MILLISECONDS,
          ),
        ),
      ]);
      const models = listing?.models || [];
      const preferred =
        models.find((entry) => (entry.loaded_instances?.length ?? 0) > 0) ||
        models[0];
      model = preferred?.key || null;
    }
  } catch (error: unknown) {
    logger.info(
      `[ModelRoleRouter] Model discovery failed for local instance "${instanceId}": ${errorMessage(error)}`,
    );
    model = null;
  }

  instanceModelCache.set(instanceId, { model, cachedAt: performance.now() });
  return model;
}

/** Cloud providers with configured secrets (mirrors ConfigRoutes). */
export function getAvailableCloudProviders(): Set<string> {
  const secrets: Record<string, string | undefined> = {
    [PROVIDERS.OPENAI]: OPENAI_API_KEY,
    [PROVIDERS.ANTHROPIC]: ANTHROPIC_API_KEY,
    [PROVIDERS.GOOGLE]: GOOGLE_CLOUD_GEMINI_API_KEY,
    [PROVIDERS.MOONSHOT]: MOONSHOT_API_KEY,
  };
  return new Set(
    Object.entries(secrets)
      .filter(([, secret]) => !!secret)
      .map(([provider]) => provider),
  );
}

/** Read the role's DB knob from SettingsService, if one is mapped. */
export async function resolveRoleFromSettings(
  role: ModelRole,
): Promise<RoleChainEntry | null> {
  const mapping = ROLE_SETTINGS[role];
  if (!mapping) return null;
  try {
    const section = (await SettingsService.getSection(
      mapping.section as never,
    )) as Record<string, unknown> | null;
    const provider = section?.[mapping.providerField];
    const model = section?.[mapping.modelField];
    if (
      typeof provider === "string" &&
      provider &&
      typeof model === "string" &&
      model
    ) {
      return { provider, model };
    }
  } catch (error: unknown) {
    logger.warn(
      `[ModelRoleRouter] Failed to read settings for role "${role}": ${errorMessage(error)}`,
    );
  }
  return null;
}

/**
 * A 400 `invalid_request_error` rejects the request surface for THIS model
 * (a sampling parameter, a thinking mode, a context limit) — another model
 * in the chain may accept the same call, so it is worth advancing.
 */
function isModelRejection(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  const errorType =
    error.errorType ??
    ((error.originalError as { error?: { type?: string } } | null)?.error
      ?.type as string | undefined);
  return error.statusCode === 400 && errorType === "invalid_request_error";
}

/** Built-in default chain for the utility role: local instance → cheap cloud. */
async function resolveUtilityDefaults(): Promise<RoleChainEntry[]> {
  const defaults: RoleChainEntry[] = [];

  // 1. Configured local instances, by preferred type order then instance number
  const instances = [...listInstances()].sort((a, b) => {
    const aOrder = UTILITY_LOCAL_INSTANCE_TYPE_ORDER.indexOf(a.type);
    const bOrder = UTILITY_LOCAL_INSTANCE_TYPE_ORDER.indexOf(b.type);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.instanceNumber - b.instanceNumber;
  });
  for (const instance of instances) {
    if (!UTILITY_LOCAL_INSTANCE_TYPE_ORDER.includes(instance.type)) continue;
    const model = await discoverInstanceModel(instance.id);
    if (model) defaults.push({ provider: instance.id, model });
  }

  // 2. Cheapest available cloud model (tool-calling not required for
  //    utility summarization/extraction work)
  const cloudDefault = resolveRecommendedDefault(
    MODALITY_TYPES.TEXT,
    MODALITY_TYPES.TEXT,
    getAvailableCloudProviders(),
  );
  if (cloudDefault) {
    defaults.push({
      provider: cloudDefault.provider,
      model: cloudDefault.model,
    });
  }

  return defaults;
}

/** Built-in default chain for the vision role: cheapest available vision model. */
function resolveVisionDefaults(): RoleChainEntry[] {
  const cloudDefault = resolveRecommendedDefault(
    MODALITY_TYPES.IMAGE,
    MODALITY_TYPES.TEXT,
    getAvailableCloudProviders(),
  );
  return cloudDefault
    ? [{ provider: cloudDefault.provider, model: cloudDefault.model }]
    : [];
}

function dedupeChain(chain: RoleChainEntry[]): RoleChainEntry[] {
  const seen = new Set<string>();
  const deduped: RoleChainEntry[] = [];
  for (const entry of chain) {
    const key = `${entry.provider} ${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export default class ModelRoleRouter {
  /**
   * Resolve a role to its ordered fallback chain.
   *
   * Order: env (`MODEL_ROLE_<ROLE>`) → DB knob → caller fallback →
   * built-in defaults (utility: local instance then cheap cloud;
   * critic and memory: the utility chain; vision: cheap cloud vision model).
   * Entries are de-duplicated preserving first occurrence.
   */
  static async resolveChain(
    role: ModelRole,
    { fallback, agents }: ResolveChainOptions = {},
  ): Promise<RoleChainEntry[]> {
    const chain: RoleChainEntry[] = [];

    if (agents && agents.some(Boolean)) {
      const { findAgentModelPin } = await import("./routing/AgentModelPins.ts");
      const pin = await findAgentModelPin(
        agents.map((agent) => ({ agent, role })),
      );
      if (pin?.spec.provider && pin.spec.model) {
        chain.push({ provider: pin.spec.provider, model: pin.spec.model });
      }
    }

    chain.push(...getModelRoleChainFromEnvironment(role));

    const settingsEntry = await resolveRoleFromSettings(role);
    if (settingsEntry) chain.push(settingsEntry);

    // A utility-derived role hands its fallback to the utility chain, so
    // the configured utility model still comes before it (compaction ran
    // env/DB utility → the conversation's model → defaults before it had
    // a role of its own, and still does when its own knob is unset).
    if (fallback && !UTILITY_DERIVED_ROLES.has(role)) chain.push(fallback);

    if (role === MODEL_ROLES.UTILITY) {
      chain.push(...(await resolveUtilityDefaults()));
    } else if (UTILITY_DERIVED_ROLES.has(role)) {
      // A danger-pattern review, a summary, an extraction, a label: fast
      // cheap work — never the main conversation model by default.
      chain.push(...(await this.resolveChain(MODEL_ROLES.UTILITY, { fallback })));
    } else if (role === MODEL_ROLES.VISION) {
      chain.push(...resolveVisionDefaults());
    }

    const deduped = dedupeChain(chain);
    if (deduped.length === 0) {
      logger.error(
        `[ModelRoleRouter] Role "${role}" resolved to an EMPTY chain — ` +
          `no env config, no settings, no fallback, and no default model available. ` +
          `Calls routed through this role cannot run.`,
      );
    }
    return deduped;
  }

  /**
   * Execute `attempt` against each chain entry in order, advancing to the
   * next entry on transient provider failures. Non-transient errors and
   * the final entry's failure propagate to the caller.
   */
  static async runWithChain<T>(
    chain: RoleChainEntry[],
    attempt: (entry: RoleChainEntry, index: number) => Promise<T>,
    { role, operation }: { role: ModelRole; operation: string },
  ): Promise<{ value: T; entry: RoleChainEntry }> {
    if (chain.length === 0) {
      throw new Error(
        `[ModelRoleRouter] Cannot run "${operation}": role "${role}" resolved to an empty model chain.`,
      );
    }
    let lastError: unknown;
    for (let index = 0; index < chain.length; index++) {
      const entry = chain[index];
      try {
        const value = await attempt(entry, index);
        return { value, entry };
      } catch (error: unknown) {
        lastError = error;
        const hasNext = index < chain.length - 1;
        const isTransient = isTransientProviderError(error);
        if (hasNext && (isTransient || isModelRejection(error))) {
          const next = chain[index + 1];
          logger.warn(
            `[ModelRoleRouter] role=${role} operation=${operation} ` +
              `attempt=${index + 1}/${chain.length} provider=${entry.provider} model=${entry.model} ` +
              `${isTransient ? "transient failure" : "model rejected the request"} (${errorMessage(error)}) — advancing to ${next.provider}/${next.model}`,
          );
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  /** Test hook — clear the local-instance model discovery cache. */
  static clearInstanceModelCache(): void {
    instanceModelCache.clear();
  }
}
