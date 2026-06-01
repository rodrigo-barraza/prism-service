export interface ProviderInstance {
    url: string;
    concurrency: number;
    nickname?: string;
}
export declare const PRISM_SERVICE_PORT: string | number;
export declare const OPENAI_API_KEY: string | undefined;
export declare const ANTHROPIC_API_KEY: string | undefined;
export declare const GOOGLE_API_KEY: string | undefined;
export declare const ELEVENLABS_API_KEY: string | undefined;
export declare const INWORLD_BASIC: string | undefined;
export declare const PROVIDER_LM_STUDIO: ProviderInstance[];
export declare const PROVIDER_VLLM: ProviderInstance[];
export declare const PROVIDER_OLLAMA: ProviderInstance[];
export declare const PROVIDER_LLAMA_CPP: ProviderInstance[];
export declare const MONGO_URI: string | undefined;
export declare const MONGO_DB_NAME: string;
export declare const MINIO_ENDPOINT: string | undefined;
export declare const MINIO_ACCESS_KEY: string | undefined;
export declare const MINIO_SECRET_KEY: string | undefined;
export declare const MINIO_BUCKET_NAME: string | undefined;
export declare const TOOLS_SERVICE_URL: string | undefined;
export declare const LIVE_AUDIO_MODEL: string | undefined;
export declare const OPENAI_TRANSCRIPTION_MODEL: string | undefined;
export declare const GOOGLE_TTS_MODEL: string | undefined;
export declare const GOOGLE_EMBEDDING_MODEL: string | undefined;
export declare const LM_STUDIO_EVAL_BATCH_SIZE: number;
export declare const LM_STUDIO_DEFAULT_MAX_CONTEXT: number;
//# sourceMappingURL=config.d.ts.map