import { vi, describe, it, expect } from "vitest";

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
  allowAll,
  denyAll,
} from "#src/services/PolicyEngine";
import type { PolicyRule, PolicyDecision } from "#src/services/PolicyEngine";

// ═══════════════════════════════════════════════════════════════
// ADVERSARIAL TESTS — PolicyEngine
//
// Hand-crafted edge cases designed to break the priority system,
// expose predicate fault propagation, and verify deterministic
// behavior under malformed, contradictory, or hostile inputs.
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine adversarial — priority inversion attacks", () => {
  it("deny with failing predicate should NOT block allow for the same tool", () => {
    // Attack: A deny rule exists but its predicate always returns false.
    // The engine must fall through to the allow rule, NOT short-circuit.
    const policies: PolicyRule[] = [
      deny("write_file", {
        when: () => false,
        name: "deny-never-matches",
      }),
      allow("write_file", { name: "allow-write" }),
    ];
    const result = PolicyEngine.evaluate(policies, "write_file", {});
    expect(result?.decision).toBe("APPROVE");
    expect(result?.matchedPolicy.name).toBe("allow-write");
  });

  it("multiple deny rules — first matching predicate wins, later ones are irrelevant", () => {
    const policies: PolicyRule[] = [
      deny("execute_shell", {
        when: (args) => String(args.command).includes("rm"),
        name: "deny-rm",
      }),
      deny("execute_shell", {
        when: (args) => String(args.command).includes("sudo"),
        name: "deny-sudo",
      }),
    ];

    const result = PolicyEngine.evaluate(policies, "execute_shell", {
      command: "sudo rm -rf /",
    });
    // Both predicates match, but first-match-wins within same priority
    expect(result?.decision).toBe("DENY");
    expect(result?.matchedPolicy.name).toBe("deny-rm");
  });

  it("specific allow should NOT override wildcard deny when both match — specificity wins", () => {
    // This tests the fundamental priority invariant:
    // specific APPROVE (priority 2) < wildcard DENY (priority 3)
    // BUT specific rules always evaluate before wildcards.
    const policies: PolicyRule[] = [
      denyAll(),
      allow("read_file"),
    ];
    const result = PolicyEngine.evaluate(policies, "read_file", {});
    // Specific allow (priority 2) beats wildcard deny (priority 3)
    expect(result?.decision).toBe("APPROVE");
  });

  it("wildcard allow should NOT override specific deny", () => {
    const policies: PolicyRule[] = [
      allowAll(),
      deny("execute_shell"),
    ];
    const result = PolicyEngine.evaluate(policies, "execute_shell", {});
    // Specific deny (priority 0) beats wildcard allow (priority 5)
    expect(result?.decision).toBe("DENY");
  });

  it("three-way tie: specific deny, ask, allow — deny always wins", () => {
    const policies: PolicyRule[] = [
      allow("tool_x"),
      askUser("tool_x"),
      deny("tool_x"),
    ];
    const result = PolicyEngine.evaluate(policies, "tool_x", {});
    expect(result?.decision).toBe("DENY");
  });
});

describe("PolicyEngine adversarial — predicate fault isolation", () => {
  it("throwing predicate in first rule should not prevent subsequent rules from matching", () => {
    const policies: PolicyRule[] = [
      deny("tool", {
        when: () => {
          throw new TypeError("Cannot read properties of undefined");
        },
        name: "deny-broken",
      }),
      deny("tool", {
        when: () => {
          throw new RangeError("Maximum call stack size exceeded");
        },
        name: "deny-also-broken",
      }),
      allow("tool", { name: "allow-fallback" }),
    ];
    const result = PolicyEngine.evaluate(policies, "tool", {});
    expect(result?.decision).toBe("APPROVE");
    expect(result?.matchedPolicy.name).toBe("allow-fallback");
  });

  it("predicate receiving args with getter that throws should be handled gracefully", () => {
    const policies: PolicyRule[] = [
      deny("tool", {
        when: (args) => {
          // Accessing args.command triggers the getter which throws
          return String(args.command) === "dangerous";
        },
        name: "deny-dangerous",
      }),
      allow("tool", { name: "allow-fallback" }),
    ];

    const trappedArguments = {
      get command(): never {
        throw new Error("Getter trap sprung");
      },
    };

    const result = PolicyEngine.evaluate(
      policies,
      "tool",
      trappedArguments as unknown as Record<string, unknown>,
    );
    // The deny predicate throws via the getter → rule is skipped → allow matches
    expect(result?.decision).toBe("APPROVE");
  });

  it("predicate that returns a truthy non-boolean should still match", () => {
    const policies: PolicyRule[] = [
      deny("tool", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        when: () => "yes" as any,
        name: "deny-truthy-string",
      }),
    ];
    const result = PolicyEngine.evaluate(policies, "tool", {});
    expect(result?.decision).toBe("DENY");
  });

  it("predicate that returns 0 (falsy) should NOT match", () => {
    const policies: PolicyRule[] = [
      deny("tool", {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        when: () => 0 as any,
        name: "deny-zero",
      }),
      allow("tool", { name: "allow-default" }),
    ];
    const result = PolicyEngine.evaluate(policies, "tool", {});
    expect(result?.decision).toBe("APPROVE");
  });
});

