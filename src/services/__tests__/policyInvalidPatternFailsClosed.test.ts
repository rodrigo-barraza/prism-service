/**
 * An invalid pattern fails CLOSED — for custom-agent policies and for stored
 * permission rules alike: it matches nothing when it allows, and every call
 * it could cover when it asks or denies.
 *
 * Red on master: `AgentPersonaRegistry.registerCustom` caught the RegExp
 * error and simply dropped the `when` predicate, so an APPROVE policy whose
 * pattern had a typo approved EVERY call of its tool — `rm -rf ~` included.
 * (A DENY with a typo already failed closed by the same accident; it is
 * pinned here so it stays that way.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import PermissionRuleSet from "#src/services/permissions/PermissionRuleSet";
import { compileRule } from "#src/services/permissions/PermissionEvaluator";
import type { ToolCall } from "#src/services/harnesses/types";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const shell = (command: string): ToolCall => ({
  id: "call-1",
  name: "execute_shell",
  args: { command },
});

function personaPolicies(policies: Array<Record<string, unknown>>) {
  AgentPersonaRegistry.registerCustom({
    agentId: "FAIL_CLOSED_AGENT",
    name: "Fail Closed",
    policies,
  });
  return AgentPersonaRegistry.get("FAIL_CLOSED_AGENT")!.policies!;
}

describe("custom-agent policy with an invalid regex", () => {
  beforeEach(() => AgentPersonaRegistry.unregister("FAIL_CLOSED_AGENT"));

  it("an APPROVE whose pattern cannot compile approves nothing", () => {
    const policies = personaPolicies([
      { tool: "execute_shell", decision: "APPROVE", pattern: "^git (status" },
    ]);
    const engine = new AutoApprovalEngine({ policies });

    const result = engine.check(shell("rm -rf ~"));

    expect(result.isApproved).toBe(false);
    expect(result.isDenied).toBeFalsy();
    // Nothing matched, so the tier decided: execute_shell is DANGER → ask.
    expect(result.reason).toBe("requires_approval");
  });

  it("a DENY whose pattern cannot compile denies every call of its tool", () => {
    const policies = personaPolicies([
      { tool: "execute_shell", decision: "DENY", pattern: "rm -rf (" },
      { tool: "execute_shell", decision: "APPROVE" },
    ]);
    const engine = new AutoApprovalEngine({ policies, fullAuto: true });

    const result = engine.check(shell("ls"));

    expect(result.isApproved).toBe(false);
    expect(result.isDenied).toBe(true);
    expect(result.layer).toBe("agent_policy");
  });
});

describe("stored permission rule with an invalid regex", () => {
  const ruleSet = (rules: Array<{ rule: string; decision: "allow" | "ask" | "deny" }>) =>
    new PermissionRuleSet(
      { username: "u", profileId: "default" },
      { project: "p", agent: null, conversationIds: ["c"], workspaceRoot: "/ws" },
      rules.map((rule, index) =>
        compileRule({
          id: `rule-${index}`,
          project: "p",
          agent: null,
          conversationId: null,
          scope: "profile",
          ...rule,
        }),
      ),
    );

  it("a DENY rule denies — even in full auto, even beside an allow", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      permissionRules: ruleSet([
        { rule: "execute_shell(/rm -rf (/)", decision: "deny" },
        { rule: "execute_shell", decision: "allow" },
      ]),
    });

    const result = engine.check(shell("git status"));

    expect(result.isDenied).toBe(true);
    expect(result.layer).toBe("rules");
    expect(result.rule).toBe("execute_shell(/rm -rf (/)");
  });

  it("an ALLOW rule allows nothing", () => {
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet([{ rule: "execute_shell(/git (status/)", decision: "allow" }]),
    });

    const result = engine.check(shell("git status"));

    expect(result.isApproved).toBe(false);
    expect(result.layer).toBe("tier");
  });

  it("an ASK rule asks — for every call of its tool", () => {
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet([
        { rule: "read_file(path=/[/)", decision: "ask" },
      ]),
    });

    const result = engine.check({ id: "r", name: "read_file", args: { absolutePath: "/ws/a.ts" } });

    expect(result.isApproved).toBe(false);
    expect(result.layer).toBe("rules");
  });

  it("a rule whose text does not parse at all fails closed the same way", () => {
    const deny = new AutoApprovalEngine({
      permissionRules: ruleSet([{ rule: "execute shell(rm)", decision: "deny" }]),
    });
    const allow = new AutoApprovalEngine({
      permissionRules: ruleSet([{ rule: "execute shell(ls)", decision: "allow" }]),
    });

    expect(deny.check(shell("ls")).isDenied).toBe(true);
    expect(allow.check(shell("ls")).isApproved).toBe(false);
  });
});
