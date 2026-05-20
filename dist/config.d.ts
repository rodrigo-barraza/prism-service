declare const PROVIDERS: {
    OPENAI: string;
    ANTHROPIC: string;
    GOOGLE: string;
    ELEVENLABS: string;
    INWORLD: string;
    LM_STUDIO: string;
    VLLM: string;
    OLLAMA: string;
    LLAMA_CPP: string;
};
declare const PROVIDER_LIST: string[];
declare const TYPES: {
    TEXT: string;
    IMAGE: string;
    AUDIO: string;
    VIDEO: string;
    PDF: string;
    EMBEDDING: string;
};
declare const MODEL_TYPES: {
    CONVERSATION: string;
    AUDIO: string;
    EMBED: string;
};
declare const MODELS: {
    GPT_5_2: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        arena: {
            text: number;
            code: number;
            vision: number;
            document: number;
            search: number;
        };
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
            webSearchPer1kCalls: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        verbosity: boolean;
        reasoningSummary: boolean;
        responsesAPI: boolean;
        webSearch: boolean;
        tools: string[];
    };
    GPT_5_MINI: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
            webSearchPer1kCalls: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        webSearch: boolean;
        tools: string[];
    };
    GPT_5_NANO: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
            webSearchPer1kCalls: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        webSearch: boolean;
        tools: string[];
    };
    GPT_41_MINI: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        listed: boolean;
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
    };
    GPT_41_NANO: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        listed: boolean;
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
    };
    GPT_4O: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        listed: boolean;
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
    };
    GPT_4: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        listed: boolean;
        pricing: {
            inputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
    };
    GPT_53_CHAT: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
            webSearchPer1kCalls: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        webSearch: boolean;
        tools: string[];
    };
    GPT_53_CODEX: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        responsesAPI: boolean;
        year: number;
        defaultTemperature: number;
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
            webSearchPer1kCalls: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        webSearch: boolean;
        tools: string[];
    };
    GPT_54: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        default: boolean;
        year: number;
        defaultTemperature: number;
        arena: {
            text: number;
        };
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
            inputOver272kPerMillion: number;
            outputOver272kPerMillion: number;
            webSearchPer1kCalls: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        verbosity: boolean;
        reasoningSummary: boolean;
        responsesAPI: boolean;
        webSearch: boolean;
        tools: string[];
    };
    GPT_54_PRO: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        pricing: {
            inputPerMillion: number;
            outputPerMillion: number;
            inputOver272kPerMillion: number;
            outputOver272kPerMillion: number;
            webSearchPer1kCalls: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        verbosity: boolean;
        reasoningSummary: boolean;
        responsesAPI: boolean;
        webSearch: boolean;
        tools: string[];
    };
    GPT_54_MINI: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
            webSearchPer1kCalls: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        verbosity: boolean;
        reasoningSummary: boolean;
        responsesAPI: boolean;
        webSearch: boolean;
        tools: string[];
    };
    GPT_54_NANO: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
            webSearchPer1kCalls: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        responsesAPI: boolean;
        webSearch: boolean;
        tools: string[];
    };
    HAIKU_45: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        arena: {
            document: number;
        };
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            cacheWriteInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
            pdf: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        assistantImages: boolean;
        webSearch: boolean;
        codeExecution: boolean;
        tools: string[];
    };
    SONNET_45: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        default: boolean;
        year: number;
        defaultTemperature: number;
        arena: {
            document: number;
        };
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            cacheWriteInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
            pdf: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        assistantImages: boolean;
        webSearch: boolean;
        webFetch: boolean;
        codeExecution: boolean;
        tools: string[];
    };
    SONNET_46: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        arena: {
            code: number;
            search: number;
        };
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            cacheWriteInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
            pdf: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        assistantImages: boolean;
        webSearch: boolean;
        webFetch: boolean;
        codeExecution: boolean;
        tools: string[];
    };
    OPUS_45: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        arena: {
            text: number;
            code: number;
            document: number;
        };
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            cacheWriteInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
            pdf: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        assistantImages: boolean;
        webSearch: boolean;
        webFetch: boolean;
        codeExecution: boolean;
        tools: string[];
    };
    OPUS_46: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        arena: {
            text: number;
            code: number;
            document: number;
            search: number;
        };
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            cacheWriteInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
            pdf: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        assistantImages: boolean;
        webSearch: boolean;
        webFetch: boolean;
        codeExecution: boolean;
        tools: string[];
    };
    GEMINI_3_FLASH: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        default: boolean;
        year: number;
        defaultTemperature: number;
        arena: {
            text: number;
            code: number;
            vision: number;
            document: number;
            search: number;
        };
        pricing: {
            inputPerMillion: number;
            audioInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
            audio: {
                maxCount: number;
                maxSizeMB: number;
            };
            video: {
                maxCount: number;
                maxSizeMB: number;
            };
            pdf: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        thinkingLevels: string[];
        webSearch: string;
        codeExecution: boolean;
        urlContext: boolean;
        tools: string[];
    };
    GEMINI_3_PRO: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        arena: {
            text: number;
            code: number;
            vision: number;
            document: number;
            search: number;
        };
        pricing: {
            inputPerMillion: number;
            audioInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
            audio: {
                maxCount: number;
                maxSizeMB: number;
            };
            video: {
                maxCount: number;
                maxSizeMB: number;
            };
            pdf: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        thinkingLevels: string[];
        webSearch: string;
        codeExecution: boolean;
        urlContext: boolean;
        tools: string[];
    };
    GEMINI_31_PRO: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        arena: {
            text: number;
            code: number;
            vision: number;
            document: number;
        };
        pricing: {
            inputPerMillion: number;
            audioInputPerMillion: number;
            outputPerMillion: number;
            inputOver200kPerMillion: number;
            outputOver200kPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
            audio: {
                maxCount: number;
                maxSizeMB: number;
            };
            video: {
                maxCount: number;
                maxSizeMB: number;
            };
            pdf: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        thinkingLevels: string[];
        webSearch: string;
        codeExecution: boolean;
        urlContext: boolean;
        tools: string[];
    };
    GEMINI_31_FLASH_LIVE: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        pricing: {
            inputPerMillion: number;
            audioInputPerMillion: number;
            outputPerMillion: number;
            audioOutputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
            audio: {
                maxCount: number;
                maxSizeMB: number;
            };
            video: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        thinkingLevels: string[];
        liveAPI: boolean;
        webSearch: string;
        tools: string[];
    };
    GEMINI_35_FLASH: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        default: boolean;
        year: number;
        defaultTemperature: number;
        arena: {
            text: number;
            code: number;
            vision: number;
            document: number;
        };
        pricing: {
            inputPerMillion: number;
            audioInputPerMillion: number;
            outputPerMillion: number;
        };
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        mediaLimits: {
            image: {
                maxCount: number;
                maxSizeMB: number;
            };
            audio: {
                maxCount: number;
                maxSizeMB: number;
            };
            video: {
                maxCount: number;
                maxSizeMB: number;
            };
            pdf: {
                maxCount: number;
                maxSizeMB: number;
            };
        };
        streaming: boolean;
        thinking: boolean;
        thinkingLevels: string[];
        webSearch: string;
        codeExecution: boolean;
        urlContext: boolean;
        tools: string[];
    };
    GPT_4O_MINI_TTS: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        default: boolean;
        pricing: {
            inputPerMillion: number;
            audioOutputPerMillion: number;
            perMinute: number;
        };
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
    };
    GEMINI_2_FLASH_LITE_PREVIEW_TTS: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        pricing: {
            inputPerMillion: number;
            audioOutputPerMillion: number;
        };
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
    };
    GEMINI_25_FLASH_LITE_TTS: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        pricing: {
            inputPerMillion: number;
            audioOutputPerMillion: number;
        };
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
    };
    GEMINI_25_FLASH_TTS: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        pricing: {
            inputPerMillion: number;
            audioOutputPerMillion: number;
        };
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
    };
    GEMINI_25_PRO_TTS: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        default: boolean;
        pricing: {
            inputPerMillion: number;
            audioOutputPerMillion: number;
        };
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
    };
    ESPEAKNG: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        listed: boolean;
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
    };
    ELEVEN_TURBO_V2: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        default: boolean;
        pricing: {
            perCharacter: number;
        };
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
    };
    INWORLD_TTS_1_5_MAX: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        default: boolean;
        pricing: {
            perCharacter: number;
            perMinute: number;
        };
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
    };
    INWORLD_TTS_1_5_MINI: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        pricing: {
            perCharacter: number;
            perMinute: number;
        };
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
    };
    GPT_IMAGE_15: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        defaultTemperature: number;
        arena: {
            image: number;
            imageEdit: number;
        };
        pricing: {
            inputPerMillion: number;
            cachedInputPerMillion: number;
            outputPerMillion: number;
            imageInputPerMillion: number;
            cachedImageInputPerMillion: number;
            imageOutputPerMillion: number;
        };
        imageTokensPerImage: number;
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        imageAPI: boolean;
        supportsSystemPrompt: boolean;
        tools: string[];
    };
    GEMINI_3_PRO_IMAGE: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        default: boolean;
        defaultTemperature: number;
        arena: {
            image: number;
            imageEdit: number;
        };
        pricing: {
            inputPerMillion: number;
            imageInputPerMillion: number;
            outputPerMillion: number;
            imageOutputPerMillion: number;
        };
        imageTokensPerImage: number;
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
        thinking: boolean;
        webSearch: boolean;
        tools: string[];
    };
    GEMINI_31_FLASH_IMAGE: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        defaultTemperature: number;
        arena: {
            image: number;
            imageEdit: number;
        };
        pricing: {
            inputPerMillion: number;
            imageInputPerMillion: number;
            outputPerMillion: number;
            imageOutputPerMillion: number;
        };
        imageTokensPerImage: number;
        maxInputTokens: number;
        maxOutputTokens: number;
        inputTypes: string[];
        outputTypes: string[];
        streaming: boolean;
        thinking: boolean;
        webSearch: boolean;
        tools: string[];
    };
    TEXT_EMBEDDING_3_SMALL: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        default: boolean;
        pricing: {
            inputPerMillion: number;
        };
        maxInputTokens: number;
        dimensions: number;
        inputTypes: string[];
        outputTypes: string[];
    };
    TEXT_EMBEDDING_3_LARGE: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        pricing: {
            inputPerMillion: number;
        };
        maxInputTokens: number;
        dimensions: number;
        inputTypes: string[];
        outputTypes: string[];
    };
    TEXT_EMBEDDING_ADA_002: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        pricing: {
            inputPerMillion: number;
        };
        maxInputTokens: number;
        dimensions: number;
        inputTypes: string[];
        outputTypes: string[];
    };
    GEMINI_EMBEDDING_2: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        default: boolean;
        pricing: {
            inputPerMillion: number;
        };
        maxInputTokens: number;
        dimensions: number;
        inputTypes: string[];
        outputTypes: string[];
    };
    GEMINI_EMBEDDING_001: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        pricing: {
            inputPerMillion: number;
        };
        maxInputTokens: number;
        dimensions: number;
        inputTypes: string[];
        outputTypes: string[];
    };
    GPT_4O_TRANSCRIBE: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        default: boolean;
        pricing: {
            audioInputPerMillion: number;
            outputPerMillion: number;
            perMinute: number;
        };
        inputTypes: string[];
        outputTypes: string[];
    };
    GPT_4O_MINI_TRANSCRIBE: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        pricing: {
            audioInputPerMillion: number;
            outputPerMillion: number;
            perMinute: number;
        };
        inputTypes: string[];
        outputTypes: string[];
    };
    WHISPER_1: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        pricing: {
            perMinute: number;
        };
        inputTypes: string[];
        outputTypes: string[];
    };
    GEMINI_3_FLASH_STT: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        default: boolean;
        pricing: {
            audioInputPerMillion: number;
            outputPerMillion: number;
        };
        inputTypes: string[];
        outputTypes: string[];
    };
    GEMINI_3_PRO_STT: {
        name: string;
        label: string;
        provider: string;
        year: number;
        modelType: string;
        pricing: {
            audioInputPerMillion: number;
            outputPerMillion: number;
        };
        inputTypes: string[];
        outputTypes: string[];
    };
    GEMINI_35_FLASH_STT: {
        name: string;
        label: string;
        provider: string;
        modelType: string;
        year: number;
        default: boolean;
        pricing: {
            audioInputPerMillion: number;
            outputPerMillion: number;
        };
        inputTypes: string[];
        outputTypes: string[];
    };
};
/** Shape of a single entry in the MODELS catalog. */
export type ModelDefinition = (typeof MODELS)[keyof typeof MODELS];
/** Client-facing model option entry returned by getModelOptions(). */
interface ModelOptionEntry {
    name: string;
    label: string;
    thinking?: boolean;
    vision?: boolean;
    webSearch?: boolean | string;
    inputTypes?: string[];
    outputTypes?: string[];
    tools?: string[];
    pricing?: Record<string, number>;
    arena?: Record<string, number>;
    contextLength?: number;
    maxOutputTokens?: number;
    assistantImages?: boolean;
    jsonMode?: boolean;
    codeExecution?: boolean;
    webFetch?: boolean;
    urlContext?: boolean;
    defaultTemperature?: number;
    verbosity?: boolean;
    reasoningSummary?: boolean;
    responsesAPI?: boolean;
    size?: string;
    modelType?: string;
    liveAPI?: boolean;
    thinkingLevels?: string[];
    mediaLimits?: Record<string, unknown>;
    year?: number;
    supportsSystemPrompt?: boolean;
}
/**
 * Get all models whose inputTypes includes `inputType`
 * and whose outputTypes includes `outputType`.
 */
