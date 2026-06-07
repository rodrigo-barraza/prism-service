import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock config ────────────────────────────────────────────────
vi.mock("../config.ts", () => ({
  MONGO_DB_NAME: "prism-test",
  getModelByName: vi.fn().mockReturnValue({
    name: "test-model",
    provider: "google",
    contextLength: 128_000,
  }),
}));

// ── Mock logger (suppress output) ──────────────────────────────
vi.mock("../src/utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

// ── Mock CleanupRegistry (no-op) ───────────────────────────────
vi.mock("../src/utils/CleanupRegistry.ts", () => ({
  registerCleanup: vi.fn(),
}));

// ── Track ConversationService/AgenticLoopService mock calls ──
const mockRunAgenticLoop = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/services/AgenticLoopService.ts", () => ({
  default: {
    runAgenticLoop: (...args: unknown[]) => mockRunAgenticLoop(...args),
  },
}));

// ── Mock providers ─────────────────────────────────────────────
vi.mock("../src/providers/index.ts", () => ({
  getProvider: vi.fn().mockReturnValue({
    generateText: vi.fn(),
    generateTextStream: vi.fn(),
  }),
}));

// ── Mock MongoWrapper ──────────────────────────────────────────
const mockFindOne = vi.fn();
const mockInsertOne = vi.fn().mockResolvedValue({ insertedId: "test-id" });
const mockUpdateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
const mockFindDocuments = vi.fn().mockReturnValue({
  sort: vi.fn().mockReturnValue({
    toArray: vi.fn().mockResolvedValue([]),
  }),
});

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn().mockReturnValue({
      collection: vi.fn().mockReturnValue({
        findOne: (...args: unknown[]) => mockFindOne(...args),
        insertOne: (...args: unknown[]) => mockInsertOne(...args),
        updateOne: (...args: unknown[]) => mockUpdateOne(...args),
        find: (...args: unknown[]) => mockFindDocuments(...args),
      }),
    }),
  },
}));

// ── Import AFTER mocks are wired ───────────────────────────────
const { default: ScheduledTaskService } = await import(
  "../src/services/ScheduledTaskService.ts"
);

// ── Test fixtures ──────────────────────────────────────────────
const TASK_FIXTURE = {
  id: "task-test-001",
  name: "Daily Health Check",
  project: "prism-chat",
  username: "rodrigo",
  prompt: "Verify server status",
  agent: "OMNI",
  provider: "google",
  model: "gemini-3.5-flash",
  scheduleType: "once" as const,
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("ScheduledTaskService — Tool Configuration & Propagation Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should successfully persist the toolConfig when creating a new scheduled task", async () => {
    await ScheduledTaskService.createTask({
      name: "Daily Health Check",
      project: "prism-chat",
      prompt: "Verify server status",
      agent: "OMNI",
      provider: "google",
      model: "gemini-3.5-flash",
      scheduleType: "once",
      enabled: true,
      username: "rodrigo",
      toolConfig: {
        enabledTools: ["read_file", "write_file"],
        disabledTools: ["execute_shell"],
      },
    } as any);

    expect(mockInsertOne).toHaveBeenCalledTimes(1);
    const insertedDocument = mockInsertOne.mock.calls[0][0];
    
    expect(insertedDocument.name).toBe("Daily Health Check");
    expect(insertedDocument.toolConfig).toEqual({
      enabledTools: ["read_file", "write_file"],
      disabledTools: ["execute_shell"],
    });
  });

  it("should spawn background agents with the exact toolConfig and enabledTools propagated from the scheduled task", async () => {
    mockFindOne.mockResolvedValueOnce(null); // workspace lookup
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    const taskWithToolConfig = {
      ...TASK_FIXTURE,
      toolConfig: {
        enabledTools: ["read_file", "write_file", "execute_javascript"],
        disabledTools: ["execute_shell"],
      },
    };

    await ScheduledTaskService.executeTask(
      taskWithToolConfig as any,
      undefined,
      { username: "rodrigo" }
    );

    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
    const loopArguments = mockRunAgenticLoop.mock.calls[0][0];
    
    // Verify that the options inside loop execution contain exact toolConfig parameters
    expect(loopArguments.options.enabledTools).toEqual(["read_file", "write_file", "execute_javascript"]);
    expect(loopArguments.options.disabledTools).toEqual(["execute_shell"]);

    // Verify that the session stub created in collections has settings with toolConfig
    expect(mockInsertOne).toHaveBeenCalledTimes(1);
    const insertedSessionStub = mockInsertOne.mock.calls[0][0];
    expect(insertedSessionStub.settings.toolConfig).toEqual({
      enabledTools: ["read_file", "write_file", "execute_javascript"],
      disabledTools: ["execute_shell"],
    });
  });

  it("should spawn background agent with only enabledTools when the parent agent (e.g. Omni) has wildcard availableTools but has a subset as enabledTools", async () => {
    mockFindOne.mockResolvedValueOnce(null); // workspace lookup
    mockRunAgenticLoop.mockResolvedValueOnce(undefined);

    const taskWithOmniWildcard = {
      ...TASK_FIXTURE,
      toolConfig: {
        availableTools: ["*"],
        disabledTools: ["search_web", "generate_image"],
        enabledTools: ["read_file", "write_file", "evaluate_expression"],
      },
    };

    await ScheduledTaskService.executeTask(
      taskWithOmniWildcard as any,
      undefined,
      { username: "rodrigo" }
    );

    expect(mockRunAgenticLoop).toHaveBeenCalledTimes(1);
    const loopArguments = mockRunAgenticLoop.mock.calls[0][0];

    // Verify that the options inside loop execution contain exact toolConfig parameters
    expect(loopArguments.options.enabledTools).toEqual(["read_file", "write_file", "evaluate_expression"]);
    expect(loopArguments.options.disabledTools).toEqual(["search_web", "generate_image"]);
  });
});
