import MongoWrapper from "../wrappers/MongoWrapper.ts";
// @ts-ignore
import { deepMerge } from "@rodrigo-barraza/utilities-library";
// @ts-ignore
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import logger from "../utils/logger.ts";

// ─── Default Settings ─────────────────────────────────────────────────────────

const DEFAULTS = {
  memory: {
    extractionProvider: "",
    extractionModel: "",
    consolidationProvider: "",
    consolidationModel: "",
    embeddingProvider: "",
    embeddingModel: "",
  },
  agents: {
    subagentProvider: "",
    subagentModel: "",
    harness: "standard",
  },
};

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Hot path: MemoryService + EmbeddingService read these on every call.
// Cache is invalidated on update() and lazily populated on first get().

// @ts-ignore
let _cache = null;

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * SettingsService — server-side settings store backed by MongoDB.
 *
 * Stores a single document (keyed by `_key: "global"`) in the `settings`
 * collection. Uses an in-memory cache to avoid DB round-trips on the
 * hot path (embedding generation, memory extraction).
 */
const SettingsService = {
  /**
   * Get the current settings, merging with defaults for any missing keys.

   */
  async get() {
    // @ts-ignore
    if (_cache) return _cache;

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
    _cache = deepMerge(DEFAULTS, document.data || {});
    return _cache;
  },

  /**
   * Get a specific section of settings (e.g. "memory").


   */
  async getSection(section: Record<string, unknown>) {
    const settings = await this.get();
    // @ts-ignore
    return settings[section] || DEFAULTS[section] || {};
  },

  /**
   * Update settings. Performs a deep merge with existing settings.

   * @returns {Promise<object>} The full settings after merge
   */
  async update(data: Record<string, unknown>) {
    const collection = MongoWrapper.getCollection(
      MONGO_DB_NAME,
      COLLECTIONS.SETTINGS,
    );
    if (!collection) throw new Error("Database not available");

    const current = await this.get();
    const merged = deepMerge(current, data);

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
   *

   * @returns {Promise<{ provider: string, model: string }>}
   */
  async getMemoryModelConfig(role: string) {
    // @ts-ignore - TODO: strict typing
    const mem = await this.getSection("memory");
    const provider = mem[`${role}Provider`];
    const model = mem[`${role}Model`];
    if (!provider || !model) {
      throw new Error(
        `${role} model not configured — set it in Settings → Memory Models`,
      );
    }
    return { provider, model };
  },

  /**
   * Clear the in-memory cache (useful for testing).
   */
  invalidateCache() {
    _cache = null;
  },

  /**
   * Return the compiled defaults for reference.
   */
  getDefaults() {
    return { ...DEFAULTS };
  },
};

// deepMerge — imported from @rodrigo-barraza/utilities-library

export default SettingsService;
