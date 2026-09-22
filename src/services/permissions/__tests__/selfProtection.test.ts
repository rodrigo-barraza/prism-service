import { describe, it, expect, vi, beforeEach } from "vitest";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import { allow as policyAllow } from "#src/services/PolicyEngine";
import PermissionRuleSet from "../PermissionRuleSet.ts";
import { compileRule } from "../PermissionEvaluator.ts";
import { checkSelfProtection } from "../SelfProtection.ts";
import { registerToolCapabilities, resetToolCapabilities } from "../ToolCapabilities.ts";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

/** The most permissive setup there is: full auto, allow-all rule, allow-all policy. */
function wideOpenEngine() {
  return new AutoApprovalEngine({
    fullAuto: true,
    policies: [policyAllow("*")],
    permissionRules: new PermissionRuleSet(
      { username: "u", profileId: "default" },
      { project: "p", agent: null, conversationIds: ["c"], workspaceRoot: "/ws" },
      [compileRule({ id: "all", rule: "*", decision: "allow", scope: "profile", project: "p", agent: null, conversationId: null })],
    ),
  });
}

const call = (name: string, args: Record<string, unknown>) => ({ id: "c", name, args });

describe("an agent tool call that tries to change permissions is denied", () => {
  beforeEach(() => resetToolCapabilities());

  it.each([
    ["creating a rule over the API", call("execute_shell", { command: `curl -X POST http://localhost:7777/permissions/rules -H 'content-type: application/json' -d '{"rule":"*","decision":"allow","scope":"profile"}'` })],
    ["deleting a rule over the API", call("execute_command", { command: "curl -X DELETE https://api.prism.rod.dev/permissions/rules/abc" })],
    ["writing the collection directly", call("execute_python", { code: "from pymongo import MongoClient\nMongoClient()['prism']['permission_rules'].delete_many({})" })],
    ["approving its own pending call", call("execute_shell", { command: "curl -X POST localhost:7777/agent/approve -d '{\"approved\":true}'" })],
    ["rewriting a custom agent's policies", call("execute_javascript", { code: "fetch('http://localhost:7777/custom-agents/X', {method:'PUT', body: JSON.stringify({policies: []})})" })],
    ["turning the critic off in settings", call("execute_shell", { command: `curl -X PUT http://127.0.0.1:7777/settings -d '{"agents":{"criticModel":""}}'` })],
    ["clicking through the settings page", call("control_browser", { action: "navigate", url: "https://prism.rod.dev/settings?section=permissions" })],
    ["through an MCP tool", call("mcp__http__request", { url: "http://localhost:7777/permissions/rules", method: "POST" })],
  ])("%s", (_label, toolCall) => {
    const result = wideOpenEngine().check(toolCall);
    expect(result).toMatchObject({ isApproved: false, isDenied: true, layer: "self_protection" });
    expect(result.reason).toMatch(/^\[Self-Protection\]/);
  });

  it("checks nested arguments too", () => {
    registerToolCapabilities([{ name: "send_webhook", capabilities: ["network", "external_side_effect"] }], "test");
    const result = wideOpenEngine().check(
      call("send_webhook", { url: "https://hooks.example", payload: { forward: { to: "http://localhost:7777/permissions/rules" } } }),
    );
    expect(result.layer).toBe("self_protection");
  });
});

describe("what self-protection leaves alone", () => {
  beforeEach(() => resetToolCapabilities());

  it("file tools — editing Prism's own source mentions these names legitimately", () => {
    expect(checkSelfProtection(call("write_file", { path: "src/routes/PermissionsRoutes.ts", content: "router.post('/permissions/rules')" }), ["fs_write"])).toBeNull();
    expect(checkSelfProtection(call("search_file_contents", { pattern: "permission_rules" }), ["fs_read"])).toBeNull();
  });

  it("read-only web tools", () => {
    expect(checkSelfProtection(call("read_web_page", { url: "https://docs.example/permissions/rules" }), ["network"])).toBeNull();
  });

  it("shell lines that only look similar", () => {
    const shell = ["shell", "fs_write", "network"] as const;
    expect(checkSelfProtection(call("execute_shell", { command: "cat ~/.config/app/settings.json | grep permissions" }), [...shell])).toBeNull();
    expect(checkSelfProtection(call("execute_shell", { command: "chmod 600 permissions.txt" }), [...shell])).toBeNull();
    expect(checkSelfProtection(call("execute_shell", { command: "git log --oneline" }), [...shell])).toBeNull();
  });
});
