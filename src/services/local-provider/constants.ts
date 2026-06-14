/** All recognized local provider types. */
export const LOCAL_PROVIDER_TYPES = new Set([
  "lm-studio",
  "vllm",
  "ollama",
  "llama-cpp",
]);

/**
 * Providers that use native MCP tool execution (the provider's own
 * internal loop handles multi-step tool calling via native events).
 * These providers only need tools on the first pass — subsequent
 * passes should omit tools to force an eventual text response.
 */
export const NATIVE_MCP_TYPES = new Set(["lm-studio", "ollama"]);

/**
 * Providers that emit thinking tokens (<think> tags) by default.
 * When the client doesn't explicitly set thinkingEnabled, these
 * providers default to thinkingEnabled=true.
 */
export const DEFAULT_THINKING_TYPES = new Set(["lm-studio", "llama-cpp"]);

/**
 * Providers that support model management (load/unload/ensure).
 * Only applicable to servers that can hot-swap models.
 */
export const MODEL_MANAGEMENT_TYPES = new Set(["lm-studio"]);

/**
 * Models that support extended thinking / chain-of-thought reasoning.
 * Matched against the lowercased model key via substring inclusion.
 * Only include models whose GGUF/local variants emit native &lt;think&gt;
 * tags or structured reasoning traces before the final answer.
 */
export const THINKING_PATTERNS = [
  // Alibaba — Qwen family
  "qwen3",
  "qwq",
  // DeepSeek
  "deepseek-r1",
  "deepseek-v3",
  // OpenAI open-weight
  "gpt-oss",
  // Google
  "gemma-4",
  // MiniMax
  "minimax",
  // Microsoft — Phi-4 reasoning variants
  "phi4-reasoning",
  "phi-4-reasoning",
  // Alibaba — Marco-o1
  "marco-o1",
  // Skywork
  "skywork-o1",
  // LG AI Research — EXAONE Deep
  "exaone-deep",
  // Zhipu AI — GLM series (4+)
  "glm-4",
  "glm4",
  "glm-5",
  "glm5",
  // Deep Cogito — hybrid reasoning
  "cogito",
  // IBM — Granite reasoning variants
  "granite-reasoning",
  // Cognitive Computations — Dolphin R1 (reasoning-trained)
  "dolphin-r1",
  // Shanghai AI Lab — InternLM3 (deep thinking mode)
  "internlm3",
  // Moonshot AI — Kimi K2
  "kimi-k2",
] as const;

/**
 * Models trained for function calling / tool use.
 * Matched against the lowercased model key.
 */
export const FUNCTION_CALL_PATTERNS = [
  "qwen",
  "deepseek",
  "llama",
  "mistral",
  "gemma",
  "phi",
  "command",
  "hermes",
  "functionary",
  "gpt-oss",
  "nemotron",
  "minimax",
] as const;

/**
 * Models that support image/vision input.
 * Matched against the lowercased model key.
 */
export const VISION_PATTERNS = [
  "vl",
  "vision",
  "llava",
  "pixtral",
  "minicpm-v",
  "internvl",
  "cogvlm",
  "qwen2.5-vl",
  "qwen2-vl",
  "qwen3-vl",
  "qwen3.6-vl",
  "qwen3.6",
  "qwen-3.6",
  "molmo",
  "paligemma",
  "llama-3.2-vision",
  "llama-vision",
  "idefics",
  "phi-3-vision",
  "phi-3.5-vision",
  "phi-4-vision",
  "phi4mm",
  "minicpmv",
  "ovis",
  "deepseek-vl",
  "gemma-4",
] as const;

/**
 * Models that support video input.
 * Matched against the lowercased model key.
 */
export const VIDEO_PATTERNS = [
  "qwen2.5-vl",
  "qwen2-vl",
  "qwen3-vl",
  "qwen3.6-vl",
  "qwen3.6",
  "qwen-3.6",
  "llava-next-video",
  "llava-onevision",
  "internvl",
  "phi4mm",
  "gemma-4",
] as const;

/**
 * Models that support audio input.
 * Matched against the lowercased model key.
 */
export const AUDIO_PATTERNS = [
  "qwen2-audio",
  "qwen-audio",
  "salmonn",
  "ultravox",
  "phi4mm",
  "minicpmo",
  "whisper",
  "granite-speech",
  "kimi-audio",
  "qwen2.5-omni",
  "qwen3-omni",
  "gemma-4-e2b",
  "gemma-4-e4b",
] as const;
