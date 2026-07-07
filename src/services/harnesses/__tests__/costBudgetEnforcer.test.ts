import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkCostBudget } from "#src/services/harnesses/lifecycle/CostBudgetEnforcer";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import type AgenticLoopState from "#src/services/AgenticLoopState";
import type { EmitFunction } from "#src/services/harnesses/types";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("#src/config", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../config.ts");
  return {
    ...actual,
    getPricing: vi.fn().mockReturnValue({
      "gemini-3.5-flash": {
        inputPricePer1M: 0.15,
        outputPricePer1M: 0.60,
        cachedInputPricePer1M: 0.04,
      },
      "test-model-free": null,
    }),
  };
});

vi.mock("#src/utils/CostCalculator", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../../utils/CostCalculator.ts");
  return {
    ...actual,
    calculateTextCost: vi.fn(),
  };
});

import { calculateTextCost } from "#src/utils/CostCalculator";

describe("CostBudgetEnforcer", () => {
  let emitMock: EmitFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    emitMock = vi.fn();
  });

  function createLoopState(overrides?: Partial<AgenticLoopState>): AgenticLoopState {
    const defaultUsage = {
      inputTokens: 50000,
      outputTokens: 20000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
    };
    return {
      iterations: overrides?.iterations ?? 5,
      overallUsage: {
        ...defaultUsage,
        ...(overrides?.overallUsage || {}),
      },
      ...overrides,
    } as AgenticLoopState;
  }

  describe("budget not configured", () => {
    it("should return false when maxCostDollars is undefined", () => {
      const state = createLoopState();
      const result = checkCostBudget(state, "gemini-3.5-flash", undefined, emitMock);
      expect(result).toBe(false);
      expect(emitMock).not.toHaveBeenCalled();
    });

    it("should return false when maxCostDollars is 0", () => {
      const state = createLoopState();
      const result = checkCostBudget(state, "gemini-3.5-flash", 0, emitMock);
      expect(result).toBe(false);
    });

    it("should return false when maxCostDollars is negative", () => {
      const state = createLoopState();
      const result = checkCostBudget(state, "gemini-3.5-flash", -5, emitMock);
      expect(result).toBe(false);
    });
  });

  describe("cost under budget", () => {
    it("should return false when estimated cost is below budget", () => {
      vi.mocked(calculateTextCost).mockReturnValue(0.05);
      const state = createLoopState();

      const result = checkCostBudget(state, "gemini-3.5-flash", 1.0, emitMock);

      expect(result).toBe(false);
      expect(emitMock).not.toHaveBeenCalled();
    });

    it("should return false when estimated cost is slightly below budget", () => {
      vi.mocked(calculateTextCost).mockReturnValue(0.999);
      const state = createLoopState();

      const result = checkCostBudget(state, "gemini-3.5-flash", 1.0, emitMock);

      expect(result).toBe(false);
    });
  });

  describe("cost at or exceeding budget", () => {
    it("should return true when estimated cost equals maxCostDollars", () => {
      vi.mocked(calculateTextCost).mockReturnValue(1.0);
      const state = createLoopState({ iterations: 10 });

      const result = checkCostBudget(state, "gemini-3.5-flash", 1.0, emitMock);

      expect(result).toBe(true);
    });

    it("should return true when estimated cost exceeds maxCostDollars", () => {
      vi.mocked(calculateTextCost).mockReturnValue(5.50);
      const state = createLoopState({ iterations: 50 });

      const result = checkCostBudget(state, "gemini-3.5-flash", 2.0, emitMock);

      expect(result).toBe(true);
    });

    it("should emit COST_LIMIT_REACHED status event on budget exceeded", () => {
      vi.mocked(calculateTextCost).mockReturnValue(3.25);
      const state = createLoopState({ iterations: 15 });

      checkCostBudget(state, "gemini-3.5-flash", 2.0, emitMock);

      expect(emitMock).toHaveBeenCalledTimes(1);
      expect(emitMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.COST_LIMIT_REACHED,
          estimatedCost: 3.25,
          maxCostDollars: 2.0,
          iteration: 15,
        }),
      );
    });
  });

  describe("null cost estimation (unknown pricing)", () => {
    it("should return false when calculateTextCost returns null", () => {
      vi.mocked(calculateTextCost).mockReturnValue(null);
      const state = createLoopState();

      const result = checkCostBudget(state, "unknown-model", 1.0, emitMock);

      expect(result).toBe(false);
      expect(emitMock).not.toHaveBeenCalled();
    });
  });

  describe("usage accumulation correctness", () => {
    it("should pass current overallUsage and iterations to calculateTextCost", () => {
      vi.mocked(calculateTextCost).mockReturnValue(0.10);
      const state = createLoopState({
        iterations: 7,
        overallUsage: {
          inputTokens: 100000,
          outputTokens: 45000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      });

      checkCostBudget(state, "gemini-3.5-flash", 5.0, emitMock);

      expect(calculateTextCost).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 100000,
          outputTokens: 45000,
          requests: 7,
        }),
        expect.anything(),
      );
    });
  });

  describe("edge cases", () => {
    it("should handle zero usage (fresh session)", () => {
      vi.mocked(calculateTextCost).mockReturnValue(0);
      const state = createLoopState({
        iterations: 0,
        overallUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
        },
      });

      const result = checkCostBudget(state, "gemini-3.5-flash", 0.01, emitMock);

      expect(result).toBe(false);
    });

    it("should handle very small budget thresholds", () => {
      vi.mocked(calculateTextCost).mockReturnValue(0.001);
      const state = createLoopState({ iterations: 1 });

      const result = checkCostBudget(state, "gemini-3.5-flash", 0.0005, emitMock);

      expect(result).toBe(true);
    });
  });
});
