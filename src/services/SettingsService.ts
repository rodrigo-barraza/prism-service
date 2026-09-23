import { DEFAULT_TOPOLOGY } from "@rodrigo-barraza/utilities-library/taxonomy";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { deepMerge, getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS, PROVIDERS } from "#src/constants";
import { MODELS } from "#src/config";
import logger from "#src/utils/logger";
import {
  ANTHROPIC_SETTING_DEFAULTS,
  type AnthropicSettings,
} from "#src/constants/AnthropicRequestSettings";

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Hot path: MemoryService + EmbeddingService read these on every call.
// Cache is invalidated on update() and lazily populated on first get().

export interface SettingsData {
  memory: {
    extractionProvider: string;
    extractionModel: string;
    consolidationProvider: string;
    consolidationModel: string;
    embeddingProvider: string;
    embeddingModel: string;
    [key: string]: string; // Support dynamic string index for provider/model retrieval
  };
  agents: {
    /**
     * Role models (routing/RoleModelResolver). `main` fills in only for a
     * caller that names no model; `subagent` routes every sub-agent that
     * no agent definition pins; `subAgentEffort` is "" (one step below the
     * parent when the sub-agent inherits the parent's model — effort
     * first), "inherit", or a level.
     */
    mainProvider: string;
    mainModel: string;
    subAgentProvider: string;
    subAgentModel: string;
    subAgentEffort: string;
    oracleProvider: string;
    oracleModel: string;
    compactionProvider: string;
    compactionModel: string;
    classifierProvider: string;
    classifierModel: string;
    /** "" or a routing preset id (routing/RoutingPresets) — e.g. "lead_sidekick". */
    routingPreset: string;
    criticProvider: string;
    criticModel: string;
    planProvider: string;
    planModel: string;
    reminderProvider: string;
    reminderModel: string;
    harness: string;
    topology: string;
    dynamicToolActivation: boolean;
    /**
     * Run a deterministic tool-catalog search against the user's message
     * before iteration 1 and pre-enable the top matches so the tool set is
     * stable from the first request (prompt-cache friendly). Kill switch
     * for PreflightToolDiscovery.
     */
    preflightToolDiscovery: boolean;
    locale: string;
    [key: string]: string | boolean;
  };
  security: {
    allowEnvFiles: boolean;
  };
  /**
   * `defaultMode` — the permission mode a conversation starts in when it
   * names none (permissions/PermissionModes.ts). `bypass` is never honoured
   * here: it is chosen per conversation.
   */
  permissions?: {
    defaultMode: string;
  };
  creative?: {
    imageProvider: string;
    imageModel: string;
    visionProvider: string;
    visionModel: string;
    textToSpeechProvider?: string;
    textToSpeechModel?: string;
    speechToTextProvider?: string;
    speechToTextModel?: string;
  };
  somatic?: {
    emotionProvider: string;
    emotionModel: string;
    [key: string]: string;
  };
  workspace?: {
    agentSecret: string;
  };
  anthropic?: AnthropicSettings;
  [key: string]: unknown;
}

let _cache: SettingsData | null = null;

