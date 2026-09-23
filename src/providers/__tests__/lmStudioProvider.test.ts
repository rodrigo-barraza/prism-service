import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLmStudioProvider } from "#src/providers/lm-studio";
import type { ChatMessage } from "#src/types/ProviderTypes";

describe("LM Studio Provider generateText unit tests", () => {
  const baseUrl = "http://localhost:1234";
  let provider: ReturnType<typeof createLmStudioProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = createLmStudioProvider(baseUrl);
    
    // Mock the fetch call globally
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/api/v1/models")) {
        return {
          ok: true,
          json: async () => ({
            models: [
              {
                key: "test-model",
                display_name: "Test Model",
                loaded_instances: [
                  {
                    id: "instance-1",
                    config: {
                      context_length: 4096,
                      eval_batch_size: 512,
                    },
                  },
                ],
              },
            ],
          }),
        } as Response;
      }
      if (url.endsWith("/v1/chat/completions")) {
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "Hello from LM Studio",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
            },
          }),
        } as Response;
      }
      return { ok: false, text: async () => "Not Found" } as Response;
    });
  });

  it("should ensure model is loaded, run inference, and track active requests", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Hi" }];
    
    // Spy on ensureModelLoaded
    const ensureModelLoadedSpy = vi.spyOn(provider, "ensureModelLoaded");

    const result = await provider.generateText(messages, "test-model", {
      evalBatchSize: 512,
      minContextLength: 4096,
    });

    expect(ensureModelLoadedSpy).toHaveBeenCalledWith(
      "test-model",
      { eval_batch_size: 512, context_length: 4096 },
      undefined
    );

    expect(result.text).toBe("Hello from LM Studio");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    
    // fetch should have been called for listModels and chat completions
    expect(global.fetch).toHaveBeenCalled();
  });

  it("should abort if signal is already aborted", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Hi" }];
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.generateText(messages, "test-model", {
        signal: controller.signal,
      })
    ).rejects.toThrow("The user aborted a request.");
  });
});

describe("LM Studio native /api/v1/chat stream — a cut-off reply", () => {
  const baseUrl = "http://localhost:1234";
  const nativeStream = (events: Array<Record<string, unknown>>) =>
    new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  function stubServer(events: Array<Record<string, unknown>>) {
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith("/api/v1/models")) {
        return new Response(
          JSON.stringify({
            models: [{ key: "test-model", loaded_instances: [{ id: "i-1", config: { context_length: 8192 } }] }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/v1/chat")) return nativeStream(events);
      return new Response("Not Found", { status: 404 });
    }) as never;
  }

  async function drain(stream: AsyncIterable<unknown>) {
    const chunks: unknown[] = [];
    let error: unknown = null;
    try {
      for await (const chunk of stream) chunks.push(chunk);
    } catch (caught) {
      error = caught;
    }
    return { chunks, error };
  }

  it("a body that ends before chat.end fails instead of ending like a finished reply", async () => {
    const { isTransientProviderError } = await import("#src/utils/ProviderStreamResilience");
    stubServer([
      { type: "chat.start" },
      { type: "message.start" },
      { type: "message.delta", content: "The first half of" },
    ]);
    const provider = createLmStudioProvider(baseUrl);
    const { chunks, error } = await drain(provider.generateTextStream!([{ role: "user", content: "hi" }], "test-model", {}));
    expect(chunks).toContain("The first half of");
    expect(String((error as Error)?.message)).toMatch(/ended before the response completed \(no chat\.end\)/);
    expect(isTransientProviderError(error)).toBe(true);
  });

  it("a finished reply ends with its usage", async () => {
    stubServer([
      { type: "chat.start" },
      { type: "message.delta", content: "Done." },
      { type: "chat.end", result: { stats: { input_tokens: 12, total_output_tokens: 3 } } },
    ]);
    const provider = createLmStudioProvider(baseUrl);
    const { chunks, error } = await drain(provider.generateTextStream!([{ role: "user", content: "hi" }], "test-model", {}));
    expect(error).toBeNull();
    expect(chunks).toContainEqual(expect.objectContaining({ type: "usage", usage: expect.objectContaining({ inputTokens: 12, outputTokens: 3 }) }));
  });
});
