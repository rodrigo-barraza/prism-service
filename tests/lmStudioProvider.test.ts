import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLmStudioProvider } from "../src/providers/lm-studio.ts";

/**
 * Regression tests for the LM Studio provider's model loading pipeline.
 *
 * These tests exercise the REAL provider code via `createLmStudioProvider`,
 * with `fetch` mocked at the HTTP level. This ensures the actual response
 * parsing, loading gate logic, and state management are tested end-to-end
 * — not a simplified replica that could diverge from the real implementation.
 *
 * ROOT CAUSE OF THE ORIGINAL BUG:
 * The `/api/v1/models` endpoint returns `{ models: [...] }` (LM Studio
 * native format), but the parser was reading `data.data` (OpenAI format).
 * Every `listModels()` call returned an empty array, causing `isLoaded`
 * to always be false, triggering a fresh model load on every iteration.
 */

const TEST_BASE_URL = "http://test-lm-studio:1234";
const TEST_MODEL = "google/gemma-4-12b-qat";

// ── Response fixtures ────────────────────────────────────────────

function createNativeApiModelResponse(
  overrides: {
    modelKey?: string;
    maxContextLength?: number;
    loadedContextLength?: number | null;
    instanceCount?: number;
  } = {},
) {
  const modelKey = overrides.modelKey || TEST_MODEL;
  const maxContextLength = overrides.maxContextLength || 262144;
  const loadedContextLength = overrides.loadedContextLength ?? 120000;
  const instanceCount = overrides.instanceCount ?? (loadedContextLength ? 1 : 0);

  const loadedInstances =
    instanceCount > 0
      ? Array.from({ length: instanceCount }, (_, index) => ({
          id: index === 0 ? modelKey : `${modelKey}:${index + 1}`,
          config: {
            context_length: loadedContextLength,
            eval_batch_size: 512,
            flash_attention: true,
          },
        }))
      : [];

  return {
    models: [
      {
        type: "llm",
        publisher: "google",
        key: modelKey,
        display_name: "Test Model",
        architecture: "gemma4",
        quantization: { name: "Q4_0", bits_per_weight: 4 },
        size_bytes: 7151066820,
        params_string: "12B",
        loaded_instances: loadedInstances,
        max_context_length: maxContextLength,
        format: "gguf",
      },
    ],
  };
}

function createOpenAiCompatModelResponse(modelKey: string = TEST_MODEL) {
  return {
    data: [
      {
        id: modelKey,
        object: "model",
        owned_by: "google",
      },
    ],
    object: "list",
  };
}

function createStreamingResponse(text: string = "ok") {
  const sseData = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of sseData) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

// ── Fetch mock helper ────────────────────────────────────────────

interface FetchCallRecord {
  url: string;
  method: string;
  body?: unknown;
}

