/**
 * readUntrustedApproval.test.ts
 *
 * read_untrusted fetches its source through another tool, inside itself —
 * so the approval engine must judge the call AS that fetch, or the reader
 * becomes a way around every rule on the fetch: a deny on
 * read_web_page(https://evil.example/*) would not stop
 * read_untrusted({ url: "https://evil.example/x" }), plan mode would let a
 * network read through, and an MCP resource (WRITE tier) would be read
 * without asking.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import { allow as policyAllow, deny as policyDeny } from "#src/services/PolicyEngine";
import PermissionRuleSet from "../PermissionRuleSet.ts";
import { compileRule } from "../PermissionEvaluator.ts";
import { registerToolCapabilities } from "../ToolCapabilities.ts";
import readUntrustedTool from "#src/services/tool-definitions/ReadUntrustedTool";
import type { PermissionDecision } from "../types.ts";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const READ_UNTRUSTED = "read_untrusted";
const SCHEMA = { type: "object", properties: { price: { type: "number" } } };

function ruleSet(...specs: Array<{ rule: string; decision: PermissionDecision }>) {
  return new PermissionRuleSet(
    { username: "rodrigo", profileId: "default" },
    { project: "prism-chat", agent: null, conversationIds: ["conv-1"], workspaceRoot: "/ws" },
    specs.map((spec, index) =>
      compileRule({ id: `r${index}`, scope: "profile", project: "prism-chat", agent: null, conversationId: null, ...spec }),
    ),
  );
}

const read = (source: Record<string, unknown>) => ({
  id: "call-1",
  name: READ_UNTRUSTED,
  args: { ...source, schema: SCHEMA, question: "What does it cost?" },
});

describe("read_untrusted is judged as the fetch it makes", () => {
  // What InternalToolRegistry does at initialize: the tool's own declaration.
  beforeAll(() => {
    registerToolCapabilities([readUntrustedTool], "internal");
  });

  it("a web page reads like read_web_page: read-only, no prompt", () => {
    const verdict = new AutoApprovalEngine().check(read({ url: "https://example.com/item" }));
    expect(verdict).toMatchObject({ isApproved: true, layer: "tier" });
    expect(verdict.reason).toContain(TOOL_NAMES.READ_WEB_PAGE);
  });

  it("text the caller already holds needs no fetch and runs on its own tier", () => {
    expect(new AutoApprovalEngine().check(read({ content: "a page" }))).toMatchObject({
      isApproved: true,
      reason: "read_only",
    });
  });

  it("an MCP resource asks, as read_mcp_resource does", () => {
    const verdict = new AutoApprovalEngine().check(read({ resource: { server_name: "notion", uri: "notion://page/1" } }));
    expect(verdict.isApproved).toBe(false);
    expect(verdict.isDenied).toBeFalsy();
    expect(verdict.reason).toContain(TOOL_NAMES.READ_MCP_RESOURCE);
    // …and full auto answers it, as it would the fetch.
    expect(
      new AutoApprovalEngine({ fullAuto: true }).check(read({ resource: { server_name: "notion", uri: "notion://page/1" } })),
    ).toMatchObject({ isApproved: true });
  });

  it("a deny rule on the fetch denies the read", () => {
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet({ rule: "read_web_page(https://evil.example/*)", decision: "deny" }),
    });
    const denied = engine.check(read({ url: "https://evil.example/page" }));
    expect(denied).toMatchObject({ isApproved: false, isDenied: true, layer: "rules" });
    expect(engine.check(read({ url: "https://fine.example/page" }))).toMatchObject({ isApproved: true });
  });

  it("a deny on the fetch holds in full auto, and against an allow on read_untrusted", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      policies: [policyAllow(READ_UNTRUSTED), policyDeny(TOOL_NAMES.READ_WEB_PAGE)],
    });
    expect(engine.check(read({ url: "https://example.com" }))).toMatchObject({ isDenied: true });
  });

  it("a deny on read_untrusted itself is final", () => {
    const engine = new AutoApprovalEngine({ policies: [policyDeny(READ_UNTRUSTED)] });
    expect(engine.check(read({ url: "https://example.com" }))).toMatchObject({ isDenied: true, layer: "agent_policy" });
    expect(engine.check(read({ content: "text" }))).toMatchObject({ isDenied: true });
  });

  it("plan mode refuses a network read, not a read of given text", () => {
    const engine = new AutoApprovalEngine({ permissionMode: "plan" });
    expect(engine.check(read({ url: "https://example.com" }))).toMatchObject({ isDenied: true, deniedBy: "mode" });
    expect(engine.check(read({ content: "text" }))).toMatchObject({ isApproved: true });
  });

  it("an allow on read_untrusted answers the fetch's tier prompt, so 'always allow' does not ask again", () => {
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet({ rule: READ_UNTRUSTED, decision: "allow" }),
    });
    expect(engine.check(read({ resource: { server_name: "notion", uri: "notion://page/1" } }))).toMatchObject({
      isApproved: true,
      layer: "rules",
    });
  });

  it("…but not a rule the user wrote about the fetch", () => {
    const engine = new AutoApprovalEngine({
      permissionRules: ruleSet(
        { rule: READ_UNTRUSTED, decision: "allow" },
        { rule: TOOL_NAMES.READ_MCP_RESOURCE, decision: "ask" },
      ),
    });
    const verdict = engine.check(read({ resource: { server_name: "notion", uri: "notion://page/1" } }));
    expect(verdict.isApproved).toBe(false);
    expect(verdict.isDenied).toBeFalsy();
    expect(verdict.rule).toBe(TOOL_NAMES.READ_MCP_RESOURCE);
  });

  it("a third-party-content tool reads at that tool's tier", () => {
    const verdict = new AutoApprovalEngine().check(read({ tool: { name: "read_email", arguments: { id: "m1" } } }));
    expect(verdict.isApproved).toBe(false);
    expect(verdict.reason).toContain("read_email");
  });

  it("arguments that name no valid source are judged on read_untrusted alone (the tool refuses them)", () => {
    expect(new AutoApprovalEngine().check(read({}))).toMatchObject({ isApproved: true, reason: "read_only" });
    expect(new AutoApprovalEngine().check(read({ url: "https://a", content: "b" }))).toMatchObject({ isApproved: true });
  });
});
