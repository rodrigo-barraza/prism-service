import { describe, it, expect } from "vitest";
import { isRecordedTurn } from "#src/services/harnesses/lifecycle/TurnRunRecorder";
import type { AgenticContext } from "#src/services/harnesses/types";

const turn = (overrides: Partial<AgenticContext> = {}) =>
  ({ request: { agent: "CODING" }, conversationId: "c1", options: {}, ...overrides }) as unknown as AgenticContext;

describe("TurnRunRecorder — which turns a restart re-drives", () => {
  it("records a top-level turn that came through handleAgent", () => {
    expect(isRecordedTurn(turn())).toBe(true);
  });

  it("records neither a sub-agent nor a loop without a request", () => {
    expect(isRecordedTurn(turn({ options: { isSubAgent: true } as never }))).toBe(false);
    expect(isRecordedTurn(turn({ request: null }))).toBe(false);
  });

  it("does not record a benchmark sample: its run re-runs it on resume", () => {
    expect(isRecordedTurn(turn({ options: { evaluation: true } as never }))).toBe(false);
  });
});
