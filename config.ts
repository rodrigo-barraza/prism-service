// ─── Environment Accessors ──────────────────────────────────
// Typed accessor layer over process.env. The Vault service is
// the single source of truth — boot.js hydrates process.env
// from the Vault before any module imports run.
//
// This file contains NO defaults and NO secrets.

// ── Helpers ────────────────────────────────────────────────────

export interface ProviderInstance {
  url: string;
  concurrency: number;
  nickname?: string;
  apiKey?: string;
  priorityScheduling?: boolean;
}

/**
 * Parse indexed env vars into an array of provider instance objects.
 *
 * For a prefix of "PROVIDER_LM_STUDIO", this reads:
 *   PROVIDER_LM_STUDIO_1_URL, PROVIDER_LM_STUDIO_1_CONCURRENCY, PROVIDER_LM_STUDIO_1_NICKNAME
 *   PROVIDER_LM_STUDIO_2_URL, PROVIDER_LM_STUDIO_2_CONCURRENCY, PROVIDER_LM_STUDIO_2_NICKNAME
 *   ... up to 10 instances
 * plus an optional _API_KEY per instance, sent as a Bearer token by the
 * providers that support one (SGLang).
 *
 * Returns: [{ url, concurrency, nickname?, apiKey? }, ...]
 */
function parseProviderInstances(
  environmentVariablePrefix: string,
): ProviderInstance[] {
  const instances: ProviderInstance[] = [];
  for (let index = 1; index <= 10; index++) {
    const url = process.env[`${environmentVariablePrefix}_${index}_URL`];
    if (!url) {
      continue;
    }
    const concurrency =
      parseInt(
        process.env[`${environmentVariablePrefix}_${index}_CONCURRENCY`] ?? "",
        10,
      ) || 1;
    const nickname =
      process.env[`${environmentVariablePrefix}_${index}_NICKNAME`];
    const entry: ProviderInstance = { url, concurrency };
    if (nickname) {
      entry.nickname = nickname;
    }
    const apiKey = process.env[`${environmentVariablePrefix}_${index}_API_KEY`];
    if (apiKey) {
      entry.apiKey = apiKey;
    }
    if (process.env[`${environmentVariablePrefix}_${index}_PRIORITY_SCHEDULING`] === "true") {
      entry.priorityScheduling = true;
    }
    instances.push(entry);
  }
  return instances;
}

// ── Server ─────────────────────────────────────────────────────
export const PRISM_SERVICE_PORT = process.env.PRISM_SERVICE_PORT || 7777;

// ── AI Provider API Keys ───────────────────────────────────────
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
/**
 * Transport for OpenAI Responses agent turns on models that steer natively
 * (GPT-6): "websocket" (default — native `response.steer` and incremental
 * continuation) or "http" (the SSE stream every other model uses).
 */
export function openAIResponsesTransport(): "websocket" | "http" {
  return process.env.OPENAI_RESPONSES_TRANSPORT === "http" ? "http" : "websocket";
}
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const GOOGLE_CLOUD_GEMINI_API_KEY =
  process.env.GOOGLE_CLOUD_GEMINI_API_KEY;
/**
 * PROTOTYPE switch (prompt 25 Landing 2): "interactions" streams Gemini agent
 * turns over the Interactions API; anything else keeps generateContent, the
 * default until the transport decision is made.
 */
export function geminiTransport(): "interactions" | "generate_content" {
  return process.env.GEMINI_TRANSPORT === "interactions" ? "interactions" : "generate_content";
}
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
export const INWORLD_BASIC = process.env.INWORLD_BASIC;
// Moonshot AI (Kimi) — OpenAI-compatible cloud provider.
export const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY;
/**
 * Kimi K3's endpoint: "anthropic" (default — api.moonshot.ai/anthropic,
 * through the Anthropic adapter: cache_control, signed thinking, effort) or
 * "openai" (the Chat Completions fallback every other Kimi model uses).
 */
