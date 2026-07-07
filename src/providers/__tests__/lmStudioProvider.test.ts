import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLmStudioProvider } from "#src/providers/lm-studio";
import { PROVIDERS } from "#src/constants";
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
