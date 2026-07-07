import { vi, describe, it, expect, afterEach } from "vitest";

// Suppress logger output during tests
vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
  },
}));

import AutoApprovalEngine, {
  APPROVAL_TIERS,
} from "#src/services/AutoApprovalEngine";
import {
  pendingApprovals,
  pendingQuestions,
} from "#src/services/ApprovalRegistry";
import type {
  ApprovalResolution,
  PendingToolApprovalEntry,
  QuestionResolution,
} from "#src/services/ApprovalRegistry";
import {
  allow,
  deny,
} from "#src/services/PolicyEngine";

// ═══════════════════════════════════════════════════════════════
// Tier Constants
// ═══════════════════════════════════════════════════════════════

describe("APPROVAL_TIERS constants", () => {
  it("defines AUTO = 1", () => {
    expect(APPROVAL_TIERS.AUTO).toBe(1);
  });

  it("defines WRITE = 2", () => {
    expect(APPROVAL_TIERS.WRITE).toBe(2);
  });

  it("defines DANGER = 3", () => {
    expect(APPROVAL_TIERS.DANGER).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// getTier() — Default Tier Assignments
// ═══════════════════════════════════════════════════════════════

describe("getTier — default assignments", () => {
  const engine = new AutoApprovalEngine();

  // ── Tier 1: Read-only tools ──

  const tier1Tools = [
    "read_file",
    "list_directory",
    "search_file_contents",
    "find_files",
    "search_web",
    "read_web_page",
    "read_files",
    "get_file_info",
    "diff_files",
    "git_status",
    "git_diff",
    "git_log",
    "summarize_project",
  ];

  for (const tool of tier1Tools) {
    it(`${tool} → Tier 1 (AUTO)`, () => {
      expect(engine.getTier(tool)).toBe(APPROVAL_TIERS.AUTO);
    });
  }

  // ── Tier 2: Write tools ──

  const tier2Tools = [
    "write_file",
    "replace_in_file",
    "patch_file",
    "move_file",
    "delete_file",
    "control_browser",
  ];

  for (const tool of tier2Tools) {
    it(`${tool} → Tier 2 (WRITE)`, () => {
      expect(engine.getTier(tool)).toBe(APPROVAL_TIERS.WRITE);
    });
  }

  // ── Tier 3: Dangerous tools ──

  const tier3Tools = [
    "execute_shell",
    "execute_python",
    "execute_javascript",
    "execute_command",
  ];

  for (const tool of tier3Tools) {
    it(`${tool} → Tier 3 (DANGER)`, () => {
      expect(engine.getTier(tool)).toBe(APPROVAL_TIERS.DANGER);
    });
  }

  // ── Unknown tools default to Tier 2 ──

  it("unknown tool defaults to Tier 2 (WRITE)", () => {
    expect(engine.getTier("custom_unknown_tool")).toBe(APPROVAL_TIERS.WRITE);
  });

  it("MCP-namespaced tool defaults to Tier 2", () => {
    expect(engine.getTier("mcp__server__tool")).toBe(APPROVAL_TIERS.WRITE);
  });
});

// ═══════════════════════════════════════════════════════════════
// getTier() — Tier Overrides
// ═══════════════════════════════════════════════════════════════

describe("getTier — tier overrides", () => {
  it("overrides a Tier 1 tool to Tier 3", () => {
    const engine = new AutoApprovalEngine({
      tierOverrides: { read_file: APPROVAL_TIERS.DANGER },
    });
    expect(engine.getTier("read_file")).toBe(APPROVAL_TIERS.DANGER);
  });

  it("overrides a Tier 3 tool to Tier 1", () => {
    const engine = new AutoApprovalEngine({
      tierOverrides: { execute_shell: APPROVAL_TIERS.AUTO },
    });
    expect(engine.getTier("execute_shell")).toBe(APPROVAL_TIERS.AUTO);
  });

  it("override only affects the specified tool", () => {
    const engine = new AutoApprovalEngine({
      tierOverrides: { write_file: APPROVAL_TIERS.AUTO },
    });
    expect(engine.getTier("write_file")).toBe(APPROVAL_TIERS.AUTO);
    expect(engine.getTier("replace_in_file")).toBe(APPROVAL_TIERS.WRITE); // Unaffected
    expect(engine.getTier("execute_shell")).toBe(APPROVAL_TIERS.DANGER); // Unaffected
  });

  it("override for unknown tool takes precedence over default", () => {
    const engine = new AutoApprovalEngine({
      tierOverrides: { custom_tool: APPROVAL_TIERS.AUTO },
    });
    expect(engine.getTier("custom_tool")).toBe(APPROVAL_TIERS.AUTO);
  });
});

// ═══════════════════════════════════════════════════════════════
// getTierLabel()
// ═══════════════════════════════════════════════════════════════

describe("getTierLabel", () => {
  const engine = new AutoApprovalEngine();

  it('returns "auto" for Tier 1 tools', () => {
    expect(engine.getTierLabel("read_file")).toBe("auto");
  });

  it('returns "write" for Tier 2 tools', () => {
    expect(engine.getTierLabel("write_file")).toBe("write");
  });

  it('returns "danger" for Tier 3 tools', () => {
    expect(engine.getTierLabel("execute_shell")).toBe("danger");
  });

  it('returns "write" for unknown tools', () => {
    expect(engine.getTierLabel("unknown_tool")).toBe("write");
  });
});

// ═══════════════════════════════════════════════════════════════
// check() — Standard Mode (no fullAuto)
// ═══════════════════════════════════════════════════════════════

describe("check — standard mode", () => {
  const engine = new AutoApprovalEngine();

  it("auto-approves Tier 1 tools", () => {
    const result = engine.check({ name: "read_file", args: {}, id: "tc1" });
    expect(result.isApproved).toBe(true);
    expect(result.tier).toBe(APPROVAL_TIERS.AUTO);
    expect(result.tierLabel).toBe("auto");
    expect(result.reason).toBe("read_only");
  });

  it("requires approval for Tier 2 tools", () => {
    const result = engine.check({ name: "write_file", args: {}, id: "tc2" });
    expect(result.isApproved).toBe(false);
    expect(result.tier).toBe(APPROVAL_TIERS.WRITE);
    expect(result.tierLabel).toBe("write");
    expect(result.reason).toBe("requires_approval");
  });

  it("requires approval for Tier 3 tools", () => {
    const result = engine.check({ name: "execute_shell", args: {}, id: "tc3" });
    expect(result.isApproved).toBe(false);
    expect(result.tier).toBe(APPROVAL_TIERS.DANGER);
    expect(result.tierLabel).toBe("danger");
    expect(result.reason).toBe("requires_approval");
  });

  it("requires approval for unknown tools (default Tier 2)", () => {
    const result = engine.check({ name: "some_new_tool", args: {}, id: "tc4" });
    expect(result.isApproved).toBe(false);
    expect(result.tier).toBe(APPROVAL_TIERS.WRITE);
    expect(result.reason).toBe("requires_approval");
  });
});

// ═══════════════════════════════════════════════════════════════
// check() — Full Auto Mode
// ═══════════════════════════════════════════════════════════════

describe("check — full auto mode", () => {
  const engine = new AutoApprovalEngine({ fullAuto: true });

  it("auto-approves Tier 1 tools with full_auto reason", () => {
    const result = engine.check({ name: "read_file", args: {}, id: "tc1" });
    expect(result.isApproved).toBe(true);
    expect(result.reason).toBe("full_auto");
  });

  it("auto-approves Tier 2 tools with full_auto reason", () => {
    const result = engine.check({ name: "write_file", args: {}, id: "tc2" });
    expect(result.isApproved).toBe(true);
    expect(result.reason).toBe("full_auto");
  });

  it("auto-approves Tier 3 tools with full_auto reason", () => {
    const result = engine.check({ name: "execute_shell", args: {}, id: "tc3" });
    expect(result.isApproved).toBe(true);
    expect(result.reason).toBe("full_auto");
  });

  it("auto-approves unknown tools with full_auto reason", () => {
    const result = engine.check({ name: "unknown_tool", args: {}, id: "tc4" });
    expect(result.isApproved).toBe(true);
    expect(result.reason).toBe("full_auto");
  });
});

// ═══════════════════════════════════════════════════════════════
// checkBatch()
// ═══════════════════════════════════════════════════════════════

describe("checkBatch", () => {
  it("separates auto-approved from needs-approval", () => {
    const engine = new AutoApprovalEngine();
    const toolCalls = [
      { name: "read_file", args: { path: "test.js" }, id: "tc1" },
      { name: "write_file", args: { path: "out.js", content: "x" }, id: "tc2" },
      { name: "search_file_contents", args: { query: "TODO" }, id: "tc3" },
      { name: "execute_shell", args: { command: "ls" }, id: "tc4" },
    ];

    const { autoApproved, needsApproval } = engine.checkBatch(toolCalls);

    expect(autoApproved).toHaveLength(2);
    expect(needsApproval).toHaveLength(2);

    // Auto-approved should be the read-only tools
    expect(autoApproved.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read_file", "search_file_contents"]),
    );

    // Needs approval should be write + danger
    expect(needsApproval.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["write_file", "execute_shell"]),
    );
  });

  it("all auto-approved in full auto mode", () => {
    const engine = new AutoApprovalEngine({ fullAuto: true });
    const toolCalls = [
      { name: "read_file", args: {}, id: "tc1" },
      { name: "write_file", args: {}, id: "tc2" },
      { name: "execute_shell", args: {}, id: "tc3" },
    ];

    const { autoApproved, needsApproval } = engine.checkBatch(toolCalls);

    expect(autoApproved).toHaveLength(3);
    expect(needsApproval).toHaveLength(0);
  });

  it("attaches _approval metadata to each tool call", () => {
    const engine = new AutoApprovalEngine();
    const toolCalls = [
      { name: "read_file", args: {}, id: "tc1" },
      { name: "execute_shell", args: {}, id: "tc2" },
    ];

    const { autoApproved, needsApproval } = engine.checkBatch(toolCalls);

    expect(autoApproved[0]._approval).toEqual({
      isApproved: true,
      tier: APPROVAL_TIERS.AUTO,
      tierLabel: "auto",
      reason: "read_only",
    });

    expect(needsApproval[0]._approval).toEqual({
      isApproved: false,
      tier: APPROVAL_TIERS.DANGER,
      tierLabel: "danger",
      reason: "requires_approval",
    });
  });

  it("handles empty batch", () => {
    const engine = new AutoApprovalEngine();
    const { autoApproved, needsApproval } = engine.checkBatch([]);

    expect(autoApproved).toHaveLength(0);
    expect(needsApproval).toHaveLength(0);
  });

  it("handles batch with all read-only tools", () => {
    const engine = new AutoApprovalEngine();
    const toolCalls = [
      { name: "read_file", args: {}, id: "tc1" },
      { name: "list_directory", args: {}, id: "tc2" },
      { name: "search_file_contents", args: {}, id: "tc3" },
    ];

    const { autoApproved, needsApproval } = engine.checkBatch(toolCalls);

    expect(autoApproved).toHaveLength(3);
    expect(needsApproval).toHaveLength(0);
  });

  it("handles batch with all dangerous tools", () => {
    const engine = new AutoApprovalEngine();
    const toolCalls = [
      { name: "execute_shell", args: {}, id: "tc1" },
      { name: "execute_python", args: {}, id: "tc2" },
      { name: "execute_command", args: {}, id: "tc3" },
    ];

    const { autoApproved, needsApproval } = engine.checkBatch(toolCalls);

    expect(autoApproved).toHaveLength(0);
    expect(needsApproval).toHaveLength(3);
  });

  it("preserves original tool call properties", () => {
    const engine = new AutoApprovalEngine();
    const toolCalls = [
      { name: "read_file", args: { path: "/foo/bar.js" }, id: "toolCall-abc-123" },
    ];

    const { autoApproved } = engine.checkBatch(toolCalls);

    expect(autoApproved[0].name).toBe("read_file");
    expect(autoApproved[0].args).toEqual({ path: "/foo/bar.js" });
    expect(autoApproved[0].id).toBe("toolCall-abc-123");
  });
});

// ═══════════════════════════════════════════════════════════════
// createHook()
// ═══════════════════════════════════════════════════════════════

describe("createHook", () => {
  it("returns a function", () => {
    const engine = new AutoApprovalEngine();
    const hook = engine.createHook();
    expect(typeof hook).toBe("function");
  });

  it("hook returns check result for auto-approved tool", async () => {
    const engine = new AutoApprovalEngine();
    const hook = engine.createHook();

    const result = await hook({ name: "read_file", args: {}, id: "tc1" }, {} as any);

    expect(result.isApproved).toBe(true);
    expect(result.tier).toBe(APPROVAL_TIERS.AUTO);
  });

  it("hook returns check result for requiring-approval tool", async () => {
    const engine = new AutoApprovalEngine();
    const hook = engine.createHook();

    const result = await hook({ name: "execute_shell", args: {}, id: "tc2" }, {} as any);

    expect(result.isApproved).toBe(false);
    expect(result.tier).toBe(APPROVAL_TIERS.DANGER);
  });

  it("hook respects fullAuto mode set on engine", async () => {
    const engine = new AutoApprovalEngine({ fullAuto: true });
    const hook = engine.createHook();

    const result = await hook({ name: "execute_shell", args: {}, id: "tc3" }, {} as any);

    expect(result.isApproved).toBe(true);
    expect(result.reason).toBe("full_auto");
  });
});

// ═══════════════════════════════════════════════════════════════
// Constructor Defaults
// ═══════════════════════════════════════════════════════════════

describe("Constructor defaults", () => {
  it("fullAuto defaults to false", () => {
    const engine = new AutoApprovalEngine();
    expect((engine as any).fullAuto).toBe(false);
  });

  it("tierOverrides defaults to empty object", () => {
    const engine = new AutoApprovalEngine();
    expect((engine as any).tierOverrides).toEqual({});
  });

  it("accepts empty options object", () => {
    const engine = new AutoApprovalEngine({});
    expect((engine as any).fullAuto).toBe(false);
    expect((engine as any).tierOverrides).toEqual({});
  });

  it("accepts no arguments", () => {
    const engine = new AutoApprovalEngine();
    expect(engine).toBeInstanceOf(AutoApprovalEngine);
  });
});

// ═══════════════════════════════════════════════════════════════
// Policy Integration — PolicyEngine + AutoApprovalEngine
// ═══════════════════════════════════════════════════════════════

describe("check — policy integration", () => {
  it("DENY policy blocks a Tier 1 (auto) tool", () => {
    const engine = new AutoApprovalEngine({
      policies: [
        { tool: "read_file", decision: "DENY", name: "deny-read" },
      ],
    });
    const result = engine.check({ name: "read_file", args: {}, id: "tc1" });
    expect(result.isApproved).toBe(false);
    expect(result.reason).toContain("Denied by policy");
  });

  it("APPROVE policy allows a Tier 3 (danger) tool", () => {
    const engine = new AutoApprovalEngine({
      policies: [
        { tool: "execute_shell", decision: "APPROVE", name: "allow-shell" },
      ],
    });
    const result = engine.check({ name: "execute_shell", args: {}, id: "tc2" });
    expect(result.isApproved).toBe(true);
    expect(result.reason).toContain("Approved by policy");
  });

  it("ASK_USER policy overrides Tier 1 auto-approve", () => {
    const engine = new AutoApprovalEngine({
      policies: [
        { tool: "read_file", decision: "ASK_USER", name: "ask-read" },
      ],
    });
    const result = engine.check({ name: "read_file", args: {}, id: "tc3" });
    expect(result.isApproved).toBe(false);
    expect(result.reason).toContain("Requires approval");
  });

  it("conditional policy with matching predicate", () => {
    const engine = new AutoApprovalEngine({
      policies: [
        {
          tool: "execute_shell",
          decision: "DENY",
          name: "deny-rm",
          when: (args: Record<string, unknown>) =>
            /rm\s+-rf/.test(String(args.command)),
        },
        {
          tool: "execute_shell",
          decision: "APPROVE",
          name: "allow-git",
          when: (args: Record<string, unknown>) =>
            /^git\s/.test(String(args.command)),
        },
      ],
    });

    // rm -rf should be denied
    const rm = engine.check({
      name: "execute_shell",
      args: { command: "rm -rf /" },
      id: "tc4",
    });
    expect(rm.isApproved).toBe(false);
    expect(rm.reason).toContain("deny-rm");

    // git should be allowed
    const git = engine.check({
      name: "execute_shell",
      args: { command: "git status" },
      id: "tc5",
    });
    expect(git.isApproved).toBe(true);
    expect(git.reason).toContain("allow-git");
  });

  it("no matching policy falls through to tier system", () => {
    const engine = new AutoApprovalEngine({
      policies: [
        { tool: "execute_shell", decision: "DENY", name: "deny-shell" },
      ],
    });

    // read_file has no matching policy — should fall through to Tier 1 auto-approve
    const result = engine.check({ name: "read_file", args: {}, id: "tc6" });
    expect(result.isApproved).toBe(true);
    expect(result.reason).toBe("read_only");
  });

  it("full auto mode takes precedence over policies", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      policies: [
        { tool: "execute_shell", decision: "DENY", name: "deny-shell" },
      ],
    });
    const result = engine.check({ name: "execute_shell", args: {}, id: "tc7" });
    // fullAuto short-circuits before policy evaluation
    expect(result.isApproved).toBe(true);
    expect(result.reason).toBe("full_auto");
  });

  it("wildcard policy catches all unmatched tools", () => {
    const engine = new AutoApprovalEngine({
      policies: [
        { tool: "*", decision: "ASK_USER", name: "ask-all" },
      ],
    });

    // Even Tier 1 tools should be caught by the wildcard
    const read = engine.check({ name: "read_file", args: {}, id: "tc8" });
    expect(read.isApproved).toBe(false);
    expect(read.reason).toContain("ask-all");

    const write = engine.check({ name: "write_file", args: {}, id: "tc9" });
    expect(write.isApproved).toBe(false);

    const shell = engine.check({ name: "execute_shell", args: {}, id: "tc10" });
    expect(shell.isApproved).toBe(false);
  });

  it("policies work with checkBatch()", () => {
    const engine = new AutoApprovalEngine({
      policies: [
        { tool: "execute_shell", decision: "APPROVE", name: "allow-shell" },
        { tool: "write_file", decision: "DENY", name: "deny-write" },
      ],
    });

    const toolCalls = [
      { name: "read_file", args: {}, id: "tc1" },      // Tier 1 auto
      { name: "execute_shell", args: {}, id: "tc2" },   // Policy APPROVE
      { name: "write_file", args: {}, id: "tc3" },       // Policy DENY
    ];

    const { autoApproved, needsApproval } = engine.checkBatch(toolCalls);
    expect(autoApproved).toHaveLength(2);
    expect(autoApproved.map(tool => tool.name)).toEqual(
      expect.arrayContaining(["read_file", "execute_shell"]),
    );
    expect(needsApproval).toHaveLength(1);
    expect(needsApproval[0].name).toBe("write_file");
  });
});

