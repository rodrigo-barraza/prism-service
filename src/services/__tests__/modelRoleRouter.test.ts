import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ModelRoleRouter, {
  MODEL_ROLES,
  type RoleChainEntry,
} from "#src/services/ModelRoleRouter";
import SettingsService from "#src/services/SettingsService";
import { listInstances } from "#src/providers/instance-registry";
import { getProvider } from "#src/providers/index";
import { resolveRecommendedDefault } from "#src/config";
import { ProviderError } from "#src/utils/errors";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("#src/providers/instance-registry", () => ({
  listInstances: vi.fn().mockReturnValue([]),
}));

vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn(),
}));

vi.mock("#src/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("#src/config")>();
  return {
    ...original,
    resolveRecommendedDefault: vi.fn().mockReturnValue(null),
  };
});

const ROLE_ENVIRONMENT_KEYS = [
  "MODEL_ROLE_UTILITY",
  "MODEL_ROLE_CRITIC",
  "MODEL_ROLE_PLAN",
  "MODEL_ROLE_VISION",
  "MODEL_ROLE_DEFAULT",
];

describe("ModelRoleRouter — chain resolution order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ModelRoleRouter.clearInstanceModelCache();
    for (const key of ROLE_ENVIRONMENT_KEYS) delete process.env[key];
    vi.mocked(SettingsService.getSection).mockResolvedValue({} as never);
    vi.mocked(listInstances).mockReturnValue([]);
    vi.mocked(resolveRecommendedDefault).mockReturnValue(null);
  });

  afterEach(() => {
    for (const key of ROLE_ENVIRONMENT_KEYS) delete process.env[key];
  });

  it("explicit env config heads the chain and supports multiple entries", async () => {
    process.env.MODEL_ROLE_UTILITY =
      "vllm=Qwen/Qwen3-4B-Instruct,google=gemini-3.5-flash";

    const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.UTILITY);

    expect(chain.slice(0, 2)).toEqual([
      { provider: "vllm", model: "Qwen/Qwen3-4B-Instruct" },
      { provider: "google", model: "gemini-3.5-flash" },
    ]);
  });

  it("DB settings come after env config", async () => {
    process.env.MODEL_ROLE_UTILITY = "vllm=local-model";
    vi.mocked(SettingsService.getSection).mockResolvedValue({
      extractionProvider: "google",
      extractionModel: "gemini-3.5-flash",
    } as never);

    const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.UTILITY);

    expect(chain[0]).toEqual({ provider: "vllm", model: "local-model" });
    expect(chain[1]).toEqual({
      provider: "google",
      model: "gemini-3.5-flash",
    });
  });

  it("utility defaults to a configured local instance when nothing is configured (silent-disable eliminated)", async () => {
    vi.mocked(listInstances).mockReturnValue([
      {
        id: "vllm",
        type: "vllm",
        baseUrl: "http://localhost:8080",
        concurrency: 1,
        instanceNumber: 1,
        provider: {},
      },
    ] as never);
    vi.mocked(getProvider).mockReturnValue({
      listModels: vi.fn().mockResolvedValue({
        models: [
          { key: "Qwen/Qwen3-4B-Instruct", loaded_instances: [{ id: "x" }] },
        ],
      }),
    } as never);

    const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.UTILITY);

    expect(chain).toEqual([
      { provider: "vllm", model: "Qwen/Qwen3-4B-Instruct" },
    ]);
  });

  it("utility falls back to the cheap cloud default when no local instance is configured", async () => {
    vi.mocked(resolveRecommendedDefault).mockReturnValue({
      provider: "google",
      model: "gemini-3.5-flash",
      temperature: 1.0,
    });

    const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.UTILITY);

    expect(chain).toEqual([{ provider: "google", model: "gemini-3.5-flash" }]);
  });

  it("an unreachable local instance is skipped, not fatal", async () => {
    vi.mocked(listInstances).mockReturnValue([
      {
        id: "vllm",
        type: "vllm",
        baseUrl: "http://localhost:8080",
        concurrency: 1,
        instanceNumber: 1,
        provider: {},
      },
    ] as never);
    vi.mocked(getProvider).mockReturnValue({
      listModels: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    } as never);
    vi.mocked(resolveRecommendedDefault).mockReturnValue({
      provider: "openai",
      model: "gpt-5-mini",
      temperature: 1.0,
    });

    const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.UTILITY);

    expect(chain).toEqual([{ provider: "openai", model: "gpt-5-mini" }]);
  });

  it("caller fallback slots between DB config and built-in defaults", async () => {
    vi.mocked(SettingsService.getSection).mockResolvedValue({
      extractionProvider: "google",
      extractionModel: "gemini-3.5-flash",
    } as never);
    vi.mocked(resolveRecommendedDefault).mockReturnValue({
      provider: "openai",
      model: "gpt-5-mini",
      temperature: 1.0,
    });

    const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.UTILITY, {
      fallback: { provider: "anthropic", model: "claude-fable-5" },
    });

    expect(chain).toEqual([
      { provider: "google", model: "gemini-3.5-flash" },
      { provider: "anthropic", model: "claude-fable-5" },
      { provider: "openai", model: "gpt-5-mini" },
    ]);
  });

  it("critic defaults to the utility chain, never the main model", async () => {
    vi.mocked(SettingsService.getSection).mockImplementation(
      async (section: unknown) =>
        (section === "memory"
          ? {
              extractionProvider: "google",
              extractionModel: "gemini-3.5-flash",
            }
          : {}) as never,
    );

    const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.CRITIC);

    expect(chain).toEqual([{ provider: "google", model: "gemini-3.5-flash" }]);
  });

  it("critic honors its own DB knob ahead of the utility chain", async () => {
    vi.mocked(SettingsService.getSection).mockImplementation(
      async (section: unknown) =>
        (section === "agents"
          ? { criticProvider: "openai", criticModel: "gpt-5-nano" }
          : section === "memory"
            ? {
                extractionProvider: "google",
                extractionModel: "gemini-3.5-flash",
              }
            : {}) as never,
    );

    const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.CRITIC);

    expect(chain[0]).toEqual({ provider: "openai", model: "gpt-5-nano" });
    expect(chain[1]).toEqual({
      provider: "google",
      model: "gemini-3.5-flash",
    });
  });

  it("duplicate entries are collapsed, keeping first position", async () => {
    process.env.MODEL_ROLE_UTILITY = "google=gemini-3.5-flash";
    vi.mocked(SettingsService.getSection).mockResolvedValue({
      extractionProvider: "google",
      extractionModel: "gemini-3.5-flash",
    } as never);

    const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.UTILITY);

    expect(chain).toEqual([{ provider: "google", model: "gemini-3.5-flash" }]);
  });

  it("resolves an empty chain (logged at error level) only when truly nothing exists", async () => {
    const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.UTILITY);
    expect(chain).toEqual([]);
  });
});

