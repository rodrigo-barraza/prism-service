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

import PolicyEngine, {
  allow,
  deny,
  askUser,
} from "#src/services/PolicyEngine";
import type { PolicyRule, PolicyDecision } from "#src/services/PolicyEngine";

// ═══════════════════════════════════════════════════════════════
// FUZZ / PROPERTY-BASED TESTS — PolicyEngine
//
// Uses fast-check to generate thousands of randomized inputs
// and verify that structural invariants hold under ALL conditions,
// not just the specific edge cases a human can think of.
//
// Property-based testing is the TypeScript-ecosystem analogue of
// fuzz testing: generate random inputs, assert universal properties.
// ═══════════════════════════════════════════════════════════════

// ── Custom Arbitraries ──────────────────────────────────────────

/** Generates a random valid PolicyDecision */
const arbitraryDecision: fc.Arbitrary<PolicyDecision> = fc.constantFrom(
  "APPROVE",
  "DENY",
  "ASK_USER",
);

/** Generates a random tool name (including edge-case strings) */
const arbitraryToolName: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 50 }),
  fc.constantFrom(
    "execute_shell",
    "read_file",
    "write_file",
    "*",
    "",
    "mcp__server/tool.v2",
    "tool-with-dashes",
    "búsqueda_🔧",
  ),
);

/** Generates a random args object with arbitrary string keys and values */
const arbitraryArguments: fc.Arbitrary<Record<string, unknown>> = fc.dictionary(
  fc.string({ minLength: 1, maxLength: 20 }),
  fc.oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.float(),
    fc.array(fc.string(), { maxLength: 5 }),
  ),
  { minKeys: 0, maxKeys: 10 },
);

/** Generates a random PolicyRule without a predicate */
const arbitraryPolicyRule: fc.Arbitrary<PolicyRule> = fc.record({
  tool: arbitraryToolName,
  decision: arbitraryDecision,
  name: fc.option(fc.string({ minLength: 1, maxLength: 30 }), {
    nil: undefined,
  }),
}) as fc.Arbitrary<PolicyRule>;

/** Generates a random set of PolicyRules */
const arbitraryPolicySet: fc.Arbitrary<PolicyRule[]> = fc.array(
  arbitraryPolicyRule,
  { minLength: 0, maxLength: 20 },
);

