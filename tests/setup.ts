/**
 * Shared test setup — creates an Express app with mocked providers and secrets.
 * Every test file gets a pre-configured supertest agent via `createAgent()`.
 */
import { vi } from 'vitest';

// ── Mock secrets before anything imports them ──────────────────────────
vi.mock('../config.ts', () => ({
    PRISM_SERVICE_PORT: 0,
    GATEWAY_SECRET: 'test-secret',
    OPENAI_API_KEY: 'fake',
    ANTHROPIC_API_KEY: 'fake',
    GOOGLE_API_KEY: 'fake',
    ELEVENLABS_API_KEY: 'fake',
    INWORLD_BASIC: 'fake',
    PROVIDER_LM_STUDIO: [],
    PROVIDER_VLLM: [],
    PROVIDER_OLLAMA: [],
    PROVIDER_LLAMA_CPP: [],
    OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:9999',
    TOOLS_SERVICE_URL: 'http://localhost:5590',
    MONGO_URI: 'mongodb://test:test@localhost:27017/?directConnection=true&replicaSet=rs0&authSource=admin',
    MONGO_DB_NAME: 'prism-test',
    LIVE_AUDIO_MODEL: 'gemini-2.0-flash-live-001',
}));

// ── Mock global fetch for tools-api ───────────────────────────────────
const originalFetch = global.fetch;
global.fetch = vi.fn().mockImplementation(async (url, init) => {
    const urlString = String(url);
    if (urlString.includes('/admin/tool-schemas')) {
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => [
                {
                    name: 'get_weather',
                    description: 'Get weather details',
                    parameters: { type: 'object', properties: {} },
                    domain: 'Weather',
                    labels: ['weather'],
                    endpoint: { path: '/weather' }
                }
            ],
        } as any;
    }
    if (urlString.includes('/admin/config')) {
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({
                workspaceRoots: ['/home/rodrigo/development'],
                staticRoots: ['/home/rodrigo/development']
            }),
        } as any;
    }
    if (urlString.includes('/health')) {
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ status: 'ok' }),
        } as any;
    }
    if (urlString.includes('example.com') || urlString.endsWith('.jpg') || urlString.endsWith('.png')) {
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: {
                get: (headerName: string) => headerName.toLowerCase() === 'content-type' ? 'image/jpeg' : null
            },
            arrayBuffer: async () => Buffer.from('fake-image-bytes'),
        } as any;
    }
    try {
        if (originalFetch) {
            return await originalFetch(url, init);
        }
    } catch (e) {}
    return {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({ error: 'Fetch failed in test harness' }),
    } as any;
});

// ── Mock MongoDB wrapper to avoid real connections ────────────────────
vi.mock('../src/wrappers/MongoWrapper.ts', () => ({
    default: {
        createClient: vi.fn().mockResolvedValue(undefined),
        getDb: vi.fn().mockReturnValue(null),
        getCollection: vi.fn().mockReturnValue(null),
    },
}));

// ── Mock SettingsService to avoid DB dependency in EmbeddingService ────
vi.mock('../src/services/SettingsService.ts', () => ({
    default: {
    getCached: vi.fn().mockReturnValue({ creative: { textToSpeechProvider: "elevenlabs" } }),
        get: vi.fn().mockResolvedValue({
            memory: {
                extractionProvider: 'google',
                extractionModel: 'gemini-3-flash-preview',
                consolidationProvider: 'google',
                consolidationModel: 'gemini-3-flash-preview',
                embeddingProvider: 'google',
                embeddingModel: 'gemini-embedding-2-preview',
            },
            agents: { subagentProvider: 'google', subagentModel: 'gemini-3-flash-preview' },
        }),
        getSection: vi.fn().mockResolvedValue({
            extractionProvider: 'google',
            extractionModel: 'gemini-3-flash-preview',
            consolidationProvider: 'google',
            consolidationModel: 'gemini-3-flash-preview',
            embeddingProvider: 'google',
            embeddingModel: 'gemini-embedding-2-preview',
        }),
        getMemoryModelConfig: vi.fn().mockResolvedValue({
            provider: 'google',
            model: 'gemini-embedding-2-preview',
        }),
        invalidateCache: vi.fn(),
        getDefaults: vi.fn(),
    },
}));

// ── Mock ConversationService to avoid DB writes ───────────────────────
vi.mock('../src/services/ConversationService.ts', () => ({
    default: {
        appendMessages: vi.fn().mockResolvedValue(undefined),
        setGenerating: vi.fn().mockResolvedValue(undefined),
        getConversation: vi.fn().mockResolvedValue(null),
        listConversations: vi.fn().mockResolvedValue([]),
        deleteConversation: vi.fn().mockResolvedValue(undefined),
    },
}));

// ── Mock RequestLogger to avoid DB writes ─────────────────────────────
vi.mock('../src/services/RequestLogger.ts', () => ({
    default: {
        log: vi.fn(),
        logChatGeneration: vi.fn().mockResolvedValue(undefined),
    },
}));


