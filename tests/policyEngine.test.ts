import { vi, describe, it, expect, beforeEach } from "vitest";

// Suppress logger output during tests
vi.mock("../src/utils/logger.ts", () => ({
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
} from "../src/services/PolicyEngine.ts";
import type { PolicyRule } from "../src/services/PolicyEngine.ts";

// ═══════════════════════════════════════════════════════════════
// Builder Functions
// ═══════════════════════════════════════════════════════════════

describe("Policy builder functions", () => {
  describe("allow()", () => {
    it("creates an APPROVE rule for a specific tool", () => {
      const rule = allow("read_file");
      expect(rule.tool).toBe("read_file");
      expect(rule.decision).toBe("APPROVE");
      expect(rule.name).toBe("allow(read_file)");
      expect(rule.when).toBeUndefined();
    });

    it("accepts a `when` predicate", () => {
      const rule = allow("execute_shell", {
        when: (args) => /^git\s/.test(String(args.command)),
      });
      expect(rule.when).toBeDefined();
      expect(rule.when!({ command: "git status" })).toBe(true);
      expect(rule.when!({ command: "rm -rf /" })).toBe(false);
    });

    it("accepts a custom name", () => {
      const rule = allow("execute_shell", { name: "allow-git" });
      expect(rule.name).toBe("allow-git");
    });
  });

  describe("deny()", () => {
    it("creates a DENY rule for a specific tool", () => {
      const rule = deny("execute_shell");
      expect(rule.tool).toBe("execute_shell");
      expect(rule.decision).toBe("DENY");
      expect(rule.name).toBe("deny(execute_shell)");
    });

    it("accepts a `when` predicate", () => {
      const rule = deny("execute_shell", {
        when: (args) => /rm\s+-rf/.test(String(args.command)),
      });
      expect(rule.when!({ command: "rm -rf /" })).toBe(true);
      expect(rule.when!({ command: "ls -la" })).toBe(false);
    });
  });

  describe("askUser()", () => {
    it("creates an ASK_USER rule for a specific tool", () => {
      const rule = askUser("write_file");
      expect(rule.tool).toBe("write_file");
      expect(rule.decision).toBe("ASK_USER");
      expect(rule.name).toBe("askUser(write_file)");
    });
  });

  describe("allowAll()", () => {
    it("creates a wildcard APPROVE rule", () => {
      const rule = allowAll();
      expect(rule.tool).toBe("*");
      expect(rule.decision).toBe("APPROVE");
      expect(rule.name).toBe("allowAll()");
    });
  });

  describe("denyAll()", () => {
    it("creates a wildcard DENY rule", () => {
      const rule = denyAll();
      expect(rule.tool).toBe("*");
      expect(rule.decision).toBe("DENY");
      expect(rule.name).toBe("denyAll()");
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// PolicyEngine.evaluate() — Basic Matching
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine.evaluate — basic matching", () => {
  it("returns null for empty policies array", () => {
    const result = PolicyEngine.evaluate([], "read_file", {});
    expect(result).toBeNull();
  });

  it("returns null when no policies match the tool", () => {
    const policies = [deny("execute_shell")];
    const result = PolicyEngine.evaluate(policies, "read_file", {});
    expect(result).toBeNull();
  });

  it("matches a specific DENY rule", () => {
    const policies = [deny("execute_shell")];
    const result = PolicyEngine.evaluate(policies, "execute_shell", {});

    expect(result).not.toBeNull();
    expect(result!.decision).toBe("DENY");
    expect(result!.matchedPolicy.tool).toBe("execute_shell");
    expect(result!.reason).toContain("Denied by policy");
  });

  it("matches a specific APPROVE rule", () => {
    const policies = [allow("read_file")];
    const result = PolicyEngine.evaluate(policies, "read_file", {});

    expect(result).not.toBeNull();
    expect(result!.decision).toBe("APPROVE");
    expect(result!.reason).toContain("Approved by policy");
  });

  it("matches a specific ASK_USER rule", () => {
    const policies = [askUser("write_file")];
    const result = PolicyEngine.evaluate(policies, "write_file", {});

    expect(result).not.toBeNull();
    expect(result!.decision).toBe("ASK_USER");
    expect(result!.reason).toContain("Requires approval");
  });

  it("matches a wildcard rule for any tool", () => {
    const policies = [denyAll()];
    const result = PolicyEngine.evaluate(policies, "some_random_tool", {});

    expect(result).not.toBeNull();
    expect(result!.decision).toBe("DENY");
  });
});

// ═══════════════════════════════════════════════════════════════
// PolicyEngine.evaluate() — Predicate Matching
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine.evaluate — predicate matching", () => {
  it("matches when predicate returns true", () => {
    const policies = [
      deny("execute_shell", {
        when: (args) => /rm\s+-rf/.test(String(args.command)),
      }),
    ];
    const result = PolicyEngine.evaluate(policies, "execute_shell", {
      command: "rm -rf /",
    });

    expect(result).not.toBeNull();
    expect(result!.decision).toBe("DENY");
  });

  it("skips rule when predicate returns false", () => {
    const policies = [
      deny("execute_shell", {
        when: (args) => /rm\s+-rf/.test(String(args.command)),
      }),
    ];
    const result = PolicyEngine.evaluate(policies, "execute_shell", {
      command: "ls -la",
    });

    expect(result).toBeNull();
  });

  it("skips rule and logs warning when predicate throws", () => {
    const policies = [
      deny("execute_shell", {
        when: () => {
          throw new Error("predicate error");
        },
      }),
    ];
    const result = PolicyEngine.evaluate(policies, "execute_shell", {});

    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// PolicyEngine.evaluate() — Priority Ordering
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine.evaluate — priority ordering", () => {
  it("specific DENY takes priority over specific APPROVE", () => {
    const policies = [
      allow("execute_shell"),
      deny("execute_shell"),
    ];
    const result = PolicyEngine.evaluate(policies, "execute_shell", {});

    expect(result!.decision).toBe("DENY");
  });

  it("specific DENY takes priority over specific ASK_USER", () => {
    const policies = [
      askUser("execute_shell"),
      deny("execute_shell"),
    ];
    const result = PolicyEngine.evaluate(policies, "execute_shell", {});

    expect(result!.decision).toBe("DENY");
  });

  it("specific ASK_USER takes priority over specific APPROVE", () => {
    const policies = [
      allow("execute_shell"),
      askUser("execute_shell"),
    ];
    const result = PolicyEngine.evaluate(policies, "execute_shell", {});

    expect(result!.decision).toBe("ASK_USER");
  });

  it("specific rules take priority over wildcard rules", () => {
    const policies = [
      denyAll(),
      allow("read_file"),
    ];
    const result = PolicyEngine.evaluate(policies, "read_file", {});

    expect(result!.decision).toBe("APPROVE");
  });

  it("wildcard DENY still catches unmatched tools", () => {
    const policies = [
      allow("read_file"),
      denyAll(),
    ];
    const result = PolicyEngine.evaluate(policies, "execute_shell", {});

    expect(result!.decision).toBe("DENY");
  });

  it("conditional deny > unconditional allow for the same tool", () => {
    const policies = [
      allow("execute_shell"),
      deny("execute_shell", {
        when: (args) => /rm/.test(String(args.command)),
      }),
    ];

    const rmResult = PolicyEngine.evaluate(policies, "execute_shell", {
      command: "rm -rf /",
    });
    expect(rmResult!.decision).toBe("DENY");

    const lsResult = PolicyEngine.evaluate(policies, "execute_shell", {
      command: "ls",
    });
    expect(lsResult!.decision).toBe("APPROVE");
  });
});

// ═══════════════════════════════════════════════════════════════
// PolicyEngine.evaluate() — Complex Scenarios
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine.evaluate — complex scenarios", () => {
  it("git commands allowed, rm denied, all others ask", () => {
    // Priority ordering: DENY(0) < ASK_USER(1) < APPROVE(2)
    // Within the same tool and specificity, lower priority wins first.
    // An unconditional askUser would beat a conditional allow, so we
    // use conditionals on all rules to achieve the desired behavior.
    const policies: PolicyRule[] = [
      deny("execute_shell", {
        when: (args) => /rm\s+-rf/.test(String(args.command)),
        name: "deny-destructive",
      }),
      allow("execute_shell", {
        when: (args) => /^git\s/.test(String(args.command)),
        name: "allow-git",
      }),
      askUser("execute_shell", {
        when: (args) => !/^git\s/.test(String(args.command)),
        name: "ask-non-git",
      }),
    ];

    // git should be allowed (deny predicate fails, allow predicate matches)
    const git = PolicyEngine.evaluate(policies, "execute_shell", {
      command: "git status",
    });
    expect(git!.decision).toBe("APPROVE");

    // rm -rf should be denied (deny predicate matches first)
    const rm = PolicyEngine.evaluate(policies, "execute_shell", {
      command: "rm -rf /home",
    });
    expect(rm!.decision).toBe("DENY");

    // anything else should ask (deny predicate fails, allow predicate fails, askUser predicate matches)
    const npm = PolicyEngine.evaluate(policies, "execute_shell", {
      command: "npm install",
    });
    expect(npm!.decision).toBe("ASK_USER");
  });

  it("no matching rule returns null for fallthrough", () => {
    const policies = [
      deny("execute_shell"),
      allow("read_file"),
    ];
    // write_file has no policy
    const result = PolicyEngine.evaluate(policies, "write_file", {});
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// PolicyEngine convenience methods
// ═══════════════════════════════════════════════════════════════

describe("PolicyEngine.isDenied", () => {
  it("returns true when tool is denied by policy", () => {
    const policies = [deny("execute_shell")];
    expect(PolicyEngine.isDenied(policies, "execute_shell", {})).toBe(true);
  });

  it("returns false when tool is allowed", () => {
    const policies = [allow("execute_shell")];
    expect(PolicyEngine.isDenied(policies, "execute_shell", {})).toBe(false);
  });

  it("returns false when no policies match", () => {
    const policies = [deny("execute_shell")];
    expect(PolicyEngine.isDenied(policies, "read_file", {})).toBe(false);
  });
});

describe("PolicyEngine.requiresApproval", () => {
  it("returns true when tool requires user approval", () => {
    const policies = [askUser("write_file")];
    expect(PolicyEngine.requiresApproval(policies, "write_file", {})).toBe(true);
  });

  it("returns false when tool is approved", () => {
    const policies = [allow("write_file")];
    expect(PolicyEngine.requiresApproval(policies, "write_file", {})).toBe(false);
  });

  it("returns false when no policies match (null)", () => {
    const policies = [askUser("write_file")];
    expect(PolicyEngine.requiresApproval(policies, "read_file", {})).toBe(false);
  });
});
