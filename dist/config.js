// ─── Configuration & Reference Catalog ──────────────────────
// PROVIDERS
const PROVIDERS = {
    OPENAI: "openai",
    ANTHROPIC: "anthropic",
    GOOGLE: "google",
    ELEVENLABS: "elevenlabs",
    INWORLD: "inworld",
    LM_STUDIO: "lm-studio",
    VLLM: "vllm",
    OLLAMA: "ollama",
    LLAMA_CPP: "llama-cpp",
};
const PROVIDER_LIST = Object.values(PROVIDERS);
// ─── Input / Output modality constants ──────────────────────
const TYPES = {
    TEXT: "text",
    IMAGE: "image",
    AUDIO: "audio",
    VIDEO: "video",
    PDF: "pdf",
    EMBEDDING: "embedding",
};
// ─── Endpoint-based model category ──────────────────────────
const MODEL_TYPES = {
    CONVERSATION: "conversation",
    AUDIO: "audio",
    EMBED: "embed",
};
// ─── UNIFIED MODEL CATALOG ──────────────────────────────────
// Every model lives here with all its metadata.
// Helper functions below derive defaults, options, and pricing.
const MODELS = {
    // ----- OpenAI — Text Generation -----
    GPT_5_2: {
        name: "gpt-5.2",
        label: "GPT 5.2",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2025,
        defaultTemperature: 1.0,
        arena: {
            text: 1479,
            code: 1472,
            vision: 1271,
            document: 1412,
            search: 1219,
        },
        pricing: {
            inputPerMillion: 1.75,
            cachedInputPerMillion: 0.175,
            outputPerMillion: 14.0,
            webSearchPer1kCalls: 10.0,
        },
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
        thinking: true,
        verbosity: true,
        reasoningSummary: true,
        responsesAPI: true,
        webSearch: true,
        tools: ["Thinking", "Web Search", "Tool Calling", "File Search"],
    },
    GPT_5_MINI: {
        name: "gpt-5-mini",
        label: "GPT 5 Mini",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2025,
        defaultTemperature: 1.0,
        pricing: {
            inputPerMillion: 0.25,
            cachedInputPerMillion: 0.025,
            outputPerMillion: 2.0,
            webSearchPer1kCalls: 10.0,
        },
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
        thinking: true,
        webSearch: true,
        tools: ["Thinking", "Web Search", "Tool Calling", "File Search"],
    },
    GPT_5_NANO: {
        name: "gpt-5-nano",
        label: "GPT 5 Nano",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2025,
        defaultTemperature: 1.0,
        pricing: {
            inputPerMillion: 0.05,
            cachedInputPerMillion: 0.005,
            outputPerMillion: 0.4,
            webSearchPer1kCalls: 25.0,
        },
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
        thinking: false,
        webSearch: true,
        tools: ["Web Search", "Tool Calling", "File Search"],
    },
    // ----- Unlisted OpenAI Models (retained for historical cost tracking) -----
    GPT_41_MINI: {
        name: "gpt-4.1-mini",
        label: "GPT 4.1 Mini",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2025,
        listed: false,
        pricing: {
            inputPerMillion: 0.4,
            cachedInputPerMillion: 0.1,
            outputPerMillion: 1.6,
        },
        maxInputTokens: 1_047_576,
        maxOutputTokens: 32_768,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
    },
    GPT_41_NANO: {
        name: "gpt-4.1-nano",
        label: "GPT 4.1 Nano",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2025,
        listed: false,
        pricing: {
            inputPerMillion: 0.1,
            cachedInputPerMillion: 0.025,
            outputPerMillion: 0.4,
        },
        maxInputTokens: 1_047_576,
        maxOutputTokens: 32_768,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
    },
    GPT_4O: {
        name: "gpt-4o",
        label: "GPT 4o",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2024,
        listed: false,
        pricing: {
            inputPerMillion: 2.5,
            cachedInputPerMillion: 1.25,
            outputPerMillion: 10.0,
        },
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
    },
    GPT_4: {
        name: "gpt-4",
        label: "GPT 4",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2023,
        listed: false,
        pricing: { inputPerMillion: 30.0, outputPerMillion: 60.0 },
        maxInputTokens: 8_192,
        maxOutputTokens: 8_192,
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.TEXT],
        streaming: true,
    },
    GPT_53_CHAT: {
        name: "gpt-5.3-chat-latest",
        label: "GPT 5.3 Chat",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2026,
        defaultTemperature: 1.0,
        pricing: {
            inputPerMillion: 1.75,
            cachedInputPerMillion: 0.175,
            outputPerMillion: 14.0,
            webSearchPer1kCalls: 10.0,
        },
        maxInputTokens: 128_000,
        maxOutputTokens: 128_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
        thinking: true,
        webSearch: true,
        tools: ["Thinking", "Web Search", "Tool Calling", "File Search"],
    },
    GPT_53_CODEX: {
        name: "gpt-5.3-codex",
        label: "GPT 5.3 Codex",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        responsesAPI: true,
        year: 2026,
        defaultTemperature: 1.0,
        pricing: {
            inputPerMillion: 1.75,
            cachedInputPerMillion: 0.175,
            outputPerMillion: 14.0,
            webSearchPer1kCalls: 10.0,
        },
        maxInputTokens: 272_000,
        maxOutputTokens: 128_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
        thinking: true,
        webSearch: true,
        tools: ["Thinking", "Web Search", "Tool Calling", "File Search"],
    },
    GPT_54: {
        name: "gpt-5.4",
        label: "GPT 5.4",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        default: true,
        year: 2026,
        defaultTemperature: 1.0,
        arena: { text: 1479 },
        pricing: {
            inputPerMillion: 2.5,
            cachedInputPerMillion: 0.25,
            outputPerMillion: 15.0,
            inputOver272kPerMillion: 5.0,
            outputOver272kPerMillion: 22.5,
            webSearchPer1kCalls: 10.0,
        },
        maxInputTokens: 1_050_000,
        maxOutputTokens: 128_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
        thinking: true,
        verbosity: true,
        reasoningSummary: true,
        responsesAPI: true,
        webSearch: true,
        tools: [
            "Thinking",
            "Web Search",
            "Tool Calling",
            "File Search",
            "Computer Use",
        ],
    },
    GPT_54_PRO: {
        name: "gpt-5.4-pro",
        label: "GPT 5.4 Pro",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2026,
        defaultTemperature: 1.0,
        pricing: {
            inputPerMillion: 30.0,
            outputPerMillion: 180.0,
            inputOver272kPerMillion: 60.0,
            outputOver272kPerMillion: 270.0,
            webSearchPer1kCalls: 10.0,
        },
        maxInputTokens: 1_050_000,
        maxOutputTokens: 128_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
        thinking: true,
        verbosity: true,
        reasoningSummary: true,
        responsesAPI: true,
        webSearch: true,
        tools: [
            "Thinking",
            "Web Search",
            "Tool Calling",
            "File Search",
            "Computer Use",
        ],
    },
    GPT_54_MINI: {
        name: "gpt-5.4-mini",
        label: "GPT 5.4 Mini",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2026,
        defaultTemperature: 1.0,
        pricing: {
            inputPerMillion: 0.75,
            cachedInputPerMillion: 0.075,
            outputPerMillion: 4.5,
            webSearchPer1kCalls: 10.0,
        },
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
        thinking: true,
        verbosity: true,
        reasoningSummary: true,
        responsesAPI: true,
        webSearch: true,
        tools: [
            "Thinking",
            "Web Search",
            "Tool Calling",
            "File Search",
            "Computer Use",
        ],
    },
    GPT_54_NANO: {
        name: "gpt-5.4-nano",
        label: "GPT 5.4 Nano",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2026,
        defaultTemperature: 1.0,
        pricing: {
            inputPerMillion: 0.2,
            cachedInputPerMillion: 0.02,
            outputPerMillion: 1.25,
            webSearchPer1kCalls: 25.0,
        },
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: { image: { maxCount: 16, maxSizeMB: 20 } },
        streaming: true,
        thinking: false,
        responsesAPI: true,
        webSearch: true,
        tools: ["Web Search", "Tool Calling", "File Search"],
    },
    // ----- Anthropic — Text Generation -----
    HAIKU_45: {
        name: "claude-haiku-4-5-20251001",
        label: "Haiku 4.5",
        provider: PROVIDERS.ANTHROPIC,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2025,
        defaultTemperature: 1.0,
        arena: { document: 1426 },
        pricing: {
            inputPerMillion: 1.0,
            cachedInputPerMillion: 0.1,
            cacheWriteInputPerMillion: 1.25,
            outputPerMillion: 5.0,
        },
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: {
            image: { maxCount: 100, maxSizeMB: 32 },
            pdf: { maxCount: 5, maxSizeMB: 32 },
        },
        streaming: true,
        thinking: true,
        assistantImages: false,
        webSearch: true,
        codeExecution: true,
        tools: ["Thinking", "Web Search", "Tool Calling", "Code Execution"],
    },
    SONNET_45: {
        name: "claude-sonnet-4-5-20250929",
        label: "Sonnet 4.5",
        provider: PROVIDERS.ANTHROPIC,
        modelType: MODEL_TYPES.CONVERSATION,
        default: true,
        year: 2025,
        defaultTemperature: 1.0,
        arena: { document: 1450 },
        pricing: {
            inputPerMillion: 3.0,
            cachedInputPerMillion: 0.3,
            cacheWriteInputPerMillion: 3.75,
            outputPerMillion: 15.0,
        },
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: {
            image: { maxCount: 100, maxSizeMB: 32 },
            pdf: { maxCount: 5, maxSizeMB: 32 },
        },
        streaming: true,
        thinking: true,
        assistantImages: false,
        webSearch: true,
        webFetch: true,
        codeExecution: true,
        tools: [
            "Thinking",
            "Web Search",
            "Tool Calling",
            "Computer Use",
            "Code Execution",
        ],
    },
    SONNET_46: {
        name: "claude-sonnet-4-6",
        label: "Sonnet 4.6",
        provider: PROVIDERS.ANTHROPIC,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2026,
        defaultTemperature: 1.0,
        arena: { code: 1523, search: 1203 },
        pricing: {
            inputPerMillion: 3.0,
            cachedInputPerMillion: 0.3,
            cacheWriteInputPerMillion: 3.75,
            outputPerMillion: 15.0,
        },
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: {
            image: { maxCount: 100, maxSizeMB: 32 },
            pdf: { maxCount: 5, maxSizeMB: 32 },
        },
        streaming: true,
        thinking: true,
        assistantImages: false,
        webSearch: true,
        webFetch: true,
        codeExecution: true,
        tools: [
            "Thinking",
            "Web Search",
            "Tool Calling",
            "Computer Use",
            "Code Execution",
        ],
    },
    OPUS_45: {
        name: "claude-opus-4-5-20251101",
        label: "Opus 4.5",
        provider: PROVIDERS.ANTHROPIC,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2025,
        defaultTemperature: 1.0,
        arena: { text: 1470, code: 1475, document: 1474 },
        pricing: {
            inputPerMillion: 5.0,
            cachedInputPerMillion: 0.5,
            cacheWriteInputPerMillion: 6.25,
            outputPerMillion: 25.0,
        },
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: {
            image: { maxCount: 100, maxSizeMB: 32 },
            pdf: { maxCount: 5, maxSizeMB: 32 },
        },
        streaming: true,
        thinking: true,
        assistantImages: false,
        webSearch: true,
        webFetch: true,
        codeExecution: true,
        tools: [
            "Thinking",
            "Web Search",
            "Tool Calling",
            "Computer Use",
            "Code Execution",
        ],
    },
    OPUS_46: {
        name: "claude-opus-4-6",
        label: "Opus 4.6",
        provider: PROVIDERS.ANTHROPIC,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2026,
        defaultTemperature: 1.0,
        arena: { text: 1504, code: 1555, document: 1525, search: 1255 },
        pricing: {
            inputPerMillion: 5.0,
            cachedInputPerMillion: 0.5,
            cacheWriteInputPerMillion: 6.25,
            outputPerMillion: 25.0,
        },
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT],
        mediaLimits: {
            image: { maxCount: 100, maxSizeMB: 32 },
            pdf: { maxCount: 5, maxSizeMB: 32 },
        },
        streaming: true,
        thinking: true,
        assistantImages: false,
        webSearch: true,
        webFetch: true,
        codeExecution: true,
        tools: [
            "Thinking",
            "Web Search",
            "Tool Calling",
            "Computer Use",
            "Code Execution",
        ],
    },
    // ----- Google — Text Generation -----
    GEMINI_3_FLASH: {
        name: "gemini-3-flash-preview",
        label: "Gemini 3 Flash",
        provider: PROVIDERS.GOOGLE,
        modelType: MODEL_TYPES.CONVERSATION,
        default: true,
        year: 2025,
        defaultTemperature: 1.0,
        arena: {
            text: 1473,
            code: 1442,
            vision: 1276,
            document: 1422,
            search: 1218,
        },
        pricing: {
            inputPerMillion: 0.5,
            audioInputPerMillion: 1.0,
            outputPerMillion: 3.0,
        },
        maxInputTokens: 1_048_576,
        maxOutputTokens: 65_536,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO, TYPES.PDF],
        outputTypes: [TYPES.TEXT],
        mediaLimits: {
            image: { maxCount: 3000, maxSizeMB: 100 },
            audio: { maxCount: 50, maxSizeMB: 100 },
            video: { maxCount: 10, maxSizeMB: 100 },
            pdf: { maxCount: 50, maxSizeMB: 100 },
        },
        streaming: true,
        thinking: true,
        thinkingLevels: ["minimal", "low", "high"],
        webSearch: "Google Search",
        codeExecution: true,
        urlContext: true,
        tools: [
            "Thinking",
            "Google Search",
            "Tool Calling",
            "Code Execution",
            "URL Context",
        ],
    },
    GEMINI_3_PRO: {
        name: "gemini-3-pro-preview",
        label: "Gemini 3 Pro",
        provider: PROVIDERS.GOOGLE,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2025,
        defaultTemperature: 1.0,
        arena: {
            text: 1485,
            code: 1442,
            vision: 1288,
            document: 1444,
            search: 1214,
        },
        pricing: {
            inputPerMillion: 2.0,
            audioInputPerMillion: 4.0,
            outputPerMillion: 12.0,
        },
        maxInputTokens: 1_048_576,
        maxOutputTokens: 65_536,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO, TYPES.PDF],
        outputTypes: [TYPES.TEXT],
        mediaLimits: {
            image: { maxCount: 3000, maxSizeMB: 100 },
            audio: { maxCount: 50, maxSizeMB: 100 },
            video: { maxCount: 10, maxSizeMB: 100 },
            pdf: { maxCount: 50, maxSizeMB: 100 },
        },
        streaming: true,
        thinking: true,
        thinkingLevels: ["minimal", "low", "high"],
        webSearch: "Google Search",
        codeExecution: true,
        urlContext: true,
        tools: [
            "Thinking",
            "Google Search",
            "Tool Calling",
            "Code Execution",
            "URL Context",
        ],
    },
    GEMINI_31_PRO: {
        name: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
        provider: PROVIDERS.GOOGLE,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2026,
        defaultTemperature: 1.0,
        arena: { text: 1500, code: 1461, vision: 1278, document: 1462 },
        pricing: {
            inputPerMillion: 2.0,
            audioInputPerMillion: 4.0,
            outputPerMillion: 12.0,
            inputOver200kPerMillion: 4.0,
            outputOver200kPerMillion: 18.0,
        },
        maxInputTokens: 1_048_576,
        maxOutputTokens: 65_536,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO, TYPES.PDF],
        outputTypes: [TYPES.TEXT],
        mediaLimits: {
            image: { maxCount: 3000, maxSizeMB: 100 },
            audio: { maxCount: 50, maxSizeMB: 100 },
            video: { maxCount: 10, maxSizeMB: 100 },
            pdf: { maxCount: 50, maxSizeMB: 100 },
        },
        streaming: true,
        thinking: true,
        thinkingLevels: ["low", "medium", "high"],
        webSearch: "Google Search",
        codeExecution: true,
        urlContext: true,
        tools: [
            "Thinking",
            "Google Search",
            "Tool Calling",
            "Code Execution",
            "URL Context",
        ],
    },
    GEMINI_31_FLASH_LIVE: {
        name: "gemini-3.1-flash-live-preview",
        label: "Gemini 3.1 Flash Live",
        provider: PROVIDERS.GOOGLE,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2026,
        defaultTemperature: 1.0,
        pricing: {
            inputPerMillion: 0.75,
            audioInputPerMillion: 3.0,
            outputPerMillion: 4.5,
            audioOutputPerMillion: 12.0,
        },
        maxInputTokens: 131_072,
        maxOutputTokens: 65_536,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO],
        outputTypes: [TYPES.TEXT, TYPES.AUDIO],
        mediaLimits: {
            image: { maxCount: 3000, maxSizeMB: 100 },
            audio: { maxCount: 50, maxSizeMB: 100 },
            video: { maxCount: 10, maxSizeMB: 100 },
        },
        streaming: true,
        thinking: true,
        thinkingLevels: ["minimal", "low", "medium", "high"],
        liveAPI: true,
        webSearch: "Google Search",
        tools: ["Thinking", "Google Search", "Tool Calling"],
    },
    // ----- Text-to-Speech -----
    GPT_4O_MINI_TTS: {
        name: "gpt-4o-mini-tts",
        label: "GPT 4o Mini TTS",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.AUDIO,
        year: 2025,
        default: true,
        pricing: {
            inputPerMillion: 0.6,
            audioOutputPerMillion: 12.0,
            perMinute: 0.015,
        },
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.AUDIO],
        streaming: true,
    },
    GEMINI_2_FLASH_LITE_PREVIEW_TTS: {
        name: "gemini-2.0-flash-lite-preview-tts",
        label: "Gemini 2.0 Flash Lite TTS",
        provider: PROVIDERS.GOOGLE,
        year: 2025,
        modelType: MODEL_TYPES.AUDIO,
        pricing: { inputPerMillion: 0.075, audioOutputPerMillion: 0.3 },
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.AUDIO],
        streaming: true,
    },
    GEMINI_25_FLASH_LITE_TTS: {
        name: "gemini-2.5-flash-lite-preview-tts",
        label: "Gemini 2.5 Flash Lite TTS",
        provider: PROVIDERS.GOOGLE,
        year: 2025,
        modelType: MODEL_TYPES.AUDIO,
        pricing: { inputPerMillion: 0.3, audioOutputPerMillion: 2.5 },
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.AUDIO],
        streaming: true,
    },
    GEMINI_25_FLASH_TTS: {
        name: "gemini-2.5-flash-preview-tts",
        label: "Gemini 2.5 Flash TTS",
        provider: PROVIDERS.GOOGLE,
        year: 2025,
        modelType: MODEL_TYPES.AUDIO,
        pricing: { inputPerMillion: 0.5, audioOutputPerMillion: 10.0 },
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.AUDIO],
        streaming: true,
    },
    GEMINI_25_PRO_TTS: {
        name: "gemini-2.5-pro-preview-tts",
        label: "Gemini 2.5 Pro TTS",
        provider: PROVIDERS.GOOGLE,
        modelType: MODEL_TYPES.AUDIO,
        year: 2025,
        default: true,
        pricing: { inputPerMillion: 1.0, audioOutputPerMillion: 20.0 },
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.AUDIO],
        streaming: true,
    },
    ESPEAKNG: {
        name: "espeak-ng",
        label: "eSpeak NG",
        provider: PROVIDERS.GOOGLE,
        year: 2015,
        modelType: MODEL_TYPES.AUDIO,
        listed: false,
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.AUDIO],
        streaming: false,
    },
    ELEVEN_TURBO_V2: {
        name: "eleven_turbo_v2",
        label: "Eleven Turbo v2",
        provider: PROVIDERS.ELEVENLABS,
        year: 2023,
        modelType: MODEL_TYPES.AUDIO,
        default: true,
        pricing: { perCharacter: 0.00005 },
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.AUDIO],
        streaming: true,
    },
    INWORLD_TTS_1_5_MAX: {
        name: "inworld-tts-1.5-max",
        label: "Inworld TTS 1.5 Max",
        provider: PROVIDERS.INWORLD,
        year: 2025,
        modelType: MODEL_TYPES.AUDIO,
        default: true,
        pricing: { perCharacter: 0.00001, perMinute: 0.01 },
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.AUDIO],
        streaming: true,
    },
    INWORLD_TTS_1_5_MINI: {
        name: "inworld-tts-1.5-mini",
        label: "Inworld TTS 1.5 Mini",
        provider: PROVIDERS.INWORLD,
        year: 2025,
        modelType: MODEL_TYPES.AUDIO,
        pricing: { perCharacter: 0.000005, perMinute: 0.005 },
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.AUDIO],
        streaming: true,
    },
    // ----- Text-to-Image -----
    GPT_IMAGE_15: {
        name: "gpt-image-1.5",
        label: "GPT Image 1.5",
        provider: PROVIDERS.OPENAI,
        year: 2025,
        modelType: MODEL_TYPES.CONVERSATION,
        defaultTemperature: 1.0,
        arena: { image: 1307, imageEdit: 1348 },
        pricing: {
            inputPerMillion: 5.0,
            cachedInputPerMillion: 1.25,
            outputPerMillion: 10.0,
            imageInputPerMillion: 8.0,
            cachedImageInputPerMillion: 2.0,
            imageOutputPerMillion: 32.0,
        },
        imageTokensPerImage: 1056,
        maxInputTokens: 32_768,
        maxOutputTokens: 32_768,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT, TYPES.IMAGE],
        imageAPI: true,
        supportsSystemPrompt: false,
        tools: ["Image Generation"],
    },
    GEMINI_3_PRO_IMAGE: {
        name: "gemini-3-pro-image-preview",
        label: "Gemini 3 Pro Image",
        provider: PROVIDERS.GOOGLE,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2025,
        default: true,
        defaultTemperature: 1.0,
        arena: { image: 1233, imageEdit: 1391 },
        pricing: {
            inputPerMillion: 2.0,
            imageInputPerMillion: 2.0,
            outputPerMillion: 12.0,
            imageOutputPerMillion: 120.0,
        },
        imageTokensPerImage: 1120,
        maxInputTokens: 1_048_576,
        maxOutputTokens: 32_768,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE],
        outputTypes: [TYPES.TEXT, TYPES.IMAGE],
        streaming: false,
        thinking: true,
        webSearch: true,
        tools: ["Thinking", "Image Generation", "Web Search"],
    },
    GEMINI_31_FLASH_IMAGE: {
        name: "gemini-3.1-flash-image-preview",
        label: "Gemini 3.1 Flash Image",
        provider: PROVIDERS.GOOGLE,
        modelType: MODEL_TYPES.CONVERSATION,
        year: 2026,
        defaultTemperature: 1.0,
        arena: { image: 1268, imageEdit: 1388 },
        pricing: {
            inputPerMillion: 0.5,
            imageInputPerMillion: 0.5,
            outputPerMillion: 3.0,
            imageOutputPerMillion: 60.0,
        },
        imageTokensPerImage: 1120,
        maxInputTokens: 131_072,
        maxOutputTokens: 32_768,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.PDF],
        outputTypes: [TYPES.TEXT, TYPES.IMAGE],
        streaming: false,
        thinking: true,
        webSearch: true,
        tools: ["Thinking", "Image Generation", "Web Search"],
    },
    // ----- Embeddings -----
    TEXT_EMBEDDING_3_SMALL: {
        name: "text-embedding-3-small",
        label: "Embedding 3 Small",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.EMBED,
        year: 2024,
        default: true,
        pricing: { inputPerMillion: 0.02 },
        maxInputTokens: 8_191,
        dimensions: 1536,
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.EMBEDDING],
    },
    TEXT_EMBEDDING_3_LARGE: {
        name: "text-embedding-3-large",
        label: "Embedding 3 Large",
        provider: PROVIDERS.OPENAI,
        year: 2024,
        modelType: MODEL_TYPES.EMBED,
        pricing: { inputPerMillion: 0.13 },
        maxInputTokens: 8_191,
        dimensions: 3072,
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.EMBEDDING],
    },
    TEXT_EMBEDDING_ADA_002: {
        name: "text-embedding-ada-002",
        label: "Ada 002",
        provider: PROVIDERS.OPENAI,
        year: 2022,
        modelType: MODEL_TYPES.EMBED,
        pricing: { inputPerMillion: 0.1 },
        maxInputTokens: 8_191,
        dimensions: 1536,
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.EMBEDDING],
    },
    GEMINI_EMBEDDING_2: {
        name: "gemini-embedding-2-preview",
        label: "Gemini Embedding 2",
        provider: PROVIDERS.GOOGLE,
        modelType: MODEL_TYPES.EMBED,
        year: 2026,
        default: true,
        pricing: { inputPerMillion: 0.2 },
        maxInputTokens: 8_192,
        dimensions: 3072,
        inputTypes: [TYPES.TEXT, TYPES.IMAGE, TYPES.AUDIO, TYPES.VIDEO, TYPES.PDF],
        outputTypes: [TYPES.EMBEDDING],
    },
    GEMINI_EMBEDDING_001: {
        name: "gemini-embedding-001",
        label: "Gemini Embedding",
        provider: PROVIDERS.GOOGLE,
        modelType: MODEL_TYPES.EMBED,
        year: 2025,
        pricing: { inputPerMillion: 0.2 },
        maxInputTokens: 2_048,
        dimensions: 3072,
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.EMBEDDING],
    },
    // ----- Speech-to-Text (Audio → Text) -----
    GPT_4O_TRANSCRIBE: {
        name: "gpt-4o-transcribe",
        label: "GPT-4o Transcribe",
        provider: PROVIDERS.OPENAI,
        modelType: MODEL_TYPES.AUDIO,
        year: 2025,
        default: true,
        pricing: {
            audioInputPerMillion: 2.5,
            outputPerMillion: 10.0,
            perMinute: 0.006,
        },
        inputTypes: [TYPES.AUDIO],
        outputTypes: [TYPES.TEXT],
    },
    GPT_4O_MINI_TRANSCRIBE: {
        name: "gpt-4o-mini-transcribe",
        label: "GPT-4o Mini Transcribe",
        provider: PROVIDERS.OPENAI,
        year: 2025,
        modelType: MODEL_TYPES.AUDIO,
        pricing: {
            audioInputPerMillion: 1.25,
            outputPerMillion: 5.0,
            perMinute: 0.003,
        },
        inputTypes: [TYPES.AUDIO],
        outputTypes: [TYPES.TEXT],
    },
    WHISPER_1: {
        name: "whisper-1",
        label: "Whisper V2",
        provider: PROVIDERS.OPENAI,
        year: 2022,
        modelType: MODEL_TYPES.AUDIO,
        pricing: { perMinute: 0.006 },
        inputTypes: [TYPES.AUDIO],
        outputTypes: [TYPES.TEXT],
    },
    GEMINI_3_FLASH_STT: {
        name: "gemini-3-flash-preview",
        label: "Gemini 3 Flash",
        provider: PROVIDERS.GOOGLE,
        modelType: MODEL_TYPES.AUDIO,
        year: 2025,
        default: true,
        pricing: { audioInputPerMillion: 1.0, outputPerMillion: 3.0 },
        inputTypes: [TYPES.AUDIO],
        outputTypes: [TYPES.TEXT],
    },
    GEMINI_3_PRO_STT: {
        name: "gemini-3-pro-preview",
        label: "Gemini 3 Pro",
        provider: PROVIDERS.GOOGLE,
        year: 2025,
        modelType: MODEL_TYPES.AUDIO,
        pricing: { audioInputPerMillion: 4.0, outputPerMillion: 12.0 },
        inputTypes: [TYPES.AUDIO],
        outputTypes: [TYPES.TEXT],
    },
};
// ─── derive defaults, options, pricing from MODELS ──────────
/**
 * Get all models whose inputTypes includes `inputType`
 * and whose outputTypes includes `outputType`.
 */
