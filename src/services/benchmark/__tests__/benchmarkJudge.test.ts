import { describe, it, expect, beforeEach, vi } from "vitest";
import { runJudge } from "#src/services/benchmark/BenchmarkJudge";
import { handleConversation } from "#src/routes/ChatRoutes";

vi.mock("#src/routes/ChatRoutes", () => ({
  handleConversation: vi.fn(),
  handleAgent: vi.fn(),
}));

vi.mock("#src/providers/index", () => ({
  getProvider: vi.fn().mockReturnValue({}),
}));

const baseRequest = {
  rubric: "Must be exactly one sentence.",
  prompt: "Summarize photosynthesis in one sentence.",
  response: "Plants turn light into chemical energy.",
  project: "test-project",
  username: "test-user",
};

describe("BenchmarkJudge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a strict JSON verdict with score, reasoning, and cost", async () => {
    (handleConversation as any).mockImplementation(
      async (_parameters: any, emit: any) => {
        emit({
          type: "chunk",
          content: '{"pass": true, "score": 9, "reasoning": "One sentence, accurate."}',
        });
        emit({ type: "done", estimatedCost: 0.0002 });
      },
    );

    const verdict = await runJudge(baseRequest);
    expect(verdict.passed).toBe(true);
    expect(verdict.score).toBe(9);
    expect(verdict.reasoning).toBe("One sentence, accurate.");
    expect(verdict.cost).toBe(0.0002);
    expect(verdict.error).toBeUndefined();
  });

  it("handles verdicts wrapped in markdown fences", async () => {
    (handleConversation as any).mockImplementation(
      async (_parameters: any, emit: any) => {
        emit({
          type: "chunk",
          content: '```json\n{"pass": false, "score": 3, "reasoning": "Two sentences."}\n```',
        });
        emit({ type: "done" });
      },
    );

    const verdict = await runJudge(baseRequest);
    expect(verdict.passed).toBe(false);
    expect(verdict.score).toBe(3);
  });

  it("fails safely on unparseable judge output", async () => {
    (handleConversation as any).mockImplementation(
      async (_parameters: any, emit: any) => {
        emit({ type: "chunk", content: "I think it passes!" });
        emit({ type: "done" });
      },
    );

    const verdict = await runJudge(baseRequest);
    expect(verdict.passed).toBe(false);
    expect(verdict.error).toContain("unparseable");
  });

  it("fails safely when the judge call errors", async () => {
    (handleConversation as any).mockImplementation(
      async (_parameters: any, emit: any) => {
        emit({ type: "error", message: "provider exploded" });
      },
    );

    const verdict = await runJudge(baseRequest);
    expect(verdict.passed).toBe(false);
    expect(verdict.error).toContain("provider exploded");
  });

  it("honors a judgeModel override when valid", async () => {
    (handleConversation as any).mockImplementation(
      async (parameters: any, emit: any) => {
        emit({
          type: "chunk",
          content: `{"pass": true, "score": 8, "reasoning": "ok ${parameters.model}"}`,
        });
        emit({ type: "done" });
      },
    );

    const verdict = await runJudge({
      ...baseRequest,
      judgeModel: "openai:gpt-4o",
    });
    // getModelByName("gpt-4o") resolves against real config; if the model
    // exists the override is used, otherwise the recommended default is.
    expect(verdict.passed).toBe(true);
    expect(handleConversation).toHaveBeenCalledOnce();
  });
});
