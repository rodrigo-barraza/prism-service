import { describe, it, expect, vi, beforeEach } from "vitest";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import { deny as policyDeny, allow as policyAllow } from "#src/services/PolicyEngine";
import PermissionRuleSet from "../PermissionRuleSet.ts";
import { compileRule } from "../PermissionEvaluator.ts";
import {
  registerToolCapabilities,
  resetToolCapabilities,
  resolveToolCapabilities,
  capabilitiesFromMcpAnnotations,
} from "../ToolCapabilities.ts";
import type { PermissionDecision, PermissionScope } from "../types.ts";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

interface RuleSpec {
  rule: string;
  decision: PermissionDecision;
  scope?: PermissionScope;
  project?: string;
  agent?: string | null;
  conversationId?: string | null;
  enabled?: boolean;
  createdAt?: string;
}

let counter = 0;
function rules(...specs: RuleSpec[]) {
  return specs.map((spec) =>
    compileRule({
      id: `r${++counter}`,
      scope: "profile",
      project: "prism-client",
      agent: null,
      conversationId: null,
      ...spec,
    }),
  );
}

function ruleSet(specs: RuleSpec[], context: Partial<{ project: string; agent: string | null; conversationIds: string[] }> = {}) {
  return new PermissionRuleSet(
    { username: "rodrigo", profileId: "default" },
    {
      project: "prism-client",
      agent: null,
      conversationIds: ["conv-1"],
      workspaceRoot: "/ws",
      ...context,
    },
    rules(...specs),
  );
}

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c", name, args });

describe("precedence: deny > ask > allow, whatever the scope", () => {
  it("a profile-wide deny beats a conversation allow", () => {
    const set = ruleSet([
      { rule: "execute_shell(rm *)", decision: "deny", scope: "profile" },
      { rule: "execute_shell", decision: "allow", scope: "conversation", conversationId: "conv-1" },
    ]);
    const verdict = set.evaluate({ name: "execute_shell", args: { command: "rm -rf build" } }, ["shell"]);
    expect(verdict).toMatchObject({ decision: "deny", layer: "rules", rule: "execute_shell(rm *)", scope: "profile" });
  });

  it("ask beats allow", () => {
    const set = ruleSet([
      { rule: "write_file", decision: "allow" },
      { rule: "write_file(**/*.lock)", decision: "ask" },
    ]);
    expect(set.evaluate({ name: "write_file", args: { path: "pnpm.lock" } }, ["fs_write"])?.decision).toBe("ask");
    expect(set.evaluate({ name: "write_file", args: { path: "a.ts" } }, ["fs_write"])?.decision).toBe("allow");
  });

  it("among equal decisions, the most specific scope names the verdict", () => {
    const set = ruleSet([
      { rule: "capability:network", decision: "deny", scope: "profile" },
      { rule: "read_web_page", decision: "deny", scope: "project" },
      { rule: "read_web_page(https://*)", decision: "deny", scope: "conversation", conversationId: "conv-1" },
    ]);
    const evaluation = set.explain({ name: "read_web_page", args: { url: "https://x.dev" } }, ["network"]);
    expect(evaluation.verdict).toMatchObject({ rule: "read_web_page(https://*)", scope: "conversation" });
    expect(evaluation.matched.map((rule) => rule.scope)).toEqual(["conversation", "project", "profile"]);
  });
});

describe("scope applicability", () => {
  it("a project rule applies only in its project", () => {
    const specs: RuleSpec[] = [{ rule: "read_file", decision: "deny", scope: "project", project: "other" }];
    expect(ruleSet(specs).evaluate({ name: "read_file", args: {} }, [])).toBeNull();
    expect(ruleSet(specs, { project: "other" }).evaluate({ name: "read_file", args: {} }, [])?.decision).toBe("deny");
  });

  it("a conversation rule applies only in that conversation — and in its sub-agents", () => {
    const specs: RuleSpec[] = [{ rule: "read_file", decision: "deny", scope: "conversation", conversationId: "conv-1" }];
    expect(ruleSet(specs, { conversationIds: ["conv-2"] }).evaluate({ name: "read_file", args: {} }, [])).toBeNull();

    const parent = ruleSet(specs);
    const child = parent.forSubAgent({ agent: "RESEARCHER", conversationId: "sub-9" });
    expect(child.context.conversationIds).toEqual(["conv-1", "sub-9"]);
    expect(child.evaluate({ name: "read_file", args: {} }, [])?.decision).toBe("deny");
  });

  it("an agent-specific rule applies only to that agent, case-insensitively", () => {
    const specs: RuleSpec[] = [{ rule: "execute_shell", decision: "deny", agent: "coding" }];
    expect(ruleSet(specs).evaluate({ name: "execute_shell", args: {} }, [])).toBeNull();
    expect(ruleSet(specs, { agent: "CODING" }).evaluate({ name: "execute_shell", args: {} }, [])?.decision).toBe("deny");
  });

  it("a disabled rule does nothing", () => {
    expect(ruleSet([{ rule: "read_file", decision: "deny", enabled: false }]).evaluate({ name: "read_file", args: {} }, [])).toBeNull();
  });
});