const DEFAULTS: SettingsData = {
  memory: {
    extractionProvider: "",
    extractionModel: "",
    consolidationProvider: "",
    consolidationModel: "",
    embeddingProvider: "",
    embeddingModel: "",
  },
  agents: {
    mainProvider: "",
    mainModel: "",
    subAgentProvider: "",
    subAgentModel: "",
    subAgentEffort: "",
    oracleProvider: "",
    oracleModel: "",
    compactionProvider: "",
    compactionModel: "",
    classifierProvider: "",
    classifierModel: "",
    routingPreset: "",
    criticProvider: "",
    criticModel: "",
    planProvider: "",
    planModel: "",
    reminderProvider: "",
    reminderModel: "",
    harness: "standard",
    topology: DEFAULT_TOPOLOGY,
    dynamicToolActivation: true,
    preflightToolDiscovery: true,
    locale: "en",
  },
  security: {
    allowEnvFiles: false,
  },
  permissions: {
    defaultMode: "default",
  },
  creative: {
    imageProvider: PROVIDERS.GOOGLE,
    imageModel: MODELS.GEMINI_3_PRO_IMAGE.name,
    visionProvider: PROVIDERS.GOOGLE,
    visionModel: MODELS.GEMINI_35_FLASH.name,
    textToSpeechProvider: PROVIDERS.ELEVENLABS,
    textToSpeechModel: "",
    speechToTextProvider: PROVIDERS.OPENAI,
    speechToTextModel: "",
  },
  somatic: {
    emotionProvider: "",
    emotionModel: "",
  },
  workspace: {
    agentSecret: "",
  },
  anthropic: { ...ANTHROPIC_SETTING_DEFAULTS },
};

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * SettingsService — server-side settings store backed by MongoDB.
 *
 * Stores a single document (keyed by `_key: "global"`) in the `settings`
 * collection. Uses an in-memory cache to avoid DB round-trips on the
 * hot path (embedding generation, memory extraction).
 */
const SettingsService = {
  async get(): Promise<SettingsData> {
    if (_cache) return _cache;

    try {
      const collection = MongoWrapper.getCollection(
        MONGO_DB_NAME,
        COLLECTIONS.SETTINGS,
      );
      if (!collection) return { ...DEFAULTS };

      const document = await collection.findOne({ _key: "global" });
      if (!document) {
        _cache = { ...DEFAULTS };
        return _cache;
      }

      // Deep merge: defaults ← stored
      _cache = deepMerge(
        DEFAULTS as Record<string, unknown>,
        (document.data || {}) as Record<string, unknown>,
      ) as SettingsData;
      return _cache;
    } catch (error) {
      logger.warn(
        `[SettingsService] Failed to load settings from database: ${getErrorMessage(
          error,
        )}. Falling back to defaults.`,
      );
      return { ...DEFAULTS };
    }
  },
  async getSection<K extends keyof SettingsData>(
    section: K,
  ): Promise<SettingsData[K]> {
    const settings = await this.get();
    return settings[section] || DEFAULTS[section];
  },
  async update(data: Partial<SettingsData>) {
    const collection = MongoWrapper.getCollection(
      MONGO_DB_NAME,
      COLLECTIONS.SETTINGS,
    );
    if (!collection) throw new Error("Database not available");

    const current = await this.get();
    const merged = deepMerge(
      current as Record<string, unknown>,
      data as Record<string, unknown>,
    ) as SettingsData;

    await collection.updateOne(
      { _key: "global" },
      {
        $set: {
          data: merged,
          updatedAt: new Date().toISOString(),
        },
        $setOnInsert: {
          _key: "global",
          createdAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );

    // Invalidate cache
    _cache = merged;
    logger.info("[SettingsService] Settings updated and cache refreshed");
    return merged;
  },

  /**
   * Resolve provider + model for a memory subsystem role.
   * Centralises the identical getXxxConfig() helpers in MemoryService,
   * MemoryConsolidationService, and EmbeddingService.
   */
  async getMemoryModelConfig(role: string) {
    const memorySettings = await this.getSection("memory");
    const provider = memorySettings?.[`${role}Provider`];
    const model = memorySettings?.[`${role}Model`];
    if (!provider || !model) {
      throw new Error(
        `${role} model not configured — set it in Settings → Memory Models`,
      );
    }
    return { provider, model };
  },

  async getSomaticModelConfig() {
    const somaticSettings = await this.getSection("somatic");
    const provider = somaticSettings?.emotionProvider;
    const model = somaticSettings?.emotionModel;
    if (!provider || !model) {
      return null;
    }
    return { provider, model };
  },

  invalidateCache() {
    _cache = null;
  },
  getCached(): SettingsData {
    return _cache || { ...DEFAULTS };
  },
  getDefaults() {
    return { ...DEFAULTS };
  },
};

// deepMerge — imported from @rodrigo-barraza/utilities-library

export default SettingsService;
