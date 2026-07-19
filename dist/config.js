// ─── Environment Accessors ──────────────────────────────────
// Typed accessor layer over process.env. The Vault service is
// the single source of truth — boot.js hydrates process.env
// from the Vault before any module imports run.
//
// This file contains NO defaults and NO secrets.
/**
 * Parse indexed env vars into an array of provider instance objects.
 *
 * For a prefix of "PROVIDER_LM_STUDIO", this reads:
 *   PROVIDER_LM_STUDIO_1_URL, PROVIDER_LM_STUDIO_1_CONCURRENCY, PROVIDER_LM_STUDIO_1_NICKNAME
 *   PROVIDER_LM_STUDIO_2_URL, PROVIDER_LM_STUDIO_2_CONCURRENCY, PROVIDER_LM_STUDIO_2_NICKNAME
 *   ... up to 10 instances
 *
 * Returns: [{ url, concurrency, nickname? }, ...]
 */
function parseProviderInstances(environmentVariablePrefix) {
    const instances = [];
    for (let index = 1; index <= 10; index++) {
        const url = process.env[`${environmentVariablePrefix}_${index}_URL`];
        if (!url) {
            continue;
        }
        const concurrency = parseInt(process.env[`${environmentVariablePrefix}_${index}_CONCURRENCY`] ?? "", 10) || 1;
        const nickname = process.env[`${environmentVariablePrefix}_${index}_NICKNAME`];
        const entry = { url, concurrency };
        if (nickname) {
            entry.nickname = nickname;
        }
        instances.push(entry);
    }
    return instances;
}
// ── Server ─────────────────────────────────────────────────────
export const PRISM_SERVICE_PORT = process.env.PRISM_SERVICE_PORT || 7777;
// ── AI Provider API Keys ───────────────────────────────────────
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
export const GOOGLE_CLOUD_GEMINI_API_KEY = process.env.GOOGLE_CLOUD_GEMINI_API_KEY;
export const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
export const INWORLD_BASIC = process.env.INWORLD_BASIC;
// ── Local Provider Instances ───────────────────────────────────
// Parsed from indexed env vars: PROVIDER_<TYPE>_<N>_URL, _CONCURRENCY, _NICKNAME
export const PROVIDER_LM_STUDIO = parseProviderInstances("PROVIDER_LM_STUDIO");
export const PROVIDER_VLLM = parseProviderInstances("PROVIDER_VLLM");
export const PROVIDER_OLLAMA = parseProviderInstances("PROVIDER_OLLAMA");
export const PROVIDER_LLAMA_CPP = parseProviderInstances("PROVIDER_LLAMA_CPP");
// ── MongoDB ────────────────────────────────────────────────────
export const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI && process.env.NODE_ENV !== "test") {
    throw new Error("CRITICAL: MONGO_URI environment variable is not defined.");
}
export const MONGO_DB_NAME = process.env.PRISM_SERVICE_MONGO_DB_NAME ||
    process.env.PRISM_MONGO_DB_NAME ||
    process.env.MONGO_DB_NAME ||
    "prism";
// ── MinIO (Optional — files stored inline in MongoDB if not set) ──
export const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT;
export const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
export const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;
export const MINIO_BUCKET_NAME = process.env.PRISM_SERVICE_MINIO_BUCKET_NAME ||
    process.env.PRISM_MINIO_BUCKET_NAME ||
    process.env.MINIO_BUCKET_NAME;
// Public gateway for direct object access (e.g. https://storage.rod.dev).
// When set, minio:// refs resolve to shareable URLs on this host instead of
// the internal MINIO_ENDPOINT address.
export const MINIO_PUBLIC_URL = process.env.MINIO_PUBLIC_URL;
// ── Tools API ──────────────────────────────────────────────────
export const TOOLS_SERVICE_URL = process.env.TOOLS_SERVICE_URL;
// ── Anthropic Files API ───────────────────────────────────────
// Upload-once media caching against Anthropic's Files API
// (beta: files-api-2025-04-14). Default ON for the first-party API;
// set ANTHROPIC_FILES_API_ENABLED=false to force inline base64.
export const ANTHROPIC_FILES_API_ENABLED = process.env.ANTHROPIC_FILES_API_ENABLED !== "false";
// The Files API only exists on the first-party API — the SDK reads
// ANTHROPIC_BASE_URL, so a Bedrock/Vertex-style override disables it.
export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
// ── Media Limits ──────────────────────────────────────────────
// Long-edge pixel cap for images sent to high-resolution Anthropic
// vision models (Opus 4.7+, Sonnet 5+, Fable 5, Mythos 5). Higher
// resolution costs up to ~3× image tokens — override to tune.
export const HIGH_RES_IMAGE_MAX_DIMENSION = parseInt(process.env.HIGH_RES_IMAGE_MAX_DIMENSION ?? "", 10) || 2576;
// ── Default Model Names ───────────────────────────────────────
// Vault-backed model identifiers — swap models without code deploys.
export const LIVE_AUDIO_MODEL = process.env.LIVE_AUDIO_MODEL;
export const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL;
export const GOOGLE_TEXT_TO_SPEECH_MODEL = process.env.GOOGLE_TTS_MODEL;
export const GOOGLE_EMBEDDING_MODEL = process.env.GOOGLE_EMBEDDING_MODEL;
// ── LM Studio Tuning ──────────────────────────────────────────
export const LM_STUDIO_EVALUATION_BATCH_SIZE = parseInt(process.env.LM_STUDIO_EVAL_BATCH_SIZE ?? "", 10) || 4096;
export const LM_STUDIO_PHYSICAL_BATCH_SIZE = parseInt(process.env.LM_STUDIO_PHYSICAL_BATCH_SIZE ?? "", 10) || 4096;
export const LM_STUDIO_DEFAULT_MAX_CONTEXT = parseInt(process.env.LM_STUDIO_DEFAULT_MAX_CONTEXT ?? "", 10) || 262144;
//# sourceMappingURL=config.js.map