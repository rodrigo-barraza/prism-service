/**
 * Prompt 17, Landing 2 — what an agent definition changes about the
 * sub-agent it is spawned as: run pins, a permission mode that only
 * narrows, its own policies beside the parent's, disallowed tools.
 */
import { describe, it, expect } from "vitest";
import {
  applyRunPins,
  composeSubAgentPolicies,
  pinnedSubAgentModel,
  resolveSubAgentApproval,
  subAgentModeHandle,
  withoutDisallowedTools,
} from "#src/services/orchestrator/SubAgentDefinitionPins";
import { PermissionModeHandle } from "#src/services/permissions/PermissionModeState";
import PolicyEngine, { allow, deny, allowAll, denyAll } from "#src/services/PolicyEngine";
import type { Persona } from "#src/services/personas/types";

function persona(fields: Partial<Persona>): Persona {
  return {
    id: "CUSTOM_X",
    name: "x",
    type: "",
    project: "prism-chat",
    custom: true,
    identity: () => "",
    guidelines: "",
    interactionRules: "",
    toolPolicy: "",
    availableTools: ["*"],
    capabilities: "",
    usesDirectoryTree: false,
    usesCodingGuidelines: false,
    ...fields,
  };
}

describe("pins", () => {
  it("a model pin names its provider, else keeps the parent's; no model = no pin", () => {
    expect(pinnedSubAgentModel(persona({ model: "claude-sonnet-5", provider: "anthropic" }), "google")).toEqual({
      providerName: "anthropic",
      resolvedModel: "claude-sonnet-5",
    });
    expect(pinnedSubAgentModel(persona({ model: "local-gguf" }), "vllm-2")).toEqual({
      providerName: "vllm-2",
      resolvedModel: "local-gguf",
    });
    expect(pinnedSubAgentModel(persona({}), "google")).toBeNull();
    expect(pinnedSubAgentModel(null, "google")).toBeNull();
  });

  it("maxTurns and effort replace the parent's; effort none turns thinking off", () => {
    const parent = { maxIterations: 25, thinkingEnabled: false, reasoningEffort: "high" };
    expect(applyRunPins(persona({ maxTurns: 3, effort: "low" }), parent)).toEqual({
      maxIterations: 3,
      thinkingEnabled: true,
      reasoningEffort: "low",
      thinkingLevel: "low",
    });
    expect(applyRunPins(persona({ effort: "none" }), parent)).toMatchObject({ thinkingEnabled: false, reasoningEffort: "none" });
    expect(applyRunPins(persona({}), parent)).toEqual(parent);
  });
});

describe("resolveSubAgentApproval — a definition only narrows", () => {
  const autoParent = { autoApprove: true };
  const askingParent = { autoApprove: false };

  it("no mode: the parent's approval, unchanged", () => {
    expect(resolveSubAgentApproval(autoParent, undefined)).toEqual({ autoApprove: true });
    expect(resolveSubAgentApproval(askingParent, undefined)).toEqual({ autoApprove: false });
    expect(resolveSubAgentApproval({ autoApprove: false, permissionMode: "plan" }, undefined)).toEqual({
      autoApprove: false,
      permissionMode: "plan",
    });
  });

  it("default and plan turn a parent's auto-approval off", () => {
    expect(resolveSubAgentApproval(autoParent, "default")).toEqual({ autoApprove: false, permissionMode: "default" });
    expect(resolveSubAgentApproval(autoParent, "plan")).toEqual({ autoApprove: false, permissionMode: "plan" });
  });

  it("dontAsk keeps the parent's approvals and turns asks into denials", () => {
    expect(resolveSubAgentApproval(autoParent, "dontAsk")).toEqual({ autoApprove: true, permissionMode: "dontAsk" });
    expect(resolveSubAgentApproval(askingParent, "dontAsk")).toEqual({ autoApprove: false, permissionMode: "dontAsk" });
  });

  it("acceptEdits / auto / bypass never widen past the parent", () => {
    for (const mode of ["acceptEdits", "auto", "bypass"] as const) {
      expect(resolveSubAgentApproval(askingParent, mode)).toEqual({ autoApprove: false, narrowedFrom: mode });
      expect(resolveSubAgentApproval(autoParent, mode)).toEqual({ autoApprove: true });
    }
  });

  it("a parent in plan or dontAsk passes it down — a child is never looser", () => {
    const planParent = { autoApprove: false, permissionMode: "plan" as const };
    expect(resolveSubAgentApproval(planParent, "dontAsk")).toEqual({ autoApprove: false, permissionMode: "plan" });
    expect(resolveSubAgentApproval(planParent, "default")).toEqual({ autoApprove: false, permissionMode: "plan" });
    expect(resolveSubAgentApproval(planParent, "bypass")).toMatchObject({ autoApprove: false, permissionMode: "plan" });
    const dontAskParent = { autoApprove: true, permissionMode: "dontAsk" as const };
    expect(resolveSubAgentApproval(dontAskParent, "default")).toEqual({ autoApprove: false, permissionMode: "dontAsk" });
    expect(resolveSubAgentApproval(dontAskParent, "auto")).toEqual({ autoApprove: true, permissionMode: "dontAsk" });
  });
});