describe("PolicyEngine adversarial — malformed input resilience", () => {
  it("undefined args should not crash the engine", () => {
    const policies: PolicyRule[] = [allow("tool")];
    const result = PolicyEngine.evaluate(
      policies,
      "tool",
      undefined as unknown as Record<string, unknown>,
    );
    expect(result?.decision).toBe("APPROVE");
  });

  it("null tool name should return null (no match)", () => {
    const policies: PolicyRule[] = [deny("execute_shell")];
    const result = PolicyEngine.evaluate(
      policies,
      null as unknown as string,
      {},
    );
    expect(result).toBeNull();
  });

  it("tool name with unicode characters should match exactly", () => {
    const unicodeToolName = "búsqueda_herramienta_🔧";
    const policies: PolicyRule[] = [deny(unicodeToolName)];
    const result = PolicyEngine.evaluate(policies, unicodeToolName, {});
    expect(result?.decision).toBe("DENY");
  });

  it("extremely long tool name should not cause performance degradation", () => {
    const longToolName = "a".repeat(10_000);
    const policies: PolicyRule[] = [deny(longToolName)];
    const startTime = performance.now();
    const result = PolicyEngine.evaluate(policies, longToolName, {});
    const elapsed = performance.now() - startTime;
    expect(result?.decision).toBe("DENY");
    expect(elapsed).toBeLessThan(50);
  });

  it("args with deeply nested objects should not cause stack overflow in predicates", () => {
    // Build a 500-level deep nested object
    let deepObject: Record<string, unknown> = { value: "bottom" };
    for (let index = 0; index < 500; index++) {
      deepObject = { nested: deepObject };
    }

    const policies: PolicyRule[] = [
      deny("tool", {
        when: (args) => JSON.stringify(args).includes("bottom"),
        name: "deny-deep",
      }),
    ];
    const result = PolicyEngine.evaluate(policies, "tool", deepObject);
    expect(result?.decision).toBe("DENY");
  });
});

describe("PolicyEngine adversarial — contradictory policy sets", () => {
  it("same tool with opposing decisions and identical predicates — deny wins via priority sort", () => {
    const alwaysTrue = () => true;
    const policies: PolicyRule[] = [
      allow("tool", { when: alwaysTrue, name: "allow-always" }),
      deny("tool", { when: alwaysTrue, name: "deny-always" }),
    ];
    const result = PolicyEngine.evaluate(policies, "tool", {});
    expect(result?.decision).toBe("DENY");
  });

  it("denyAll + allowAll — denyAll takes precedence", () => {
    const policies: PolicyRule[] = [allowAll(), denyAll()];
    const result = PolicyEngine.evaluate(policies, "literally_anything", {});
    expect(result?.decision).toBe("DENY");
  });

  it("specific allow + specific deny + wildcard allow — specific deny wins", () => {
    const policies: PolicyRule[] = [
      allowAll(),
      allow("tool"),
      deny("tool"),
    ];
    const result = PolicyEngine.evaluate(policies, "tool", {});
    expect(result?.decision).toBe("DENY");
  });

  it("no policies at all — null fallthrough for every decision type", () => {
    expect(PolicyEngine.evaluate([], "tool", {})).toBeNull();
    expect(PolicyEngine.isDenied([], "tool", {})).toBe(false);
    expect(PolicyEngine.requiresApproval([], "tool", {})).toBe(false);
  });
});

describe("PolicyEngine adversarial — timing and determinism", () => {
  it("evaluation order is deterministic regardless of insertion order", () => {
    // Same policies, different insertion orders — result must be identical
    const policiesOrderA: PolicyRule[] = [
      allow("tool"),
      deny("tool"),
      askUser("tool"),
    ];
    const policiesOrderB: PolicyRule[] = [
      deny("tool"),
      askUser("tool"),
      allow("tool"),
    ];
    const policiesOrderC: PolicyRule[] = [
      askUser("tool"),
      allow("tool"),
      deny("tool"),
    ];

    const resultA = PolicyEngine.evaluate(policiesOrderA, "tool", {});
    const resultB = PolicyEngine.evaluate(policiesOrderB, "tool", {});
    const resultC = PolicyEngine.evaluate(policiesOrderC, "tool", {});

    expect(resultA?.decision).toBe("DENY");
    expect(resultB?.decision).toBe("DENY");
    expect(resultC?.decision).toBe("DENY");
  });

  it("1000 policies should evaluate in under 50ms", () => {
    const policies: PolicyRule[] = [];
    // 998 non-matching specific rules + 1 wildcard deny + 1 wildcard allow
    for (let index = 0; index < 998; index++) {
      policies.push(allow(`tool_${index}`));
    }
    policies.push(denyAll());
    policies.push(allowAll());

    const startTime = performance.now();
    const result = PolicyEngine.evaluate(policies, "unmatched_tool", {});
    const elapsed = performance.now() - startTime;

    expect(result?.decision).toBe("DENY");
    expect(elapsed).toBeLessThan(50);
  });

  it("calling evaluate does not mutate the input policies array", () => {
    const policies: PolicyRule[] = [
      deny("tool"),
      allow("tool"),
      askUser("other"),
    ];
    const originalPolicies = [...policies];

    PolicyEngine.evaluate(policies, "tool", {});

    // The internal sort must not mutate the caller's array
    expect(policies).toEqual(originalPolicies);
  });
});
