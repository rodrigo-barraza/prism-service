// ─── Multi-Instance Local Provider Support ──────────────────

import logger from "../utils/logger.ts";
import {
  PROVIDER_LM_STUDIO,
  PROVIDER_VLLM,
  PROVIDER_OLLAMA,
  PROVIDER_LLAMA_CPP,
  } from "../../config.ts";

// Import factories
import { createLmStudioProvider } from "./lm-studio.ts";
import { createOllamaProvider } from "./ollama.ts";
import { createVllmProvider } from "./vllm.ts";
import { createLlamaCppProvider } from "./llama-cpp.ts";
import { InstanceEntry, ProviderInstanceConfig } from "../types/ProviderTypes.ts";

// ── Factory map ─────────────────────────────────────────────
const FACTORIES = {
  "lm-studio": createLmStudioProvider,
  ollama: createOllamaProvider,
  vllm: createVllmProvider,
  "llama-cpp": createLlamaCppProvider,
};

// ── Provider arrays from secrets ────────────────────────────
const PROVIDER_ARRAYS = {
  "lm-studio": PROVIDER_LM_STUDIO || [],
  vllm: PROVIDER_VLLM || [],
  ollama: PROVIDER_OLLAMA || [],
  "llama-cpp": PROVIDER_LLAMA_CPP || [],
};

// ── Registry ────────────────────────────────────────────────

/**
 * @typedef {object} InstanceEntry
 * @property {string} id            - Unique instance ID (e.g. "lm-studio-2")
 * @property {string} type          - Provider type (e.g. "lm-studio")
 * @property {string} baseUrl       - Server URL
 * @property {number} concurrency   - Max concurrent requests for this instance
 * @property {number} instanceNumber - 1-based instance number within its type
 * @property {string} [nickname]    - Optional display label (e.g. "Desktop")
 * @property {object} provider      - The instantiated provider object
 */


const registry = new Map<string, InstanceEntry>();

/**
 * Register all instances for a provider type from its array.

 * @param {Array<{url: string, concurrency?: number, nickname?: string}>} instances
 */
function registerType(type: string, instances: ProviderInstanceConfig[]) {
    const factory = (FACTORIES as any)[type];
  if (!factory) return;

  for (let i = 0; i < instances.length; i++) {
    const { url, concurrency = 1, nickname } = instances[i];
    if (!url) continue;

    const instanceNumber = i + 1;
    const id = instanceNumber === 1 ? type : `${type}-${instanceNumber}`;
    const maxConcurrency = Math.max(1, typeof concurrency === 'number' ? concurrency : parseInt(String(concurrency), 10) || 1);
    const provider = factory(url, id);

    const entry = {
      id,
      type,
      baseUrl: url,
      concurrency: maxConcurrency,
      instanceNumber,
      provider,
    };
        if (nickname) (entry as any).nickname = nickname;

    registry.set(id, entry);

    const label = nickname ? `${id} (${nickname})` : id;
    logger.info(
      `[InstanceRegistry] ${label} → ${url} (concurrency: ${maxConcurrency})`,
    );
  }
}

// ── Register all instances from secrets ─────────────────────
for ( const [type, instances] of Object.entries(PROVIDER_ARRAYS)) {
  registerType(type, instances);
}

// ── Public API ──────────────────────────────────────────────

/**
 * Get a provider instance by ID.

 * @returns {object|null} Provider object or null if not found
 */
export function getInstanceProvider(id: string) {
  return registry.get(id)?.provider || null;
}

/**
 * Get full instance entry by ID.


 */
export function getInstance(id: string): InstanceEntry | null {
  return registry.get(id) || null;
}

/**
 * Check if an ID belongs to a registered instance.


 */
export function isInstance(id: string) {
  return registry.has(id);
}

/**
 * List all registered instances.

 */
export function listInstances() {
  return [...registry.values()];
}

/**
 * Get all unique provider types that have at least one instance.

 */
export function listInstanceTypes() {
  return [...new Set([...registry.values()].map((e: InstanceEntry) => e.type))];
}

/**
 * Get all instances of a given provider type.


 */
export function getInstancesByType(type: string) {
  return [...registry.values()].filter((e: InstanceEntry) => e.type === type);
}

/**
 * Resolve the provider type from an instance ID.
 * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"


 */
export function getInstanceType(id: string) {
  return registry.get(id)?.type || null;
}