describe("ModelRoleRouter — runWithChain fallback semantics", () => {
  const chain: RoleChainEntry[] = [
    { provider: "vllm", model: "local-a" },
    { provider: "google", model: "cloud-b" },
  ];

  it("returns the first entry's result when it succeeds", async () => {
    const attempt = vi.fn().mockResolvedValue("ok");

    const { value, entry } = await ModelRoleRouter.runWithChain(
      chain,
      attempt,
      { role: MODEL_ROLES.UTILITY, operation: "test" },
    );

    expect(value).toBe("ok");
    expect(entry).toEqual(chain[0]);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("advances to the next model on a transient provider failure", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(
        new ProviderError("vllm", "connect ECONNREFUSED", 503),
      )
      .mockResolvedValueOnce("recovered");

    const { value, entry } = await ModelRoleRouter.runWithChain(
      chain,
      attempt,
      { role: MODEL_ROLES.UTILITY, operation: "test" },
    );

    expect(value).toBe("recovered");
    expect(entry).toEqual(chain[1]);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("advances on raw network errors (ECONNREFUSED code)", async () => {
    const networkError = Object.assign(new Error("fetch failed"), {
      code: "ECONNREFUSED",
    });
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce("recovered");

    const { entry } = await ModelRoleRouter.runWithChain(chain, attempt, {
      role: MODEL_ROLES.UTILITY,
      operation: "test",
    });

    expect(entry).toEqual(chain[1]);
  });

  it("does NOT advance on non-transient errors — they propagate immediately", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new ProviderError("vllm", "invalid request", 400));

    await expect(
      ModelRoleRouter.runWithChain(chain, attempt, {
        role: MODEL_ROLES.UTILITY,
        operation: "test",
      }),
    ).rejects.toThrow("invalid request");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("is bounded — the final entry's transient failure propagates", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new ProviderError("any", "overloaded", 529));

    await expect(
      ModelRoleRouter.runWithChain(chain, attempt, {
        role: MODEL_ROLES.UTILITY,
        operation: "test",
      }),
    ).rejects.toThrow("overloaded");
    expect(attempt).toHaveBeenCalledTimes(chain.length);
  });

  it("throws a clear error for an empty chain", async () => {
    await expect(
      ModelRoleRouter.runWithChain([], vi.fn(), {
        role: MODEL_ROLES.UTILITY,
        operation: "test",
      }),
    ).rejects.toThrow(/empty model chain/);
  });
});
