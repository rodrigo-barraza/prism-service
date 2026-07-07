import { vi, describe, it, expect } from "vitest";
import * as fc from "fast-check";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

import ContextBudgetTracker from "#src/services/harnesses/ContextBudgetTracker";
import type { ContextBudgetSnapshot } from "#src/services/harnesses/ContextBudgetTracker";
import {
  MINIMUM_CLAMPED_OUTPUT_TOKENS,
} from "#src/constants/TokenBudgetDefaults";

// ═══════════════════════════════════════════════════════════════
// FUZZ / PROPERTY-BASED TESTS — ContextBudgetTracker
//
// Verifies mathematical invariants of the budget computation
// system hold across thousands of randomized input combinations.
// ═══════════════════════════════════════════════════════════════

function createMockEmit() {
  const emittedEvents: Array<Record<string, unknown>> = [];
  const emit = vi.fn((event: { type: string; [key: string]: unknown }) => {
    emittedEvents.push(event);
  });
  return { emit, emittedEvents };
}

// ── Custom Arbitraries ──────────────────────────────────────────

/** Context window sizes from tiny to huge */
const arbitraryContextWindow = fc.oneof(
  fc.integer({ min: 0, max: 100 }),          // Tiny/zero
  fc.integer({ min: 1_000, max: 200_000 }),   // Realistic range
  fc.integer({ min: 200_000, max: 2_000_000 }), // Future large models
);

/** Token count values */
const arbitraryTokenCount = fc.integer({ min: 0, max: 500_000 });

/** System prompt text */
const arbitrarySystemPrompt = fc.oneof(
  fc.constant(""),
  fc.string({ minLength: 1, maxLength: 100 }),
  fc.string({ minLength: 100, maxLength: 5_000 }),
);

/** Tool schema arrays (varying sizes) */
const arbitraryToolSchemas = fc.array(
  fc.record({
    name: fc.string({ minLength: 1, maxLength: 30 }),
    description: fc.string({ minLength: 0, maxLength: 200 }),
  }),
  { minLength: 0, maxLength: 30 },
);

/** Requested max tokens — can be undefined */
const arbitraryRequestedMaxTokens = fc.option(
  fc.integer({ min: 0, max: 200_000 }),
  { nil: undefined },
);

// ═══════════════════════════════════════════════════════════════
// Mathematical Invariants
// ═══════════════════════════════════════════════════════════════