function getModels(inputType, outputType) {
    return Object.values(MODELS).filter((m) => m.inputTypes.includes(inputType) && m.outputTypes.includes(outputType));
}
/**
 * Get listed model options grouped by provider
 * for a given input→output type combination.
 * Returns: { [provider]: [{ name, label, ... }, ...] }
 */
function getModelOptions(inputType, outputType) {
    const opts = {};
    for (const m of getModels(inputType, outputType)) {
        const mAny = m;
        if (mAny.listed !== false) {
            const entry = { name: m.name, label: m.label };
            if (mAny.thinking)
                entry.thinking = true;
            if (m.inputTypes?.includes(TYPES.IMAGE))
                entry.vision = true;
            if (mAny.webSearch)
                entry.webSearch = mAny.webSearch;
            if (m.inputTypes)
                entry.inputTypes = m.inputTypes;
            if (m.outputTypes)
                entry.outputTypes = m.outputTypes;
            if (mAny.tools)
                entry.tools = mAny.tools;
            if (mAny.pricing)
                entry.pricing = mAny.pricing;
            if (mAny.arena)
                entry.arena = mAny.arena;
            if (mAny.maxInputTokens)
                entry.contextLength = mAny.maxInputTokens;
            if (mAny.maxOutputTokens)
                entry.maxOutputTokens = mAny.maxOutputTokens;
            if (mAny.assistantImages === false)
                entry.assistantImages = false;
            // JSON mode: OpenAI + Google support response_format / responseMimeType
            if (m.modelType === MODEL_TYPES.CONVERSATION &&
                [PROVIDERS.OPENAI, PROVIDERS.GOOGLE].includes(m.provider)) {
                entry.jsonMode = true;
            }
            if (mAny.codeExecution)
                entry.codeExecution = true;
            if (mAny.webFetch)
                entry.webFetch = true;
            if (mAny.urlContext)
                entry.urlContext = true;
            if (mAny.defaultTemperature !== undefined)
                entry.defaultTemperature = mAny.defaultTemperature;
            if (mAny.verbosity)
                entry.verbosity = true;
            if (mAny.reasoningSummary)
                entry.reasoningSummary = true;
            if (mAny.responsesAPI)
                entry.responsesAPI = true;
            if (mAny.size)
                entry.size = mAny.size;
            if (m.modelType)
                entry.modelType = m.modelType;
            if (mAny.liveAPI)
                entry.liveAPI = true;
            if (mAny.thinkingLevels)
                entry.thinkingLevels = mAny.thinkingLevels;
            if (mAny.mediaLimits)
                entry.mediaLimits = mAny.mediaLimits;
            if (mAny.year)
                entry.year = mAny.year;
            // System prompt support: true for chat models, false for image-only/TTS/embedding APIs
            entry.supportsSystemPrompt =
                mAny.supportsSystemPrompt !== undefined
                    ? mAny.supportsSystemPrompt
                    : m.outputTypes.includes(TYPES.TEXT);
            (opts[m.provider] ??= []).push(entry);
        }
    }
    return opts;
}
/**
 * Get the default model name per provider
 * for a given input→output type combination.
 * Returns: { [provider]: modelName }
 */
