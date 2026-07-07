/**
 * ConversationUtilities — tests for the appendAndFinalize and markGenerating
 * fire-and-forget helpers that wrap ConversationService.
 *
 * These helpers are on the critical path for every chat and agent response:
 * - appendAndFinalize: saves messages + clears isGenerating
 * - markGenerating: sets/clears the generating flag (fire-and-forget)
 *
 * The CRITICAL invariant: isGenerating is ALWAYS cleared, even when
 * appendMessages throws. Without this, sessions get permanently stuck
 * as "generating" in the UI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PROVIDERS, COLLECTIONS, MESSAGE_ROLES } from "#src/constants";

// ── Mock ConversationService before import ─────────────────────
const mockAppendMessages = vi.fn();
const mockSetGenerating = vi.fn();

vi.mock("#src/services/ConversationService", () => ({
  default: {
    appendMessages: (...args: unknown[]) => mockAppendMessages(...args),
    setGenerating: (...args: unknown[]) => mockSetGenerating(...args),
  },
}));

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { appendAndFinalize, markGenerating } = await import(
  "#src/utils/ConversationUtilities"
);

// ═══════════════════════════════════════════════════════════════
describe("appendAndFinalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendMessages.mockResolvedValue(undefined);
    mockSetGenerating.mockResolvedValue(undefined);
  });

  it("should call appendMessages then setGenerating(false) in order", async () => {
    const callOrder: string[] = [];
    mockAppendMessages.mockImplementation(async () => {
      callOrder.push("appendMessages");
    });
    mockSetGenerating.mockImplementation(async () => {
      callOrder.push("setGenerating");
    });

    await appendAndFinalize(
      "conv-123",
      "coding",
      "testuser",
      [{ role: MESSAGE_ROLES.USER, content: "Hello" }],
      null,
      { collection: COLLECTIONS.AGENT_CONVERSATIONS },
    );

    expect(callOrder).toEqual(["appendMessages", "setGenerating"]);
    expect(mockSetGenerating).toHaveBeenCalledWith(
      "conv-123",
      "coding",
      "testuser",
      false,
      { collection: COLLECTIONS.AGENT_CONVERSATIONS },
    );
  });

  it("should ALWAYS clear isGenerating even when appendMessages throws", async () => {
    mockAppendMessages.mockRejectedValue(new Error("MongoDB write failed"));

    await appendAndFinalize(
      "conv-123",
      "coding",
      "testuser",
      [{ role: MESSAGE_ROLES.ASSISTANT, content: "Response" }],
      null,
    );

    // Must not throw — appendAndFinalize catches internally
    expect(mockSetGenerating).toHaveBeenCalledWith(
      "conv-123",
      "coding",
      "testuser",
      false,
      {},
    );
  });

  it("should not throw even when both appendMessages AND setGenerating fail", async () => {
    mockAppendMessages.mockRejectedValue(new Error("Append failed"));
    mockSetGenerating.mockRejectedValue(new Error("SetGen failed"));

    await expect(
      appendAndFinalize(
        "conv-123",
        "coding",
        "testuser",
        [{ role: MESSAGE_ROLES.USER, content: "Hello" }],
        null,
      ),
    ).resolves.not.toThrow();
  });

  it("should be a no-op when conversationId is null", async () => {
    await appendAndFinalize(null, "coding", "testuser", [], null);

    expect(mockAppendMessages).not.toHaveBeenCalled();
    expect(mockSetGenerating).not.toHaveBeenCalled();
  });

  it("should be a no-op when conversationId is undefined", async () => {
    await appendAndFinalize(undefined, "coding", "testuser", [], null);

    expect(mockAppendMessages).not.toHaveBeenCalled();
    expect(mockSetGenerating).not.toHaveBeenCalled();
  });

  it("should forward meta and options to appendMessages", async () => {
    const meta = { title: "My Session", settings: { provider: PROVIDERS.GOOGLE } };
    const options = { collection: COLLECTIONS.AGENT_CONVERSATIONS };

    await appendAndFinalize(
      "conv-456",
      "coding",
      "rodrigo",
      [{ role: MESSAGE_ROLES.USER, content: "Test" }],
      meta,
      options,
    );

    expect(mockAppendMessages).toHaveBeenCalledWith(
      "conv-456",
      "coding",
      "rodrigo",
      [{ role: MESSAGE_ROLES.USER, content: "Test" }],
      meta,
      options,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
describe("markGenerating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetGenerating.mockResolvedValue(undefined);
  });

  it("should call setGenerating with the generating flag", () => {
    markGenerating("conv-123", "coding", "testuser", true);

    expect(mockSetGenerating).toHaveBeenCalledWith(
      "conv-123",
      "coding",
      "testuser",
      true,
      {},
    );
  });

  it("should forward options to setGenerating", () => {
    markGenerating("conv-123", "coding", "testuser", false, {
      collection: COLLECTIONS.AGENT_CONVERSATIONS,
      agent: "CODING",
      title: "My custom title",
    });

    expect(mockSetGenerating).toHaveBeenCalledWith(
      "conv-123",
      "coding",
      "testuser",
      false,
      { collection: COLLECTIONS.AGENT_CONVERSATIONS, agent: "CODING", title: "My custom title" },
    );
  });

  it("should be a no-op when conversationId is null", () => {
    markGenerating(null, "coding", "testuser", true);

    expect(mockSetGenerating).not.toHaveBeenCalled();
  });

  it("should be a no-op when conversationId is undefined", () => {
    markGenerating(undefined, "coding", "testuser", true);

    expect(mockSetGenerating).not.toHaveBeenCalled();
  });

  it("should not throw even when setGenerating rejects (fire-and-forget)", () => {
    mockSetGenerating.mockRejectedValue(new Error("DB down"));

    expect(() => {
      markGenerating("conv-123", "coding", "testuser", true);
    }).not.toThrow();
  });
});