// ── Build mock provider functions ─────────────────────────────────────
export const MOCK_GENERATE_TEXT = vi.fn().mockResolvedValue({
    text: 'Hello from mock',
    usage: { inputTokens: 10, outputTokens: 5 },
});

export const MOCK_GENERATE_TEXT_STREAM = vi
    .fn()
    .mockImplementation(async function* () {
        yield 'Hello ';
        yield 'world';
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
    });

export const MOCK_GENERATE_SPEECH = vi.fn().mockResolvedValue({
    contentType: 'audio/mpeg',
    stream: {
        pipe: vi.fn((res) => {
            res.write(Buffer.from('fake-audio-data'));
            res.end();
        }),
    },
});

export const MOCK_GENERATE_SPEECH_STREAM = vi.fn();

export const MOCK_GENERATE_IMAGE = vi.fn().mockResolvedValue({
    imageData: 'base64data',
    mimeType: 'image/png',
    text: 'A generated image',
});

export const MOCK_CAPTION_IMAGE = vi.fn().mockResolvedValue({
    text: 'A photo of a cat',
    usage: { inputTokens: 100, outputTokens: 50 },
});

export const MOCK_GENERATE_EMBEDDING = vi.fn().mockResolvedValue({
    embedding: [0.1, 0.2, 0.3],
});

// ── Mock providers ────────────────────────────────────────────────────
vi.mock('../src/providers/index.ts', () => {
    // Re-import at the top of the factory is not allowed, so we inline
    const mockProviderFull = {
        generateText: (...args) => MOCK_GENERATE_TEXT(...args),
        generateTextStream: (...args) => MOCK_GENERATE_TEXT_STREAM(...args),
        generateSpeech: (...args) => MOCK_GENERATE_SPEECH(...args),
        generateSpeechStream: (...args) => MOCK_GENERATE_SPEECH_STREAM(...args),
        generateImage: (...args) => MOCK_GENERATE_IMAGE(...args),
        captionImage: (...args) => MOCK_CAPTION_IMAGE(...args),
        generateEmbedding: (...args) => MOCK_GENERATE_EMBEDDING(...args),
    };

    const mockProviderTextOnly = {
        generateText: (...args) => MOCK_GENERATE_TEXT(...args),
        generateTextStream: (...args) => MOCK_GENERATE_TEXT_STREAM(...args),
    };

    const mockProviderTtsOnly = {
        generateSpeech: (...args) => MOCK_GENERATE_SPEECH(...args),
        generateSpeechStream: (...args) => MOCK_GENERATE_SPEECH_STREAM(...args),
    };

    const providers = {
        openai: mockProviderFull,
        anthropic: mockProviderTextOnly,
        google: mockProviderFull,
        elevenlabs: mockProviderTtsOnly,
        inworld: mockProviderTtsOnly,
        'openai-compatible': mockProviderTextOnly,
        'lm-studio': mockProviderTextOnly,
        ollama: mockProviderTextOnly,
        'llama-cpp': mockProviderTextOnly,
        vllm: mockProviderTextOnly,
    };

    return {
        getProvider: (name) => {
            const p = providers[name];
            if (!p) {
                throw new Error(
                    `Unknown provider "${name}". Available: ${Object.keys(providers).join(', ')}`,
                );
            }
            return p;
        },
        listProviders: () => Object.keys(providers),
        providers,
    };
});

// ── Build app (import AFTER mocks are set up) ─────────────────────────
const { default: express } = await import('express');
const { default: cors } = await import('cors');
const { errorHandler } = await import('../src/utils/errors.ts');
const { authMiddleware } = await import('../src/middleware/AuthMiddleware.ts');
const { listProviders } = await import('../src/providers/index.ts');

const { default: chatRouter } = await import('../src/routes/ChatRoutes.ts');
const { default: audioRouter } = await import('../src/routes/AudioRoutes.ts');
const { default: embedRouter } = await import('../src/routes/EmbedRoutes.ts');
const { default: configRouter } = await import('../src/routes/ConfigRoutes.ts');
const { default: webhookRouter } = await import('../src/routes/WebhookRoutes.ts');

export const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', (_req, res) => {
    res.json({
        name: 'Prism the AI Gateway',
        version: '1.0.0',
        providers: listProviders(),
        endpoints: {
            rest: [
                '/config',
                '/chat',
                '/audio',
                '/embed',
                '/webhooks',
            ],
            websocket: ['/ws/chat', '/ws/text-to-audio'],
        },
    });
});

app.use(authMiddleware);
app.use('/config', configRouter);
app.use('/chat', chatRouter);
app.use('/text-to-audio', audioRouter);
app.use('/embed', embedRouter);
app.use('/webhooks', webhookRouter);
app.use(errorHandler);

// ── Helpers ───────────────────────────────────────────────────
export const TEST_SECRET = 'test-secret';