describe("AutoApprovalEngine names the deciding layer", () => {
  beforeEach(() => resetToolCapabilities());

  it("rules and agent policies combine: a deny from either wins, and names its layer", () => {
    const userDeniesPersonaAllows = new AutoApprovalEngine({
      policies: [policyAllow("execute_shell")],
      permissionRules: ruleSet([{ rule: "execute_shell", decision: "deny" }]),
    });
    expect(userDeniesPersonaAllows.check(call("execute_shell", { command: "ls" }))).toMatchObject({
      isDenied: true,
      layer: "rules",
      rule: "execute_shell",
      ruleScope: "profile",
    });

    const personaDeniesUserAllows = new AutoApprovalEngine({
      policies: [policyDeny("execute_shell", { name: "no-shell" })],
      permissionRules: ruleSet([{ rule: "execute_shell", decision: "allow" }]),
    });
    expect(personaDeniesUserAllows.check(call("execute_shell", { command: "ls" }))).toMatchObject({
      isDenied: true,
      layer: "agent_policy",
      rule: "no-shell",
    });
  });

  it("an allow rule auto-approves a WRITE-tier call and says so", () => {
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet([{ rule: "write_file(src/**)", decision: "allow" }]),
    });
    const result = engine.check(call("write_file", { path: "src/a.ts" }));
    expect(result).toMatchObject({ isApproved: true, layer: "rules" });
    expect(result.reason).toContain("write_file(src/**)");
    // Outside the pattern the tier decides again.
    expect(engine.check(call("write_file", { path: "README.md" }))).toMatchObject({ isApproved: false, layer: "tier" });
  });

  it("full auto answers an ask with yes, but never a deny", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      permissionRules: ruleSet([
        { rule: "write_file", decision: "ask" },
        { rule: "delete_file", decision: "deny" },
      ]),
    });
    expect(engine.check(call("write_file", { path: "a" }))).toMatchObject({ isApproved: true, layer: "full_auto" });
    expect(engine.check(call("delete_file", { path: "a" }))).toMatchObject({ isDenied: true, layer: "rules" });
  });

  it("the tier decides when nothing matched", () => {
    const engine = new AutoApprovalEngine({ permissionRules: ruleSet([]) });
    expect(engine.check(call("read_file", {}))).toMatchObject({ isApproved: true, layer: "tier", reason: "read_only" });
    expect(engine.check(call("execute_shell", {}))).toMatchObject({ isApproved: false, layer: "tier" });
  });

  it("explain() lists every matched rule for the tester", () => {
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet([
        { rule: "capability:shell", decision: "ask" },
        { rule: "execute_shell(git *)", decision: "allow" },
      ]),
    });
    const explanation = engine.explain(call("execute_shell", { command: "git log" }));
    expect(explanation.capabilities).toContain("shell");
    expect(explanation.matchedRules.map((rule) => rule.rule)).toEqual(["capability:shell", "execute_shell(git *)"]);
    expect(explanation).toMatchObject({ isApproved: false, layer: "rules", rule: "capability:shell" });
  });

  it("capability rules see declared tags", () => {
    registerToolCapabilities([{ name: "send_email", capabilities: ["network", "external_side_effect"] }], "test");
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet([{ rule: "capability:external_side_effect", decision: "deny" }]),
    });
    expect(engine.check(call("send_email", {}))).toMatchObject({ isDenied: true, rule: "capability:external_side_effect" });
    expect(engine.check(call("read_file", {}))).toMatchObject({ isApproved: true });
  });
});