function createFetchMock(options: {
  modelResponse?: object;
  loadModelResponse?: object;
  streamResponse?: () => Response;
  loadShouldFail?: boolean;
  loadFailureMessage?: string;
}) {
  const fetchCalls: FetchCallRecord[] = [];

  const mockFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    const method = init?.method || "GET";
    let parsedBody: unknown = undefined;
    if (init?.body && typeof init.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    fetchCalls.push({ url: urlString, method, body: parsedBody });

    // GET /api/v1/models — listModels
    if (urlString.endsWith("/api/v1/models") && method === "GET") {
      return new Response(
        JSON.stringify(options.modelResponse || createNativeApiModelResponse()),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // POST /api/v1/models/load — loadModel
    if (urlString.endsWith("/api/v1/models/load") && method === "POST") {
      if (options.loadShouldFail) {
        return new Response(
          options.loadFailureMessage || "GPU OOM: insufficient VRAM",
          { status: 500 },
        );
      }
      return new Response(
        JSON.stringify(options.loadModelResponse || { success: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // POST /api/v1/models/unload — unloadModel
    if (urlString.endsWith("/api/v1/models/unload") && method === "POST") {
      return new Response(
        JSON.stringify({ success: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // POST /v1/chat/completions or /api/v1/chat — streaming inference
    if (
      (urlString.includes("/v1/chat/completions") || urlString.includes("/api/v1/chat")) &&
      method === "POST"
    ) {
      if (options.streamResponse) return options.streamResponse();
      return createStreamingResponse();
    }

    // Fallback
    return new Response("Not Found", { status: 404 });
  });

  return { mockFetch, fetchCalls };
}

// ── Helper: consume generator chunks ─────────────────────────────

async function consumeStream(
  generator: AsyncGenerator<unknown>,
  maxChunks: number = 50,
): Promise<{ chunks: unknown[]; statusMessages: string[] }> {
  const chunks: unknown[] = [];
  const statusMessages: string[] = [];

  for await (const chunk of generator) {
    chunks.push(chunk);
    if (typeof chunk === "object" && chunk !== null) {
      const record = chunk as Record<string, unknown>;
      if (record.type === "status" && typeof record.message === "string") {
        statusMessages.push(record.message);
      }
    }
    if (chunks.length >= maxChunks) break;
  }

  return { chunks, statusMessages };
}

// ── Tests ────────────────────────────────────────────────────────

describe("LM Studio listModels response parsing", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses native API format: { models: [...] } with loaded_instances", async () => {
    const { mockFetch } = createFetchMock({
      modelResponse: createNativeApiModelResponse({
        loadedContextLength: 120000,
        instanceCount: 1,
      }),
    });
    globalThis.fetch = mockFetch;

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");
    const result = await provider.listModels();

    expect(result.models.length).toBe(1);
    expect(result.models[0].key).toBe(TEST_MODEL);
    expect(result.models[0].loaded_instances).toBeDefined();
    expect(result.models[0].loaded_instances!.length).toBe(1);
    expect(
      (result.models[0].loaded_instances![0] as Record<string, unknown>).id,
    ).toBe(TEST_MODEL);
  });

  it("parses OpenAI-compat format: { data: [...] } with normalized fields", async () => {
    const { mockFetch } = createFetchMock({
      modelResponse: createOpenAiCompatModelResponse(TEST_MODEL),
    });
    globalThis.fetch = mockFetch;

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");
    const result = await provider.listModels();

    expect(result.models.length).toBe(1);
    expect(result.models[0].key).toBe(TEST_MODEL);
    expect(result.models[0].type).toBe("llm");
  });

  it("returns empty array when response has neither models nor data", async () => {
    const { mockFetch } = createFetchMock({
      modelResponse: { something_else: [] },
    });
    globalThis.fetch = mockFetch;

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");
    const result = await provider.listModels();

    expect(result.models.length).toBe(0);
  });

  it("detects multiple loaded instances (duplicate detection)", async () => {
    const { mockFetch } = createFetchMock({
      modelResponse: createNativeApiModelResponse({
        instanceCount: 3,
        loadedContextLength: 120000,
      }),
    });
    globalThis.fetch = mockFetch;

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");
    const result = await provider.listModels();

    expect(result.models[0].loaded_instances!.length).toBe(3);
    const instanceIds = result.models[0].loaded_instances!.map(
      (instance) => (instance as Record<string, unknown>).id,
    );
    expect(instanceIds).toContain(TEST_MODEL);
    expect(instanceIds).toContain(`${TEST_MODEL}:2`);
    expect(instanceIds).toContain(`${TEST_MODEL}:3`);
  });
});

describe("LM Studio loading gate: skip load when model already loaded", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("skips loading when model is already loaded at sufficient context", async () => {
    const { mockFetch, fetchCalls } = createFetchMock({
      modelResponse: createNativeApiModelResponse({
        loadedContextLength: 120000,
      }),
    });
    globalThis.fetch = mockFetch;

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");
    const stream = provider.generateTextStream(
      [{ role: "user", content: "test" }],
      TEST_MODEL,
      { minContextLength: 120000 },
    );

    await consumeStream(stream);

    const loadCalls = fetchCalls.filter(
      (call) => call.url.includes("/models/load"),
    );
    expect(loadCalls.length).toBe(0);
  });

  it("loads model when it is not loaded", async () => {
    const { mockFetch, fetchCalls } = createFetchMock({
      modelResponse: createNativeApiModelResponse({
        loadedContextLength: null,
        instanceCount: 0,
      }),
    });
    globalThis.fetch = mockFetch;

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");
    const stream = provider.generateTextStream(
      [{ role: "user", content: "test" }],
      TEST_MODEL,
      { minContextLength: 120000 },
    );

    await consumeStream(stream);

    const loadCalls = fetchCalls.filter(
      (call) => call.url.includes("/models/load"),
    );
    expect(loadCalls.length).toBe(1);
  });
});

describe("LM Studio multi-iteration no-reload regression", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("does NOT reload across 5 sequential iterations when model is already loaded", async () => {
    const { mockFetch, fetchCalls } = createFetchMock({
      modelResponse: createNativeApiModelResponse({
        loadedContextLength: 120000,
      }),
    });
    globalThis.fetch = mockFetch;

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");

    for (let iteration = 0; iteration < 5; iteration++) {
      // Fresh options each time — replicates the ReActHarness spread:
      //   const passOptions = { ...options, project, agent, username };
      //   provider.generateTextStream(messages, model, { ...passOptions, signal });
      const freshOptions = {
        minContextLength: 120000,
      };

      const stream = provider.generateTextStream(
        [{ role: "user", content: `Iteration ${iteration}` }],
        TEST_MODEL,
        freshOptions,
      );

      await consumeStream(stream);
    }

    const loadCalls = fetchCalls.filter(
      (call) => call.url.includes("/models/load"),
    );
    const unloadCalls = fetchCalls.filter(
      (call) => call.url.includes("/models/unload"),
    );

    expect(loadCalls.length).toBe(0);
    expect(unloadCalls.length).toBe(0);
  });

  it("loads model ONCE on first iteration, then skips on subsequent iterations", async () => {
    let isModelLoaded = false;

    const { mockFetch, fetchCalls } = createFetchMock({});
    // Override the mock to track load state dynamically
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method || "GET";

      if (urlString.endsWith("/api/v1/models") && method === "GET") {
        const response = isModelLoaded
          ? createNativeApiModelResponse({ loadedContextLength: 120000 })
          : createNativeApiModelResponse({ loadedContextLength: null, instanceCount: 0 });
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlString.endsWith("/api/v1/models/load") && method === "POST") {
        isModelLoaded = true;
        fetchCalls.push({ url: urlString, method });
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlString.endsWith("/api/v1/models/unload") && method === "POST") {
        fetchCalls.push({ url: urlString, method });
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        (urlString.includes("/v1/chat/completions") || urlString.includes("/api/v1/chat")) &&
        method === "POST"
      ) {
        return createStreamingResponse();
      }

      return new Response("Not Found", { status: 404 });
    });

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");

    for (let iteration = 0; iteration < 5; iteration++) {
      const freshOptions = { minContextLength: 120000 };
      const stream = provider.generateTextStream(
        [{ role: "user", content: `Iteration ${iteration}` }],
        TEST_MODEL,
        freshOptions,
      );
      await consumeStream(stream);
    }

    const loadCalls = fetchCalls.filter(
      (call) => call.url.includes("/models/load"),
    );
    // Model should be loaded exactly ONCE (on iteration 0)
    expect(loadCalls.length).toBe(1);
  });

  it("does not reload when minContextLength matches loaded context exactly", async () => {
    const { mockFetch, fetchCalls } = createFetchMock({
      modelResponse: createNativeApiModelResponse({
        loadedContextLength: 65000,
        maxContextLength: 262144,
      }),
    });
    globalThis.fetch = mockFetch;

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");

    // Request exactly the loaded context — should NOT trigger reload
    for (let iteration = 0; iteration < 3; iteration++) {
      const stream = provider.generateTextStream(
        [{ role: "user", content: `Iteration ${iteration}` }],
        TEST_MODEL,
        { minContextLength: 65000 },
      );
      await consumeStream(stream);
    }

    const loadCalls = fetchCalls.filter(
      (call) => call.url.includes("/models/load"),
    );
    expect(loadCalls.length).toBe(0);
  });

  it("does not reload when minContextLength is not set", async () => {
    const { mockFetch, fetchCalls } = createFetchMock({
      modelResponse: createNativeApiModelResponse({
        loadedContextLength: 65000,
      }),
    });
    globalThis.fetch = mockFetch;

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");

    for (let iteration = 0; iteration < 3; iteration++) {
      const stream = provider.generateTextStream(
        [{ role: "user", content: `Iteration ${iteration}` }],
        TEST_MODEL,
        {},
      );
      await consumeStream(stream);
    }

    const loadCalls = fetchCalls.filter(
      (call) => call.url.includes("/models/load"),
    );
    expect(loadCalls.length).toBe(0);
  });
});

describe("LM Studio advanced integration & edge cases", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("handles GPU OOM fallback and subsequent iteration caching on the real provider", async () => {
    let isModelLoaded = false;
    let currentLoadedContext = 0;
    const fetchCalls: FetchCallRecord[] = [];

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method || "GET";
      let parsedBody: unknown = undefined;
      if (init?.body && typeof init.body === "string") {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      fetchCalls.push({ url: urlString, method, body: parsedBody });

      if (urlString.endsWith("/api/v1/models") && method === "GET") {
        const response = isModelLoaded
          ? createNativeApiModelResponse({ loadedContextLength: currentLoadedContext })
          : createNativeApiModelResponse({ loadedContextLength: null, instanceCount: 0 });
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlString.endsWith("/api/v1/models/load") && method === "POST") {
        const payload = parsedBody as Record<string, unknown>;
        const requestedContext = payload.context_length as number;
        if (requestedContext > 65000) {
          return new Response("GPU OOM: insufficient VRAM", { status: 500 });
        }
        isModelLoaded = true;
        currentLoadedContext = requestedContext;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlString.endsWith("/api/v1/models/unload") && method === "POST") {
        isModelLoaded = false;
        currentLoadedContext = 0;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        (urlString.includes("/v1/chat/completions") || urlString.includes("/api/v1/chat")) &&
        method === "POST"
      ) {
        return createStreamingResponse();
      }

      return new Response("Not Found", { status: 404 });
    });

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");

    const firstStream = provider.generateTextStream(
      [{ role: "user", content: "first iteration" }],
      TEST_MODEL,
      { minContextLength: 120000 },
    );
    await consumeStream(firstStream);

    const firstLoadCalls = fetchCalls.filter((call) => call.url.includes("/models/load"));
    expect(firstLoadCalls).toHaveLength(2);
    expect((firstLoadCalls[0].body as Record<string, unknown>).context_length).toBe(120000);
    expect((firstLoadCalls[1].body as Record<string, unknown>).context_length).toBe(65000);

    const lengthBeforeSecondIteration = fetchCalls.length;

    const secondStream = provider.generateTextStream(
      [{ role: "user", content: "second iteration" }],
      TEST_MODEL,
      { minContextLength: 120000 },
    );
    await consumeStream(secondStream);

    const postLoadCalls = fetchCalls
      .slice(lengthBeforeSecondIteration)
      .filter((call) => call.url.includes("/models/load"));
    const postUnloadCalls = fetchCalls
      .slice(lengthBeforeSecondIteration)
      .filter((call) => call.url.includes("/models/unload"));

    expect(postLoadCalls).toHaveLength(0);
    expect(postUnloadCalls).toHaveLength(0);
  });

  it("enforces single active model by unloading inactive ones", async () => {
    let loadedModel = "google/gemma-4-12b-qat";
    const otherModel = "meta/llama-3-8b-instruct";
    const fetchCalls: FetchCallRecord[] = [];

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method || "GET";
      let parsedBody: unknown = undefined;
      if (init?.body && typeof init.body === "string") {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      fetchCalls.push({ url: urlString, method, body: parsedBody });

      if (urlString.endsWith("/api/v1/models") && method === "GET") {
        const modelsList = [
          {
            type: "llm",
            key: "google/gemma-4-12b-qat",
            display_name: "Gemma 4",
            loaded_instances: loadedModel === "google/gemma-4-12b-qat"
              ? [{ id: "google/gemma-4-12b-qat:1", config: { context_length: 32768 } }]
              : [],
            max_context_length: 262144,
          },
          {
            type: "llm",
            key: otherModel,
            display_name: "Llama 3",
            loaded_instances: loadedModel === otherModel
              ? [{ id: `${otherModel}:1`, config: { context_length: 32768 } }]
              : [],
            max_context_length: 120000,
          },
        ];
        return new Response(JSON.stringify({ models: modelsList }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlString.endsWith("/api/v1/models/load") && method === "POST") {
        loadedModel = otherModel;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlString.endsWith("/api/v1/models/unload") && method === "POST") {
        loadedModel = "";
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        (urlString.includes("/v1/chat/completions") || urlString.includes("/api/v1/chat")) &&
        method === "POST"
      ) {
        return createStreamingResponse();
      }

      return new Response("Not Found", { status: 404 });
    });

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");
    const stream = provider.generateTextStream(
      [{ role: "user", content: "switching models" }],
      otherModel,
      {},
    );
    await consumeStream(stream);

    const unloadCalls = fetchCalls.filter((call) => call.url.includes("/models/unload"));
    const loadCalls = fetchCalls.filter((call) => call.url.includes("/models/load"));

    expect(unloadCalls).toHaveLength(1);
    expect((unloadCalls[0].body as Record<string, unknown>).instance_id).toBe("google/gemma-4-12b-qat:1");
    expect(loadCalls).toHaveLength(1);
    expect((loadCalls[0].body as Record<string, unknown>).model).toBe(otherModel);
  });

  it("coalesces concurrent streams into a single loading operation on the real provider", async () => {
    let isModelLoaded = false;
    let loadCount = 0;
    const fetchCalls: FetchCallRecord[] = [];

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method || "GET";
      let parsedBody: unknown = undefined;
      if (init?.body && typeof init.body === "string") {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      fetchCalls.push({ url: urlString, method, body: parsedBody });

      if (urlString.endsWith("/api/v1/models") && method === "GET") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const response = isModelLoaded
          ? createNativeApiModelResponse({ loadedContextLength: 120000 })
          : createNativeApiModelResponse({ loadedContextLength: null, instanceCount: 0 });
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlString.endsWith("/api/v1/models/load") && method === "POST") {
        loadCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        isModelLoaded = true;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (
        (urlString.includes("/v1/chat/completions") || urlString.includes("/api/v1/chat")) &&
        method === "POST"
      ) {
        return createStreamingResponse();
      }

      return new Response("Not Found", { status: 404 });
    });

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");

    const [firstResult, secondResult, thirdResult] = await Promise.all([
      consumeStream(provider.generateTextStream([{ role: "user", content: "stream 1" }], TEST_MODEL, {})),
      consumeStream(provider.generateTextStream([{ role: "user", content: "stream 2" }], TEST_MODEL, {})),
      consumeStream(provider.generateTextStream([{ role: "user", content: "stream 3" }], TEST_MODEL, {})),
    ]);

    expect(firstResult.chunks).toBeDefined();
    expect(secondResult.chunks).toBeDefined();
    expect(thirdResult.chunks).toBeDefined();
    
    expect(loadCount).toBe(1);

    const loadCalls = fetchCalls.filter((call) => call.url.includes("/models/load"));
    expect(loadCalls).toHaveLength(1);
  });

  it("cleans up locks and inflight states when load is aborted", async () => {
    let isModelLoaded = false;
    const fetchCalls: FetchCallRecord[] = [];
    const abortController = new AbortController();

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method || "GET";
      let parsedBody: unknown = undefined;
      if (init?.body && typeof init.body === "string") {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      fetchCalls.push({ url: urlString, method, body: parsedBody });

      if (urlString.endsWith("/api/v1/models") && method === "GET") {
        const response = isModelLoaded
          ? createNativeApiModelResponse({ loadedContextLength: 120000 })
          : createNativeApiModelResponse({ loadedContextLength: null, instanceCount: 0 });
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlString.endsWith("/api/v1/models/load") && method === "POST") {
        await new Promise<null>((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            isModelLoaded = true;
            resolve(null);
          }, 100);
          
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              clearTimeout(timeoutId);
              reject(new DOMException("The user aborted a request.", "AbortError"));
            });
          }
        });
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlString.endsWith("/api/v1/models/unload") && method === "POST") {
        isModelLoaded = false;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    });

    const provider = createLmStudioProvider(TEST_BASE_URL, "test");

    const streamPromise = consumeStream(
      provider.generateTextStream([{ role: "user", content: "abort me" }], TEST_MODEL, {
        signal: abortController.signal,
        agent: "coder",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    abortController.abort();

    await streamPromise;

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method || "GET";
      
      if (urlString.endsWith("/api/v1/models") && method === "GET") {
        return new Response(JSON.stringify(createNativeApiModelResponse({ loadedContextLength: 120000 })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        (urlString.includes("/v1/chat/completions") || urlString.includes("/api/v1/chat")) &&
        method === "POST"
      ) {
        return createStreamingResponse("success after abort");
      }
      return new Response("Not Found", { status: 404 });
    });

    const secondStream = provider.generateTextStream(
      [{ role: "user", content: "second call after abort" }],
      TEST_MODEL,
      { agent: "coder" },
    );
    const result = await consumeStream(secondStream);
    
    expect(result.chunks).toBeDefined();
    const textChunks = result.chunks.filter(
      (chunk) =>
        typeof chunk === "string" ||
        (typeof chunk === "object" && chunk !== null && (chunk as Record<string, unknown>).type === "content"),
    );
    expect(textChunks.length).toBeGreaterThan(0);
  });
});