describe("subAgentModeHandle — a definition's mode narrows the parent's live handle", () => {
  it("no mode: the parent's handle itself, so its switches reach the sub-agent", () => {
    const parent = new PermissionModeHandle("acceptEdits");
    expect(subAgentModeHandle(parent, false, undefined).handle).toBe(parent);
  });

  it("plan under a parent in acceptEdits stays plan, whatever the parent switches to", () => {
    const parent = new PermissionModeHandle("acceptEdits", { source: "request" });
    const { handle, dispose } = subAgentModeHandle(parent, false, "plan");
    expect(handle).not.toBe(parent);
    expect(handle.mode).toBe("plan");
    parent.set("bypass", "user");
    expect(handle.mode).toBe("plan");
    dispose();
  });

  it("dontAsk follows the parent into plan and back out", () => {
    const parent = new PermissionModeHandle("default");
    const { handle, dispose } = subAgentModeHandle(parent, false, "dontAsk");
    expect(handle.mode).toBe("dontAsk");
    expect(handle.cannotAsk).toBe(true);
    parent.set("plan", "user");
    expect(handle.mode).toBe("plan");
    parent.set("default", "plan_approved");
    expect(handle.mode).toBe("dontAsk");
    dispose();
  });

  it("a mode wider than the parent's is the parent's, and follows it", () => {
    const parent = new PermissionModeHandle("default");
    const { handle, dispose } = subAgentModeHandle(parent, false, "acceptEdits");
    expect(handle.mode).toBe("default");
    parent.set("acceptEdits", "user");
    expect(handle.mode).toBe("acceptEdits");
    dispose();
  });

  it("the child of an unattended run can ask nobody either", () => {
    const parent = new PermissionModeHandle("acceptEdits", { unattended: true });
    expect(subAgentModeHandle(parent, false, "default").handle.cannotAsk).toBe(true);
  });

  it("after dispose it stops following", () => {
    const parent = new PermissionModeHandle("default");
    const { handle, dispose } = subAgentModeHandle(parent, false, "dontAsk");
    dispose();
    parent.set("plan", "user");
    expect(handle.mode).toBe("dontAsk");
  });
});

describe("composeSubAgentPolicies — the child's own policies beside the parent's", () => {
  it("a different agent's DENY holds under a parent's specific APPROVE, and the parent's DENY under the child's", () => {
    const parentPolicies = [allow("execute_shell")];
    const child = persona({ id: "CUSTOM_READER", policies: [denyAll()] });
    const policies = composeSubAgentPolicies(parentPolicies, "CODING", child)!;
    // One flat list would let the specific allow beat the wildcard deny.
    expect(PolicyEngine.evaluate([...parentPolicies, denyAll()], "execute_shell", {})?.decision).toBe("APPROVE");
    expect(PolicyEngine.evaluate(policies, "execute_shell", {})?.decision).toBe("DENY");

    const strictParent = [deny("write_file")];
    const permissiveChild = persona({ id: "CUSTOM_WRITER", policies: [allowAll()] });
    const inverse = composeSubAgentPolicies(strictParent, "CODING", permissiveChild)!;
    expect(PolicyEngine.evaluate(inverse, "write_file", {})?.decision).toBe("DENY");
    expect(PolicyEngine.evaluate(inverse, "read_file", {})?.decision).toBe("APPROVE");
  });

  it("the same agent as the parent adds nothing; no policies anywhere = undefined", () => {
    const parentPolicies = [deny("write_file")];
    const same = persona({ id: "CUSTOM_X", policies: [allowAll()] });
    expect(composeSubAgentPolicies(parentPolicies, "custom_x", same)).toBe(parentPolicies);
    expect(composeSubAgentPolicies(undefined, "CODING", persona({}))).toBeUndefined();
    expect(composeSubAgentPolicies(undefined, "CODING", persona({ policies: [denyAll()] }))).toEqual([denyAll()]);
  });
});

describe("withoutDisallowedTools", () => {
  const schemas = [
    { name: "write_file", domain: "Files" },
    { name: "replace_in_file", domain: "Files" },
    { name: "read_file", domain: "Files" },
    { name: "search_web", domain: "Web" },
  ];

  it("removes exact names and domain entries from an inherited list", () => {
    expect(withoutDisallowedTools(["read_file", "write_file", "search_web"], ["write_file"], schemas)).toEqual([
      "read_file",
      "search_web",
    ]);
    expect(withoutDisallowedTools(["read_file", "search_web"], ["domain:Web"], schemas)).toEqual(["read_file"]);
    expect(withoutDisallowedTools(["read_file"], undefined, schemas)).toEqual(["read_file"]);
  });
});