describe("configured PreToolUse hooks meet the permission stack", () => {
  // hooks → rules → mode → ask: the hook ran first and stamped its verdict.
  const hooked = (
    name: string,
    args: Record<string, unknown>,
    decision: "allow" | "ask",
    reason?: string,
  ) => ({ ...call(name, args), _hookPermission: { decision, ...(reason && { reason }) } });

  it("a rule deny is final — a hook allow does not relax it", () => {
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet([{ rule: "execute_shell(rm *)", decision: "deny" }]),
    });
    expect(engine.check(hooked("execute_shell", { command: "rm -rf build" }, "allow"))).toMatchObject({
      isApproved: false,
      isDenied: true,
      deniedBy: "rule",
      layer: "rules",
    });
  });

  it("self-protection holds against a hook allow", () => {
    const engine = new AutoApprovalEngine({ fullAuto: true });
    const result = engine.check(
      hooked("execute_shell", { command: "curl -X DELETE http://localhost:7777/permissions/rules/abc" }, "allow"),
    );
    expect(result).toMatchObject({ isDenied: true, deniedBy: "rule", layer: "self_protection" });
  });

  it("a hook ask beats a rule allow", () => {
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet([{ rule: "write_file", decision: "allow" }]),
    });
    expect(engine.check(hooked("write_file", { path: "a.ts" }, "ask", "review writes"))).toMatchObject({
      isApproved: false,
      reason: "hook_ask: review writes",
      layer: "hook",
    });
  });

  it("a rule ask still asks when a hook allowed", () => {
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet([{ rule: "write_file(**/*.lock)", decision: "ask" }]),
    });
    expect(engine.check(hooked("write_file", { path: "pnpm.lock" }, "allow"))).toMatchObject({
      isApproved: false,
      layer: "rules",
    });
  });

  it("full auto answers a rule ask — unless a hook asked too", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      permissionRules: ruleSet([{ rule: "write_file(**/*.lock)", decision: "ask" }]),
    });
    expect(engine.check(call("write_file", { path: "pnpm.lock" }))).toMatchObject({ isApproved: true, layer: "full_auto" });
    expect(engine.check(hooked("write_file", { path: "pnpm.lock" }, "ask"))).toMatchObject({
      isApproved: false,
      layer: "rules",
    });
  });

  it("with no rule, a hook allow stands in for the tier prompt and a hook ask asks even at the AUTO tier", () => {
    const engine = new AutoApprovalEngine({ permissionRules: ruleSet([]) });
    expect(engine.check(hooked("write_file", { path: "a.ts" }, "allow"))).toMatchObject({
      isApproved: true,
      reason: "hook_allow",
      layer: "hook",
    });
    expect(engine.check(hooked("read_file", { path: "a.ts" }, "ask"))).toMatchObject({
      isApproved: false,
      reason: "hook_ask",
      layer: "hook",
    });
  });
});

describe("capability resolution", () => {
  beforeEach(() => resetToolCapabilities());

  it("declared tags win; built-ins cover core tools; the unknown is assumed to have side effects", () => {
    expect(resolveToolCapabilities("read_file")).toEqual(["fs_read"]);
    expect(resolveToolCapabilities("create_subagent")).toEqual(["subagent"]);
    expect(resolveToolCapabilities("some_new_tool")).toEqual(["external_side_effect"]);
    registerToolCapabilities([{ name: "some_new_tool", capabilities: ["network", "bogus"] }], "test");
    expect(resolveToolCapabilities("some_new_tool")).toEqual(["network"]);
    // A schema without the field stays undeclared rather than becoming "none".
    registerToolCapabilities([{ name: "read_file" }], "test");
    expect(resolveToolCapabilities("read_file")).toEqual(["fs_read"]);
  });

  it("maps MCP annotations, spec defaults included", () => {
    expect(capabilitiesFromMcpAnnotations(undefined)).toEqual(["mcp", "external_side_effect", "network"]);
    expect(capabilitiesFromMcpAnnotations({ readOnlyHint: true, openWorldHint: false })).toEqual(["mcp", "fs_read"]);
    expect(capabilitiesFromMcpAnnotations({ destructiveHint: true })).toEqual(["mcp", "external_side_effect", "network"]);
    expect(resolveToolCapabilities("mcp__unregistered__tool")).toEqual(["mcp", "network", "external_side_effect"]);
  });
});