describe("ContextBudgetTracker fuzz — mathematical invariants", () => {
  it("availableOutputTokens is always >= 0 (never negative)", () => {
    fc.assert(
      fc.property(
        arbitraryContextWindow,
        arbitraryTokenCount,
        arbitrarySystemPrompt,
        arbitraryToolSchemas,
        arbitraryRequestedMaxTokens,
        (contextWindow, messageTokens, systemPrompt, toolSchemas, requestedMaxTokens) => {
          const { emit, emittedEvents } = createMockEmit();
          const tracker = new ContextBudgetTracker(emit, contextWindow);

          tracker.computeAndEmitEstimate(
            messageTokens,
            systemPrompt,
            toolSchemas,
            requestedMaxTokens,
          );

          const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;
          expect(snapshot.availableOutputTokens).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("totalInputTokens always equals messageTokens + systemPromptTokens + toolSchemaTokens + safetyMarginTokens", () => {
    fc.assert(
      fc.property(
        arbitraryContextWindow,
        arbitraryTokenCount,
        arbitrarySystemPrompt,
        arbitraryToolSchemas,
        (contextWindow, messageTokens, systemPrompt, toolSchemas) => {
          const { emit, emittedEvents } = createMockEmit();
          const tracker = new ContextBudgetTracker(emit, contextWindow);

          tracker.computeAndEmitEstimate(messageTokens, systemPrompt, toolSchemas, undefined);

          const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;
          const expectedTotal =
            snapshot.messageTokens +
            snapshot.systemPromptTokens +
            snapshot.toolSchemaTokens +
            snapshot.safetyMarginTokens;

          expect(snapshot.totalInputTokens).toBe(expectedTotal);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("contextWindow in snapshot always matches constructor argument", () => {
    fc.assert(
      fc.property(
        arbitraryContextWindow,
        arbitraryTokenCount,
        (contextWindow, messageTokens) => {
          const { emit, emittedEvents } = createMockEmit();
          const tracker = new ContextBudgetTracker(emit, contextWindow);

          tracker.computeAndEmitEstimate(messageTokens, "prompt", [], undefined);

          const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;
          expect(snapshot.contextWindow).toBe(contextWindow);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("availableOutputTokens equals max(contextWindow - totalInputTokens, 0)", () => {
    fc.assert(
      fc.property(
        arbitraryContextWindow,
        arbitraryTokenCount,
        arbitrarySystemPrompt,
        arbitraryToolSchemas,
        (contextWindow, messageTokens, systemPrompt, toolSchemas) => {
          const { emit, emittedEvents } = createMockEmit();
          const tracker = new ContextBudgetTracker(emit, contextWindow);

          tracker.computeAndEmitEstimate(messageTokens, systemPrompt, toolSchemas, undefined);

          const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;
          // availableOutputTokens is clamped to max(contextWindow - totalInput, 0)
          const expectedAvailable = Math.max(
            contextWindow - snapshot.totalInputTokens,
            0,
          );
          expect(snapshot.availableOutputTokens).toBe(expectedAvailable);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("all snapshot values are finite numbers (no NaN or Infinity)", () => {
    fc.assert(
      fc.property(
        arbitraryContextWindow,
        arbitraryTokenCount,
        arbitrarySystemPrompt,
        arbitraryToolSchemas,
        arbitraryRequestedMaxTokens,
        (contextWindow, messageTokens, systemPrompt, toolSchemas, requestedMaxTokens) => {
          const { emit, emittedEvents } = createMockEmit();
          const tracker = new ContextBudgetTracker(emit, contextWindow);

          tracker.computeAndEmitEstimate(
            messageTokens,
            systemPrompt,
            toolSchemas,
            requestedMaxTokens,
          );

          const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;
          expect(Number.isFinite(snapshot.contextWindow)).toBe(true);
          expect(Number.isFinite(snapshot.messageTokens)).toBe(true);
          expect(Number.isFinite(snapshot.systemPromptTokens)).toBe(true);
          expect(Number.isFinite(snapshot.toolSchemaTokens)).toBe(true);
          expect(Number.isFinite(snapshot.safetyMarginTokens)).toBe(true);
          expect(Number.isFinite(snapshot.totalInputTokens)).toBe(true);
          expect(Number.isFinite(snapshot.availableOutputTokens)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Clamping Invariants
// ═══════════════════════════════════════════════════════════════

describe("ContextBudgetTracker fuzz — clamping invariants", () => {
  it("clampedMaxTokens is always >= MINIMUM_CLAMPED_OUTPUT_TOKENS when clamping occurs", () => {
    fc.assert(
      fc.property(
        arbitraryContextWindow,
        arbitraryTokenCount,
        arbitrarySystemPrompt,
        fc.integer({ min: 1, max: 500_000 }),
        (contextWindow, messageTokens, systemPrompt, requestedMaxTokens) => {
          const { emit } = createMockEmit();
          const tracker = new ContextBudgetTracker(emit, contextWindow);

          const result = tracker.computeAndEmitEstimate(
            messageTokens,
            systemPrompt,
            [],
            requestedMaxTokens,
          );

          // If clamping occurred (requested > available), the floor must hold
          if (
            result.clampedMaxTokens !== undefined &&
            result.clampedMaxTokens !== requestedMaxTokens
          ) {
            expect(result.clampedMaxTokens).toBeGreaterThanOrEqual(
              MINIMUM_CLAMPED_OUTPUT_TOKENS,
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("isClamped is true iff requestedMaxTokens > availableForOutput (truthy requestedMaxTokens)", () => {
    fc.assert(
      fc.property(
        arbitraryContextWindow,
        arbitraryTokenCount,
        fc.integer({ min: 1, max: 500_000 }),
        (contextWindow, messageTokens, requestedMaxTokens) => {
          const { emit, emittedEvents } = createMockEmit();
          const tracker = new ContextBudgetTracker(emit, contextWindow);

          const result = tracker.computeAndEmitEstimate(
            messageTokens,
            "prompt",
            [],
            requestedMaxTokens,
          );

          const snapshot = emittedEvents[0] as unknown as ContextBudgetSnapshot;

          if (requestedMaxTokens > result.availableForOutput) {
            expect(snapshot.isClamped).toBe(true);
          } else {
            expect(snapshot.isClamped).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("when not clamped, clampedMaxTokens equals the original requestedMaxTokens", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100_000, max: 2_000_000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (contextWindow, messageTokens, requestedMaxTokens) => {
          const { emit } = createMockEmit();
          const tracker = new ContextBudgetTracker(emit, contextWindow);

          const result = tracker.computeAndEmitEstimate(
            messageTokens,
            "",
            [],
            requestedMaxTokens,
          );

          // With huge context and tiny input, clamping shouldn't trigger
          if (requestedMaxTokens <= result.availableForOutput) {
            expect(result.clampedMaxTokens).toBe(requestedMaxTokens);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Calibration Invariants
// ═══════════════════════════════════════════════════════════════

describe("ContextBudgetTracker fuzz — calibration invariants", () => {
  it("calibration ratio is always a positive finite number when set", () => {
    fc.assert(
      fc.property(
        arbitraryContextWindow,
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 500_000 }),
        (contextWindow, estimatedTokens, realInputTokens) => {
          const { emit } = createMockEmit();
          const tracker = new ContextBudgetTracker(emit, contextWindow);

          tracker.computeAndEmitEstimate(estimatedTokens, "prompt", [], 16384);
          tracker.recordRealUsage(
            { inputTokens: realInputTokens, outputTokens: 100 } as any,
            estimatedTokens,
          );

          const ratio = tracker.getCalibrationRatio();
          if (ratio !== null) {
            expect(ratio).toBeGreaterThan(0);
            expect(Number.isFinite(ratio)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("recorded usage snapshot source is always 'reported'", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 10_000, max: 500_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 200_000 }),
        (contextWindow, estimatedTokens, realInputTokens) => {
          const { emit, emittedEvents } = createMockEmit();
          const tracker = new ContextBudgetTracker(emit, contextWindow);

          tracker.computeAndEmitEstimate(estimatedTokens, "prompt", [], 16384);
          tracker.recordRealUsage(
            { inputTokens: realInputTokens, outputTokens: 100 } as any,
            estimatedTokens,
          );

          // Second event should be the "reported" snapshot
          if (emittedEvents.length >= 2) {
            const reportedSnapshot = emittedEvents[1] as unknown as ContextBudgetSnapshot;
            expect(reportedSnapshot.source).toBe("reported");
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// estimateFromMessages Invariants
// ═══════════════════════════════════════════════════════════════

describe("ContextBudgetTracker fuzz — estimateFromMessages invariants", () => {
  const arbitraryMessage = fc.record({
    role: fc.constantFrom("user", "assistant", "system"),
    content: fc.oneof(
      fc.string({ maxLength: 2000 }),
      fc.array(
        fc.record({
          type: fc.constant("text"),
          text: fc.string({ maxLength: 200 }),
        }),
        { maxLength: 5 },
      ),
    ),
  });

  it("more messages always produce >= messageTokens (monotonic)", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryMessage, { minLength: 0, maxLength: 20 }),
        arbitraryContextWindow.filter((window) => window > 0),
        (messages, contextWindow) => {
          const snapshot = ContextBudgetTracker.estimateFromMessages(
            messages,
            contextWindow,
          );

          // Adding any message should only increase or maintain token count
          // (due to the 4-token per-message overhead)
          if (messages.length > 0) {
            const emptySnapshot = ContextBudgetTracker.estimateFromMessages(
              [],
              contextWindow,
            );
            expect(snapshot.messageTokens).toBeGreaterThanOrEqual(
              emptySnapshot.messageTokens,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("source is always 'estimated' (static method never uses real data)", () => {
    fc.assert(
      fc.property(
        fc.array(arbitraryMessage, { minLength: 0, maxLength: 10 }),
        arbitraryContextWindow,
        (messages, contextWindow) => {
          const snapshot = ContextBudgetTracker.estimateFromMessages(
            messages,
            contextWindow,
          );
          expect(snapshot.source).toBe("estimated");
          expect(snapshot.isClamped).toBe(false);
          expect(snapshot.toolCount).toBe(0);
          expect(snapshot.toolSchemaTokens).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("output never crashes regardless of message content shape", () => {
    const wildMessage = fc.record({
      role: fc.string({ maxLength: 10 }),
      content: fc.oneof(
        fc.string(),
        fc.constant(null),
        fc.constant(undefined),
        fc.integer(),
        fc.array(fc.anything(), { maxLength: 3 }),
      ),
    });

    fc.assert(
      fc.property(
        fc.array(wildMessage, { minLength: 0, maxLength: 10 }),
        arbitraryContextWindow,
        (messages, contextWindow) => {
          // Must never throw
          const snapshot = ContextBudgetTracker.estimateFromMessages(
            messages as any,
            contextWindow,
          );
          expect(snapshot).toBeDefined();
          expect(Number.isFinite(snapshot.messageTokens)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});