function getDefaultModels(inputType, outputType) {
    const defaults = {};
    for (const m of getModels(inputType, outputType)) {
        const mAny = m;
        if (mAny.default) {
            defaults[m.provider] = m.name;
        }
    }
    return defaults;
}
/**
 * Get pricing map for a given input→output type combination.
 * Returns: { [modelName]: pricingObject }
 */
function getPricing(inputType, outputType) {
    const pricing = {};
    for (const m of getModels(inputType, outputType)) {
        const mAny = m;
        if (mAny.pricing) {
            pricing[m.name] = mAny.pricing;
        }
    }
    return pricing;
}
/**
 * Find a single model object by its API name.
 * Returns the model object or null.
 */
function getModelByName(name) {
    return Object.values(MODELS).find((m) => m.name === name) || null;
}
// ─── VOICES (per provider — applies to TEXT → AUDIO models) ─
const OPENAI_VOICES = [
    { name: "alloy", gender: "Neutral" },
    { name: "ash", gender: "Male" },
    { name: "ballad", gender: "Male" },
    { name: "coral", gender: "Female" },
    { name: "echo", gender: "Male" },
    { name: "fable", gender: "Male" },
    { name: "nova", gender: "Female" },
    { name: "onyx", gender: "Male" },
    { name: "sage", gender: "Female" },
    { name: "shimmer", gender: "Female" },
    { name: "verse", gender: "Male" },
    { name: "marin", gender: "Female" },
    { name: "cedar", gender: "Male" },
];
const GOOGLE_VOICES = [
    { name: "Achernar", gender: "Female" },
    { name: "Achird", gender: "Male" },
    { name: "Algenib", gender: "Male" },
    { name: "Algieba", gender: "Male" },
    { name: "Alnilam", gender: "Male" },
    { name: "Aoede", gender: "Female" },
    { name: "Autonoe", gender: "Female" },
    { name: "Callirrhoe", gender: "Female" },
    { name: "Charon", gender: "Male" },
    { name: "Despina", gender: "Female" },
    { name: "Enceladus", gender: "Male" },
    { name: "Erinome", gender: "Female" },
    { name: "Fenrir", gender: "Male" },
    { name: "Gacrux", gender: "Female" },
    { name: "Iapetus", gender: "Male" },
    { name: "Kore", gender: "Female" },
    { name: "Laomedeia", gender: "Female" },
    { name: "Leda", gender: "Female" },
    { name: "Orus", gender: "Male" },
    { name: "Pulcherrima", gender: "Female" },
    { name: "Puck", gender: "Male" },
    { name: "Rasalgethi", gender: "Male" },
    { name: "Sadachbia", gender: "Male" },
    { name: "Sadaltager", gender: "Male" },
    { name: "Schedar", gender: "Male" },
    { name: "Sulafat", gender: "Female" },
    { name: "Umbriel", gender: "Male" },
    { name: "Vindemiatrix", gender: "Female" },
    { name: "Zephyr", gender: "Female" },
    { name: "Zubenelgenubi", gender: "Male" },
];
const ELEVENLABS_VOICES = [
    { name: "21m00Tcm4TlvDq8ikWAM", label: "Rachel", gender: "Female" },
    { name: "EXAVITQu4vr4xnSDxMaL", label: "Bella", gender: "Female" },
    { name: "ErXwobaYiN019PkySvjV", label: "Antoni", gender: "Male" },
    { name: "MF3mGyEYCl7XYWbV9V6O", label: "Elli", gender: "Female" },
    { name: "TxGEqnHWrfWFTfGW9XjX", label: "Josh", gender: "Male" },
    { name: "VR6AewLTigWG4xSOukaG", label: "Arnold", gender: "Male" },
    { name: "pNInz6obpgDQGcFmaJgB", label: "Adam", gender: "Male" },
    { name: "yoZ06aMxZJJ28mfd3POQ", label: "Sam", gender: "Male" },
];
const INWORLD_VOICES = [
    {
        name: "default-wf7_kdeq9hcrw0dojoklzq__bender",
        gender: "Male",
        description: "Bender",
    },
    {
        name: "Alex",
        gender: "Male",
        description: "Energetic and expressive mid-range male voice, with a mildly nasal quality",
    },
    {
        name: "Ashley",
        gender: "Female",
        description: "A warm, natural female voice",
    },
    {
        name: "Craig",
        gender: "Male",
        description: "Older British male with a refined and articulate voice",
    },
    {
        name: "Deborah",
        gender: "Female",
        description: "Gentle and elegant female voice",
    },
    {
        name: "Dennis",
        gender: "Male",
        description: "Middle-aged man with a smooth, calm and friendly voice",
    },
    {
        name: "Edward",
        gender: "Male",
        description: "Male with a fast-talking, emphatic and streetwise tone",
    },
    {
        name: "Hades",
        gender: "Male",
        description: "Commanding and gruff male voice, think an omniscient narrator or castle guard",
    },
    {
        name: "Pixie",
        gender: "Female",
        description: "High-pitched, childlike female voice with a squeaky quality - great for a cartoon",
    },
    {
        name: "Mark",
        gender: "Male",
        description: "Energetic, expressive man with a rapid-fire delivery",
    },
    {
        name: "Olivia",
        gender: "Female",
        description: "Young, British female with an upbeat, friendly tone",
    },
    {
        name: "Ronald",
        gender: "Male",
        description: "Confident, British man with a deep, gravelly voice",
    },
    {
        name: "Sarah",
        gender: "Female",
        description: "Fast-talking young adult woman, with a questioning and curious tone",
    },
    {
        name: "Theodore",
        gender: "Male",
        description: "Gravelly male voice, with a time-worn quality",
    },
    {
        name: "Timothy",
        gender: "Male",
        description: "Lively, upbeat American male voice",
    },
    {
        name: "Wendy",
        gender: "Female",
        description: "Posh, middle-aged British female voice",
    },
    {
        name: "Dominus",
        gender: "Male",
        description: "Robotic, deep male voice with a menacing quality. Perfect for villains",
    },
    {
        name: "Hana",
        gender: "Female",
        description: "Bright, expressive young female voice, perfect for storytelling, gaming, and playing",
    },
    {
        name: "Clive",
        gender: "Male",
        description: "British-accented English-language male voice with a calm, cordial quality",
    },
    {
        name: "Carter",
        gender: "Male",
        description: "Energetic, mature radio announcer-style male voice, great for storytelling",
    },
    {
        name: "Blake",
        gender: "Male",
        description: "Rich, intimate male voice, perfect for audiobooks, romantic content, and reassuring",
    },
    {
        name: "Luna",
        gender: "Female",
        description: "Calm, relaxing female voice, perfect for meditations, sleep stories, and mindful",
    },
];
const VOICES = {
    [PROVIDERS.OPENAI]: OPENAI_VOICES,
    [PROVIDERS.GOOGLE]: GOOGLE_VOICES,
    [PROVIDERS.ELEVENLABS]: ELEVENLABS_VOICES,
    [PROVIDERS.INWORLD]: INWORLD_VOICES,
};
const DEFAULT_VOICES = {
    [PROVIDERS.OPENAI]: "echo",
    [PROVIDERS.GOOGLE]: "Kore",
    [PROVIDERS.ELEVENLABS]: "21m00Tcm4TlvDq8ikWAM",
    [PROVIDERS.INWORLD]: "Dennis",
};
// ─── EXPORTS ────────────────────────────────────────────────
export { 
// Providers
PROVIDERS, PROVIDER_LIST, 
// Types
TYPES, MODEL_TYPES, 
// Models
MODELS, 
// Helpers
getModels, getModelOptions, getDefaultModels, getPricing, getModelByName, 
// Voices
VOICES, DEFAULT_VOICES, };
//# sourceMappingURL=config.js.map