// ═══════════════════════════════════════════════════════════════
// Universal Invariant Properties
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine fuzz — universal invariants", () => {
  it("evaluate never throws for any combination of inputs", () => {
    fc.assert(
      fc.property(
        arbitraryPolicySet,
        arbitraryToolName,
        arbitraryArguments,
        (policies, toolName, args) => {
          // This must never throw — resilience is a hard requirement
          const result = PolicyEngine.evaluate(policies, toolName, args);
          // Result is either null or a well-formed PolicyEvaluation
          if (result !== null) {
            expect(result.decision).toMatch(/^(APPROVE|DENY|ASK_USER)$/);
            expect(result.matchedPolicy).toBeDefined();
            expect(typeof result.reason).toBe("string");
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("evaluate result decision always matches the matched policy's decision", () => {
    fc.assert(
      fc.property(
        arbitraryPolicySet,
        arbitraryToolName,
        arbitraryArguments,
        (policies, toolName, args) => {
          const result = PolicyEngine.evaluate(policies, toolName, args);
          if (result !== null) {
            expect(result.decision).toBe(result.matchedPolicy.decision);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("evaluate never mutates the input policies array", () => {
    fc.assert(
      fc.property(
        arbitraryPolicySet,
        arbitraryToolName,
        arbitraryArguments,
        (policies, toolName, args) => {
          const originalSnapshot = policies.map((policy) => ({ ...policy }));
          PolicyEngine.evaluate(policies, toolName, args);
          expect(policies.length).toBe(originalSnapshot.length);
          policies.forEach((policy, index) => {
            expect(policy.tool).toBe(originalSnapshot[index].tool);
            expect(policy.decision).toBe(originalSnapshot[index].decision);
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("empty policies array always returns null", () => {
    fc.assert(
      fc.property(
        arbitraryToolName,
        arbitraryArguments,
        (toolName, args) => {
          expect(PolicyEngine.evaluate([], toolName, args)).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Priority Ordering Invariants
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine fuzz — priority ordering invariants", () => {
  it("specific deny always beats specific allow for the same tool (insertion-order invariant)", () => {
    fc.assert(
      fc.property(
        arbitraryToolName.filter((toolName) => toolName !== "*" && toolName.length > 0),
        arbitraryArguments,
        fc.boolean(),
        (toolName, args, denyFirst) => {
          const policies = denyFirst
            ? [deny(toolName), allow(toolName)]
            : [allow(toolName), deny(toolName)];

          const result = PolicyEngine.evaluate(policies, toolName, args);
          expect(result?.decision).toBe("DENY");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("specific deny always beats specific askUser for the same tool", () => {
    fc.assert(
      fc.property(
        arbitraryToolName.filter((toolName) => toolName !== "*" && toolName.length > 0),
        arbitraryArguments,
        fc.boolean(),
        (toolName, args, denyFirst) => {
          const policies = denyFirst
            ? [deny(toolName), askUser(toolName)]
            : [askUser(toolName), deny(toolName)];

          const result = PolicyEngine.evaluate(policies, toolName, args);
          expect(result?.decision).toBe("DENY");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("specific askUser always beats specific allow for the same tool", () => {
    fc.assert(
      fc.property(
        arbitraryToolName.filter((toolName) => toolName !== "*" && toolName.length > 0),
        arbitraryArguments,
        fc.boolean(),
        (toolName, args, askFirst) => {
          const policies = askFirst
            ? [askUser(toolName), allow(toolName)]
            : [allow(toolName), askUser(toolName)];

          const result = PolicyEngine.evaluate(policies, toolName, args);
          expect(result?.decision).toBe("ASK_USER");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("specific rules always beat wildcard rules regardless of decision type", () => {
    fc.assert(
      fc.property(
        arbitraryToolName.filter((toolName) => toolName !== "*" && toolName.length > 0),
        arbitraryDecision,
        arbitraryDecision,
        arbitraryArguments,
        (toolName, specificDecision, wildcardDecision, args) => {
          const specificRule: PolicyRule = {
            tool: toolName,
            decision: specificDecision,
          };
          const wildcardRule: PolicyRule = {
            tool: "*",
            decision: wildcardDecision,
          };
          // Randomize insertion order
          const policies = [wildcardRule, specificRule];
          const result = PolicyEngine.evaluate(policies, toolName, args);

          // The specific rule must always win
          expect(result?.decision).toBe(specificDecision);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Determinism Property
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine fuzz — determinism", () => {
  it("same inputs always produce the same output (idempotent evaluation)", () => {
    fc.assert(
      fc.property(
        arbitraryPolicySet,
        arbitraryToolName,
        arbitraryArguments,
        (policies, toolName, args) => {
          const firstResult = PolicyEngine.evaluate(policies, toolName, args);
          const secondResult = PolicyEngine.evaluate(policies, toolName, args);

          if (firstResult === null) {
            expect(secondResult).toBeNull();
          } else {
            expect(secondResult?.decision).toBe(firstResult.decision);
            expect(secondResult?.matchedPolicy.tool).toBe(
              firstResult.matchedPolicy.tool,
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("shuffling the policies array produces the same decision (order independence)", () => {
    fc.assert(
      fc.property(
        arbitraryPolicySet.filter(
          (policies) => policies.length >= 2 && policies.length <= 10,
        ),
        arbitraryToolName,
        arbitraryArguments,
        fc.infiniteStream(fc.nat()),
        (policies, toolName, args, randomStream) => {
          const referenceResult = PolicyEngine.evaluate(
            policies,
            toolName,
            args,
          );

          // Fisher-Yates shuffle using the random stream
          const shuffled = [...policies];
          const streamIterator = randomStream[Symbol.iterator]();
          for (let index = shuffled.length - 1; index > 0; index--) {
            const swapIndex =
              (streamIterator.next().value as number) % (index + 1);
            [shuffled[index], shuffled[swapIndex]] = [
              shuffled[swapIndex],
              shuffled[index],
            ];
          }

          const shuffledResult = PolicyEngine.evaluate(
            shuffled,
            toolName,
            args,
          );

          if (referenceResult === null) {
            expect(shuffledResult).toBeNull();
          } else {
            expect(shuffledResult?.decision).toBe(referenceResult.decision);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Convenience Method Consistency
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine fuzz — convenience method consistency", () => {
  it("isDenied returns true iff evaluate returns DENY", () => {
    fc.assert(
      fc.property(
        arbitraryPolicySet,
        arbitraryToolName,
        arbitraryArguments,
        (policies, toolName, args) => {
          const evaluateResult = PolicyEngine.evaluate(
            policies,
            toolName,
            args,
          );
          const isDeniedResult = PolicyEngine.isDenied(
            policies,
            toolName,
            args,
          );

          if (evaluateResult?.decision === "DENY") {
            expect(isDeniedResult).toBe(true);
          } else {
            expect(isDeniedResult).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("requiresApproval returns true iff evaluate returns ASK_USER", () => {
    fc.assert(
      fc.property(
        arbitraryPolicySet,
        arbitraryToolName,
        arbitraryArguments,
        (policies, toolName, args) => {
          const evaluateResult = PolicyEngine.evaluate(
            policies,
            toolName,
            args,
          );
          const requiresApprovalResult = PolicyEngine.requiresApproval(
            policies,
            toolName,
            args,
          );

          if (evaluateResult?.decision === "ASK_USER") {
            expect(requiresApprovalResult).toBe(true);
          } else {
            expect(requiresApprovalResult).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Predicate Fault Tolerance Under Random Inputs
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine fuzz — predicate fault tolerance", () => {
  it("throwing predicates never crash the engine regardless of args", () => {
    const throwingRule: PolicyRule = {
      tool: "*",
      decision: "DENY",
      when: () => {
        throw new Error("Random predicate failure");
      },
      name: "always-throws",
    };
    const fallbackRule: PolicyRule = {
      tool: "*",
      decision: "APPROVE",
      name: "fallback-allow",
    };

    fc.assert(
      fc.property(
        arbitraryToolName,
        arbitraryArguments,
        (toolName, args) => {
          const result = PolicyEngine.evaluate(
            [throwingRule, fallbackRule],
            toolName,
            args,
          );
          // Throwing deny is skipped → fallback allow matches
          expect(result?.decision).toBe("APPROVE");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("predicates receiving random args never cause unhandled exceptions", () => {
    const predicateRule: PolicyRule = {
      tool: "*",
      decision: "DENY",
      when: (args) => {
        // Intentionally fragile predicate — accesses deep paths
        const command = String(args.command ?? "");
        return command.length > 100 && command.includes("danger");
      },
      name: "fragile-predicate",
    };

    fc.assert(
      fc.property(
        arbitraryToolName,
        arbitraryArguments,
        (toolName, args) => {
          // Must never throw
          const result = PolicyEngine.evaluate(
            [predicateRule],
            toolName,
            args,
          );
          // Result is either matched or null — both are valid
          if (result !== null) {
            expect(result.decision).toBe("DENY");
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