// ── Adversarial Tests (merged from adversarial-qa-flows.test.ts) ──

describe('AutoApprovalEngine adversarial', () => {
  it('should default unknown tools to Tier 2 (WRITE) — not auto-approved', () => {
    const engine = new AutoApprovalEngine();
    const result = engine.check({ name: 'completely_unknown_tool', args: {}, id: 'tc-1' });
    expect(result.isApproved).toBe(false);
    expect(result.tier).toBe(APPROVAL_TIERS.WRITE);
    expect(result.tierLabel).toBe('write');
  });

  it('should auto-approve all tools in fullAuto mode — including DANGER tier', () => {
    const engine = new AutoApprovalEngine({ fullAuto: true });
    const result = engine.check({ name: 'execute_shell', args: { command: 'rm -rf /' }, id: 'tc-1' });
    expect(result.isApproved).toBe(true);
    expect(result.reason).toBe('full_auto');
  });

  it('should allow tier override to promote a DANGER tool to AUTO', () => {
    const engine = new AutoApprovalEngine({
      tierOverrides: { execute_shell: APPROVAL_TIERS.AUTO },
    });
    const result = engine.check({ name: 'execute_shell', args: {}, id: 'tc-1' });
    expect(result.isApproved).toBe(true);
    expect(result.tier).toBe(APPROVAL_TIERS.AUTO);
  });

  it('should allow tier override to demote a read-only tool to DANGER', () => {
    const engine = new AutoApprovalEngine({
      tierOverrides: { read_file: APPROVAL_TIERS.DANGER },
    });
    const result = engine.check({ name: 'read_file', args: {}, id: 'tc-1' });
    expect(result.isApproved).toBe(false);
    expect(result.tier).toBe(APPROVAL_TIERS.DANGER);
  });

  it('should prioritize policy DENY over fullAuto — policies evaluated only when NOT fullAuto', () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      policies: [deny('execute_shell')],
    });
    const result = engine.check({ name: 'execute_shell', args: {}, id: 'tc-1' });
    // fullAuto returns immediately — policies are not checked
    expect(result.isApproved).toBe(true);
    expect(result.reason).toBe('full_auto');
  });

  it('should apply policy DENY before tier system when NOT fullAuto', () => {
    const engine = new AutoApprovalEngine({
      policies: [deny('read_file')],
    });
    const result = engine.check({ name: 'read_file', args: {}, id: 'tc-1' });
    // Policy denies it even though read_file is Tier 1 AUTO
    expect(result.isApproved).toBe(false);
    expect(result.reason).toContain('Denied by policy');
  });

  it('should apply policy APPROVE for a normally-blocked WRITE tool', () => {
    const engine = new AutoApprovalEngine({
      policies: [allow('write_file')],
    });
    const result = engine.check({ name: 'write_file', args: {}, id: 'tc-1' });
    expect(result.isApproved).toBe(true);
    expect(result.reason).toContain('Approved by policy');
  });

  it('should split batch correctly between auto-approved and needs-approval', () => {
    const engine = new AutoApprovalEngine();
    const { autoApproved, needsApproval } = engine.checkBatch([
      { name: 'read_file', args: {}, id: 'tc-1' },
      { name: 'write_file', args: {}, id: 'tc-2' },
      { name: 'execute_shell', args: {}, id: 'tc-3' },
      { name: 'list_directory', args: {}, id: 'tc-4' },
    ]);
    expect(autoApproved.length).toBe(2); // read_file + list_directory
    expect(needsApproval.length).toBe(2); // write_file + execute_shell
  });

  it('should handle empty toolCalls batch — no crash', () => {
    const engine = new AutoApprovalEngine();
    const { autoApproved, needsApproval } = engine.checkBatch([]);
    expect(autoApproved).toEqual([]);
    expect(needsApproval).toEqual([]);
  });

  it('should handle tool with empty string name — defaults to WRITE tier', () => {
    const engine = new AutoApprovalEngine();
    const result = engine.check({ name: '', args: {}, id: 'tc-1' });
    expect(result.tier).toBe(APPROVAL_TIERS.WRITE);
  });

  it('should handle policy with conditional when predicate', () => {
    const engine = new AutoApprovalEngine({
      policies: [
        deny('execute_shell', {
          when: (args) => /rm\s+-rf/.test(String(args.command)),
        }),
        allow('execute_shell'),
      ],
    });
    const safeResult = engine.check({
      name: 'execute_shell',
      args: { command: 'git status' },
      id: 'tc-1',
    });
    expect(safeResult.isApproved).toBe(true);

    const dangerousResult = engine.check({
      name: 'execute_shell',
      args: { command: 'rm -rf /' },
      id: 'tc-2',
    });
    expect(dangerousResult.isApproved).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 6. ApprovalRegistry — Dangling Promise & Double-Resolve
// ────────────────────────────────────────────────────────────────

// ── ApprovalRegistry Adversarial Tests (merged from adversarial-qa-flows.test.ts) ──

describe('ApprovalRegistry adversarial', () => {
  afterEach(() => {
    pendingApprovals.clear();
    pendingQuestions.clear();
  });

  it('should handle double-resolve of approval — second call is no-op', async () => {
    let resolveCount = 0;
    const approvalPromise = new Promise<ApprovalResolution>((resolve) => {
      pendingApprovals.set('conv-1', {
        resolve: (value: ApprovalResolution) => {
          resolveCount++;
          resolve(value);
        },
        type: 'tool',
        tools: ['execute_shell'],
        toolCalls: [{ id: 'tc-1', name: 'execute_shell', args: {} }],
      });
    });

    const entry = pendingApprovals.get('conv-1')! as PendingToolApprovalEntry;
    entry.resolve({ isApproved: true });
    entry.resolve({ isApproved: false }); // Double resolve

    const result = await approvalPromise;
    expect(result.isApproved).toBe(true);
    // The promise resolved with the first value; second is ignored by Promise semantics
    expect(resolveCount).toBe(2); // Both calls execute but only first matters
  });

  it('should handle approval for non-existent conversationId — map.get returns undefined', () => {
    const entry = pendingApprovals.get('nonexistent-conv');
    expect(entry).toBeUndefined();
  });

  it('should handle concurrent approvals for different conversations', () => {
    const results: Array<{ conversationId: string; isApproved: boolean }> = [];

    pendingApprovals.set('conv-a', {
      resolve: (value: ApprovalResolution) => results.push({ conversationId: 'conv-a', ...value }),
      type: 'tool',
      tools: ['tool1'],
      toolCalls: [],
    });

    pendingApprovals.set('conv-b', {
      resolve: (value: ApprovalResolution) => results.push({ conversationId: 'conv-b', ...value }),
      type: 'tool',
      tools: ['tool2'],
      toolCalls: [],
    });

    // Resolve in reverse order
    const entryB = pendingApprovals.get('conv-b')! as PendingToolApprovalEntry;
    const entryA = pendingApprovals.get('conv-a')! as PendingToolApprovalEntry;
    entryB.resolve({ isApproved: false });
    entryA.resolve({ isApproved: true });

    expect(results.length).toBe(2);
    expect(results[0].conversationId).toBe('conv-b');
    expect(results[1].conversationId).toBe('conv-a');
  });

  it('should handle question resolution with null answers', () => {
    let receivedResolution: QuestionResolution | null = null;
    pendingQuestions.set('conv-q', {
      resolve: (value: QuestionResolution) => {
        receivedResolution = value;
      },
      question: 'What color?',
    });

    pendingQuestions.get('conv-q')!.resolve({ answers: null });
    expect(receivedResolution).not.toBeNull();
    expect(receivedResolution!.answers).toBeNull();
  });

  it('should clean up stale entries — Map.delete removes dangling resolvers', () => {
    pendingApprovals.set('stale-conv', {
      resolve: () => {},
      type: 'plan',
    } as unknown as import('../ApprovalRegistry.ts').PendingToolApprovalEntry);

    expect(pendingApprovals.has('stale-conv')).toBe(true);
    pendingApprovals.delete('stale-conv');
    expect(pendingApprovals.has('stale-conv')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 7. RateLimitStore — Key Injection & Cache Poisoning
// ────────────────────────────────────────────────────────────────