export function moonshotTransport(): "anthropic" | "openai" {
  return process.env.MOONSHOT_TRANSPORT === "openai" ? "openai" : "anthropic";
}
/** TTL tier Kimi writes its prompt cache at: "5m" (default) or "1h". */
export function moonshotCacheTtl(): "5m" | "1h" {
  return process.env.MOONSHOT_CACHE_TTL === "1h" ? "1h" : "5m";
}
// Optional endpoint override — defaults to https://api.moonshot.ai/v1.
// Set to https://api.moonshot.cn/v1 for the China region.
export const MOONSHOT_BASE_URL = process.env.MOONSHOT_BASE_URL;

// ── Local Provider Instances ───────────────────────────────────
// Parsed from indexed env vars: PROVIDER_<TYPE>_<N>_URL, _CONCURRENCY, _NICKNAME
export const PROVIDER_LM_STUDIO = parseProviderInstances("PROVIDER_LM_STUDIO");
export const PROVIDER_VLLM = parseProviderInstances("PROVIDER_VLLM");
export const PROVIDER_OLLAMA = parseProviderInstances("PROVIDER_OLLAMA");
export const PROVIDER_LLAMA_CPP = parseProviderInstances("PROVIDER_LLAMA_CPP");
export const PROVIDER_SGLANG = parseProviderInstances("PROVIDER_SGLANG");

// ── MongoDB ────────────────────────────────────────────────────
export const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI && process.env.NODE_ENV !== "test") {
  throw new Error("CRITICAL: MONGO_URI environment variable is not defined.");
}

export const MONGO_DB_NAME =
  process.env.PRISM_SERVICE_MONGO_DB_NAME ||
  process.env.PRISM_MONGO_DB_NAME ||
  process.env.MONGO_DB_NAME ||
  "prism";

// ── MinIO (Optional — files stored inline in MongoDB if not set) ──
export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT;
export const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
export const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;
export const MINIO_BUCKET_NAME =
  process.env.PRISM_SERVICE_MINIO_BUCKET_NAME ||
  process.env.PRISM_MINIO_BUCKET_NAME ||
  process.env.MINIO_BUCKET_NAME;
// Public gateway for direct object access (e.g. https://storage.rod.dev).
// When set, minio:// refs resolve to shareable URLs on this host instead of
// the internal MINIO_ENDPOINT address.
export const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL;

// ── Tools API ──────────────────────────────────────────────────
export const TOOLS_SERVICE_URL = process.env.TOOLS_SERVICE_URL;

// ── Web Push (browser notifications) ──────────────────────────
// VAPID key pair (base64url: 65-byte public point, 32-byte private
// scalar) and the operator contact (`https:` or `mailto:`) the push
// services see. Unset → Web Push is off; everything else still works.
export const PRISM_VAPID_PUBLIC_KEY = process.env.PRISM_VAPID_PUBLIC_KEY;
export const PRISM_VAPID_PRIVATE_KEY = process.env.PRISM_VAPID_PRIVATE_KEY;
export const PRISM_VAPID_SUBJECT = process.env.PRISM_VAPID_SUBJECT;
// Optional fallback channel: an ntfy topic, delivered through
// tools-service's /communication/push, used when the conversation's
// owner has no browser subscribed.
export const PRISM_PUSH_NTFY_TOPIC = process.env.PRISM_PUSH_NTFY_TOPIC;
// Public origin of prism-client, for absolute links in ntfy messages.
export const PRISM_CLIENT_PUBLIC_URL = process.env.PRISM_CLIENT_PUBLIC_URL;

// ── MCP OAuth ─────────────────────────────────────────────────
// Public origin of prism-service (vault-derived from the registry domain):
// MCP OAuth redirects land on `${PRISM_SERVICE_PUBLIC_URL}/mcp/oauth/callback`.
// Unset, the origin of the request that started the flow is used.
export const PRISM_SERVICE_PUBLIC_URL = process.env.PRISM_SERVICE_PUBLIC_URL;
// 32-byte key (base64 or hex) that encrypts MCP OAuth tokens and client
// registrations at rest. Without it, OAuth MCP servers can't be connected.
export const MCP_OAUTH_ENCRYPTION_KEY = process.env.MCP_OAUTH_ENCRYPTION_KEY;
// Read-only GitHub token for the optional seeded GitHub MCP server
// (https://api.githubcopilot.com/mcp/readonly). Unset, it stays disabled.
export const GITHUB_MCP_TOKEN = process.env.GITHUB_MCP_TOKEN;