declare function getModels(inputType: string, outputType: string): ModelDefinition[];
/**
 * Get listed model options grouped by provider
 * for a given input→output type combination.
 * Returns: { [provider]: [{ name, label, ... }, ...] }
 */
declare function getModelOptions(inputType: string, outputType: string): Record<string, ModelOptionEntry[]>;
/**
 * Get the default model name per provider
 * for a given input→output type combination.
 * Returns: { [provider]: modelName }
 */
declare function getDefaultModels(inputType: string, outputType: string): Record<string, string>;
/**
 * Get pricing map for a given input→output type combination.
 * Returns: { [modelName]: pricingObject }
 */
declare function getPricing(inputType: string, outputType: string): Record<string, Record<string, number>>;
/**
 * Find a single model object by its API name.
 * Returns the model object or null.
 */
declare function getModelByName(name: string): ModelDefinition | null;
declare const VOICES: {
    [PROVIDERS.OPENAI]: {
        name: string;
        gender: string;
    }[];
    [PROVIDERS.GOOGLE]: {
        name: string;
        gender: string;
    }[];
    [PROVIDERS.ELEVENLABS]: {
        name: string;
        label: string;
        gender: string;
    }[];
    [PROVIDERS.INWORLD]: {
        name: string;
        gender: string;
        description: string;
    }[];
};
declare const DEFAULT_VOICES: {
    [PROVIDERS.OPENAI]: string;
    [PROVIDERS.GOOGLE]: string;
    [PROVIDERS.ELEVENLABS]: string;
    [PROVIDERS.INWORLD]: string;
};
export { PROVIDERS, PROVIDER_LIST, TYPES, MODEL_TYPES, MODELS, getModels, getModelOptions, getDefaultModels, getPricing, getModelByName, VOICES, DEFAULT_VOICES, };
//# sourceMappingURL=config.d.ts.map