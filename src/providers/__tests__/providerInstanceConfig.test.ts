/**
 * Local provider instances come from indexed env vars —
 * PROVIDER_<TYPE>_<N>_URL / _CONCURRENCY / _NICKNAME / _API_KEY — parsed by
 * the real config.ts (tests/setup.ts mocks it for every other test).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("local provider instance config", () => {
  it("reads SGLang instances, each with an optional API key", async () => {
    vi.stubEnv("PROVIDER_SGLANG_1_URL", "http://gpu-1:30000");
    vi.stubEnv("PROVIDER_SGLANG_1_CONCURRENCY", "4");
    vi.stubEnv("PROVIDER_SGLANG_1_NICKNAME", "Desktop");
    vi.stubEnv("PROVIDER_SGLANG_1_API_KEY", "sk-desktop");
    vi.stubEnv("PROVIDER_SGLANG_3_URL", "http://gpu-3:30000");
    vi.resetModules();

    const config = await vi.importActual<typeof import("#config")>("#config");

    expect(config.PROVIDER_SGLANG).toEqual([
      {
        url: "http://gpu-1:30000",
        concurrency: 4,
        nickname: "Desktop",
        apiKey: "sk-desktop",
      },
      { url: "http://gpu-3:30000", concurrency: 1 },
    ]);
  });
});