// ── Anthropic Files API ───────────────────────────────────────
// Upload-once media caching against Anthropic's Files API
// (beta: files-api-2025-04-14). Default ON for the first-party API;
// set ANTHROPIC_FILES_API_ENABLED=false to force inline base64.
export const ANTHROPIC_FILES_API_ENABLED =
  process.env.ANTHROPIC_FILES_API_ENABLED !== "false";
// The Files API only exists on the first-party API — the SDK reads
// ANTHROPIC_BASE_URL, so a Bedrock/Vertex-style override disables it.
export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;

// ── Media Limits ──────────────────────────────────────────────
// Long-edge pixel cap for images sent to high-resolution Anthropic
// vision models (Opus 4.7+, Sonnet 5+, Fable 5, Mythos 5). Higher
// resolution costs up to ~3× image tokens — override to tune.
export const HIGH_RES_IMAGE_MAX_DIMENSION =
  parseInt(process.env.HIGH_RES_IMAGE_MAX_DIMENSION ?? "", 10) || 2576;

// ── Model Role Chains ─────────────────────────────────────────
// Explicit env config for role-based model routing (ModelRoleRouter).
// One variable per role: MODEL_ROLE_UTILITY, MODEL_ROLE_CRITIC, ...
// Value: ordered comma-separated fallback chain of `provider=model` pairs,
// e.g. MODEL_ROLE_UTILITY="vllm=Qwen/Qwen3-4B,google=gemini-3.5-flash".
// (`=` separates provider from model because local model ids may contain
// `:` and `/`.)
export function getModelRoleChainFromEnvironment(
  role: string,
): Array<{ provider: string; model: string }> {
  const raw =
    process.env[`MODEL_ROLE_${role.toUpperCase().replace(/-/g, "_")}`];
  if (!raw) return [];
  const chain: Array<{ provider: string; model: string }> = [];
  for (const entry of raw.split(",")) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) continue;
    const provider = entry.slice(0, separatorIndex).trim();
    const model = entry.slice(separatorIndex + 1).trim();
    if (provider && model) chain.push({ provider, model });
  }
  return chain;
}

// ── Memory Extraction ─────────────────────────────────────────
// MEMORY_EXTRACTION_CHANNEL_WATERMARK=true lets a platform bot's turns
// (agentContext.platform + channelId — Lupos on Discord) share one
// extraction watermark per channel, so each reply extracts only the
// channel messages no earlier reply extracted. Default OFF: measured
// 2026-09-22 on real channels it cut Lupos extraction input ~60% but also
// most of its memory yield, which comes from re-reading overlapping
// windows. Off, each reply reads its whole history as before. Read per
// call so it can be flipped without a code change.
export function isMemoryExtractionChannelWatermarkEnabled(): boolean {
  return process.env.MEMORY_EXTRACTION_CHANNEL_WATERMARK === "true";
}

// ── Default Model Names ───────────────────────────────────────
// Vault-backed model identifiers — swap models without code deploys.

export const LIVE_AUDIO_MODEL = process.env.LIVE_AUDIO_MODEL;
export const OPENAI_TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL;
export const GOOGLE_TEXT_TO_SPEECH_MODEL = process.env.GOOGLE_TTS_MODEL;
export const GOOGLE_EMBEDDING_MODEL = process.env.GOOGLE_EMBEDDING_MODEL;

// ── LM Studio Tuning ──────────────────────────────────────────
export const LM_STUDIO_EVALUATION_BATCH_SIZE =
  parseInt(process.env.LM_STUDIO_EVAL_BATCH_SIZE ?? "", 10) || 4096;
export const LM_STUDIO_PHYSICAL_BATCH_SIZE =
  parseInt(process.env.LM_STUDIO_PHYSICAL_BATCH_SIZE ?? "", 10) || 4096;
export const LM_STUDIO_DEFAULT_MAX_CONTEXT =
  parseInt(process.env.LM_STUDIO_DEFAULT_MAX_CONTEXT ?? "", 10) || 262144;
