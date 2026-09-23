/**
 * Permission modes — the engine's decision per mode, protected paths, and
 * how a turn picks its mode. The loop-level behaviour (a real harness, the
 * card, the stored mode, a mid-turn switch) is permissionModesInTheLoop.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import PermissionRuleSet from "#src/services/permissions/PermissionRuleSet";
import { compileRule } from "#src/services/permissions/PermissionEvaluator";
import { resetToolCapabilities } from "#src/services/permissions/ToolCapabilities";
import {
  BYPASS_OWNERS_ENV_VAR,
  isPlanSafe,
  isWorkspaceEdit,
  type PermissionMode,
} from "#src/services/permissions/PermissionModes";
import {
  PermissionModeHandle,
  resolveTurnPermissionMode,
} from "#src/services/permissions/PermissionModeState";
import { findProtectedPathWrite, protectedTargetOf } from "#src/services/permissions/ProtectedPaths";
import type { ToolCall } from "#src/services/harnesses/types";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const settingsSection = vi.hoisted(() => ({ permissions: {} as Record<string, unknown> }));
vi.mock("#src/services/SettingsService", () => ({
  default: { getSection: vi.fn(async (name: string) => (name === "permissions" ? settingsSection.permissions : {})) },
}));

const WORKSPACE = "/ws";

const read: ToolCall = { id: "r", name: "read_file", args: { path: "src/a.ts" } };
const editInside: ToolCall = { id: "w", name: "write_file", args: { path: "src/a.ts", content: "x" } };
const editOutside: ToolCall = { id: "o", name: "write_file", args: { path: "/etc/hosts", content: "x" } };
const shell: ToolCall = { id: "s", name: "execute_shell", args: { command: "npm test" } };
const network: ToolCall = { id: "n", name: "read_web_page", args: { url: "https://example.com" } };
const protectedEdit: ToolCall = { id: "p", name: "write_file", args: { path: ".env", content: "KEY=1" } };

type Outcome = "allow" | "ask" | "deny";

function outcome(engine: AutoApprovalEngine, call: ToolCall): Outcome {
  const result = engine.check({ ...call });
  return result.isDenied ? "deny" : result.isApproved ? "allow" : "ask";
}

function engineIn(mode: PermissionMode | PermissionModeHandle, extra: Record<string, unknown> = {}) {
  return new AutoApprovalEngine({ permissionMode: mode, workspaceRoot: WORKSPACE, ...extra });
}

function rules(...entries: Array<[string, "allow" | "ask" | "deny"]>): PermissionRuleSet {
  return new PermissionRuleSet(
    { username: "rodrigo", profileId: "default" },
    { project: "p", agent: null, conversationIds: [], workspaceRoot: WORKSPACE },
    entries.map(([rule, decision], index) =>
      compileRule({ id: `r${index}`, rule, decision, scope: "profile", project: "p", agent: null, conversationId: null }),
    ),
    { live: false },
  );
}

beforeEach(() => resetToolCapabilities());

describe("the engine, mode by mode", () => {
  // read · edit inside · edit outside · shell · network · protected write
  const matrix: Array<[PermissionMode, Outcome[]]> = [
    ["default", ["allow", "ask", "ask", "ask", "allow", "ask"]],
    ["plan", ["allow", "deny", "deny", "deny", "deny", "deny"]],
    ["acceptEdits", ["allow", "allow", "ask", "ask", "allow", "ask"]],
    ["auto", ["allow", "allow", "ask", "ask", "allow", "ask"]],
    ["dontAsk", ["allow", "deny", "deny", "deny", "allow", "deny"]],
    ["bypass", ["allow", "allow", "allow", "allow", "allow", "ask"]],
  ];

  it.each(matrix)("%s", (mode, expected) => {
    const engine = engineIn(mode);
    expect([read, editInside, editOutside, shell, network, protectedEdit].map((call) => outcome(engine, call))).toEqual(
      expected,
    );
  });

  it("plan refuses with a message that tells the model it is planning", () => {
    const result = engineIn("plan").check({ ...editInside });
    expect(result).toMatchObject({ isDenied: true, deniedBy: "mode", layer: "mode", mode: "plan" });
    expect(result.reason).toContain("[Plan mode]");
    expect(result.reason).toContain("write_file");
    expect(result.reason).toMatch(/read-only/);
  });

  it("dontAsk turns every kind of ask into a named denial — rule, hook, tier", () => {
    const engine = engineIn("dontAsk", { permissionRules: rules(["read_file(secrets/**)", "ask"]) });
    const ruleAsk = engine.check({ id: "a", name: "read_file", args: { path: "secrets/key" } });
    const hookAsk = engine.check({ ...read, _hookPermission: { decision: "ask", reason: "audit" } });
    const tierAsk = engine.check({ ...shell });
    for (const result of [ruleAsk, hookAsk, tierAsk]) {
      expect(result).toMatchObject({ isDenied: true, deniedBy: "mode" });
      expect(result.reason).toContain("[Don't-ask mode]");
    }
    expect(ruleAsk.reason).toContain("read_file(secrets/**)");
  });

  it("dontAsk still runs what an allow rule pre-approves, and refuses ask_user", () => {
    const engine = engineIn("dontAsk", { permissionRules: rules(["execute_shell(npm test)", "allow"]) });
    expect(outcome(engine, shell)).toBe("allow");
    const question = engine.check({ id: "q", name: "ask_user", args: { question: "Which?" } });
    expect(question).toMatchObject({ isDenied: true, deniedBy: "mode" });
  });

  it("an unattended run denies what would ask in ANY mode — plan stays plan, acceptEdits keeps its edits", () => {
    const unattendedEdits = engineIn(new PermissionModeHandle("acceptEdits", { unattended: true }));
    expect(outcome(unattendedEdits, editInside)).toBe("allow");
    expect(outcome(unattendedEdits, editOutside)).toBe("deny");
    const unattendedPlan = engineIn(new PermissionModeHandle("plan", { unattended: true }));
    expect(outcome(unattendedPlan, read)).toBe("allow");
    expect(unattendedPlan.check({ ...editInside }).reason).toContain("[Plan mode]");
  });

  it("no mode relaxes a deny rule or self-protection, bypass included", () => {
    const engine = engineIn("bypass", { permissionRules: rules(["execute_shell(rm *)", "deny"]) });
    expect(outcome(engine, { id: "d", name: "execute_shell", args: { command: "rm -rf build" } })).toBe("deny");
    expect(
      outcome(engine, { id: "x", name: "execute_shell", args: { command: "curl localhost:7777/permissions/mode -X PUT" } }),
    ).toBe("deny");
  });

  it("bypass still asks where an ask rule or a hook asks (Claude Code's rule)", () => {
    const engine = engineIn("bypass", { permissionRules: rules(["execute_shell(git push *)", "ask"]) });
    expect(outcome(engine, { id: "g", name: "execute_shell", args: { command: "git push origin main" } })).toBe("ask");
    expect(outcome(engine, { ...shell, _hookPermission: { decision: "ask" } })).toBe("ask");
  });

  it("protected paths ask even under full auto and an allow rule, and 'approve all' cannot answer them", () => {
    const engine = new AutoApprovalEngine({
      fullAuto: true,
      permissionRules: rules(["write_file(**)", "allow"]),
      workspaceRoot: WORKSPACE,
    });
    const result = engine.check({ id: "g", name: "write_file", args: { path: "/ws/.git/config", content: "x" } });
    expect(result).toMatchObject({ isApproved: false, layer: "protected_path", alwaysAsks: true, protectedPath: "/ws/.git/config" });
    expect(outcome(engine, editInside)).toBe("allow");
  });

  it("auto asks where the classifier would decide — its failure mode — and runs reads and workspace edits", () => {
    const result = engineIn("auto").check({ ...shell });
    expect(result).toMatchObject({ isApproved: false, layer: "mode" });
    expect(result.reason).toMatch(/classifier/);
  });

  it("reads the live handle on every check — a switch applies to the next call", () => {
    const handle = new PermissionModeHandle("default");
    const engine = engineIn(handle);
    expect(outcome(engine, editInside)).toBe("ask");
    handle.set("plan", "user");
    expect(outcome(engine, editInside)).toBe("deny");
    handle.set("acceptEdits", "user");
    expect(outcome(engine, editInside)).toBe("allow");
  });

  it("acceptEdits needs a workspace root: without one an edit asks", () => {
    const engine = new AutoApprovalEngine({ permissionMode: "acceptEdits" });
    expect(outcome(engine, editInside)).toBe("ask");
  });
});

describe("the predicates", () => {
  it("plan-safe = only reading and delegating", () => {
    expect(isPlanSafe([])).toBe(true);
    expect(isPlanSafe(["fs_read"])).toBe(true);
    expect(isPlanSafe(["subagent"])).toBe(true);
    expect(isPlanSafe(["fs_read", "network"])).toBe(false);
    expect(isPlanSafe(["external_side_effect"])).toBe(false);
    expect(isPlanSafe(["memory_write"])).toBe(false);
  });

  it("a workspace edit names only paths inside the root", () => {
    const edit = (name: string, args: Record<string, unknown>) =>
      isWorkspaceEdit({ name, args }, ["fs_write"], WORKSPACE);
    expect(edit("write_file", { path: "src/a.ts" })).toBe(true);
    expect(edit("write_file", { path: "/ws/src/a.ts" })).toBe(true);
    expect(edit("move_file", { source: "a.ts", destination: "b/a.ts" })).toBe(true);
    expect(edit("move_file", { source: "a.ts", destination: "../outside.ts" })).toBe(false);
    expect(edit("write_file", { path: "../x" })).toBe(false);
    expect(edit("write_file", { path: "~/.bashrc" })).toBe(false);
    expect(edit("write_file", { path: "/wsx/a.ts" })).toBe(false);
    expect(edit("write_file", {})).toBe(false);
    // Not a plain file edit: commits, renames across files, shell.
    expect(isWorkspaceEdit({ name: "commit_split", args: { path: "." } }, ["fs_write"], WORKSPACE)).toBe(false);
    expect(isWorkspaceEdit({ name: "write_file", args: { path: "a" } }, ["fs_write", "network"], WORKSPACE)).toBe(false);
  });

  it("protected targets", () => {
    expect(protectedTargetOf(".git/config")).toBe(".git");
    expect(protectedTargetOf("/ws/.git")).toBe(".git");
    expect(protectedTargetOf(".env")).toBe(".env*");
    expect(protectedTargetOf("apps/web/.env.local")).toBe(".env*");
    expect(protectedTargetOf(".envrc")).toBe(".env*");
    expect(protectedTargetOf(".prism/agents/reviewer.md")).toBe("Prism configuration");
    expect(protectedTargetOf(".claude/rules/x.md")).toBe("Prism configuration");
    expect(protectedTargetOf("PRISM.md")).toBe("Prism configuration");
    expect(protectedTargetOf(".mcp.json")).toBe("Prism configuration");
    // Not protected:
    expect(protectedTargetOf(".gitignore")).toBeNull();
    expect(protectedTargetOf(".github/workflows/ci.yml")).toBeNull();
    expect(protectedTargetOf("src/environment.ts")).toBeNull();
    expect(protectedTargetOf(".claude/worktrees/task/src/a.ts")).toBeNull();
    expect(protectedTargetOf(".claude/worktrees/task/.git")).toBe(".git");
  });

  it("shell words that name a protected path — a tripwire, not a parser", () => {
    const shellCall = (command: string) =>
      findProtectedPathWrite({ name: "execute_shell", args: { command } }, ["shell", "fs_write", "network"]);
    expect(shellCall("rm -rf .git")).toMatchObject({ target: ".git" });
    expect(shellCall('echo "KEY=1" >> .env')).toMatchObject({ target: ".env*" });
    expect(shellCall("cp template.env apps/web/.env.local")).toMatchObject({ target: ".env*" });
    expect(shellCall("git commit -m 'fix' && git push")).toBeNull();
    expect(shellCall("cat .gitignore")).toBeNull();
    // A read is not a write.
    expect(findProtectedPathWrite({ name: "read_file", args: { path: ".env" } }, ["fs_read"])).toBeNull();
  });
});

describe("the mode a turn starts in", () => {
  const previousOwners = process.env[BYPASS_OWNERS_ENV_VAR];
  afterEach(() => {
    if (previousOwners === undefined) delete process.env[BYPASS_OWNERS_ENV_VAR];
    else process.env[BYPASS_OWNERS_ENV_VAR] = previousOwners;
    settingsSection.permissions = {};
  });

  it("request > stored > settings default", async () => {
    settingsSection.permissions = { defaultMode: "acceptEdits" };
    expect(await resolveTurnPermissionMode({ requested: "plan", storedMode: "dontAsk", username: "u" })).toMatchObject({
      mode: "plan",
      source: "request",
    });
    expect(await resolveTurnPermissionMode({ storedMode: "dontAsk", username: "u" })).toMatchObject({
      mode: "dontAsk",
      source: "conversation",
    });
    expect(await resolveTurnPermissionMode({ storedMode: null, username: "u" })).toMatchObject({
      mode: "acceptEdits",
      source: "settings",
    });
  });

  it("unattended: dontAsk unless the conversation names a mode other than default", async () => {
    settingsSection.permissions = { defaultMode: "acceptEdits" };
    expect(await resolveTurnPermissionMode({ unattended: true, storedMode: null })).toMatchObject({
      mode: "dontAsk",
      source: "unattended",
    });
    expect(await resolveTurnPermissionMode({ unattended: true, storedMode: "default" })).toMatchObject({
      mode: "dontAsk",
    });
    expect(await resolveTurnPermissionMode({ unattended: true, storedMode: "plan" })).toMatchObject({
      mode: "plan",
      source: "conversation",
    });
  });

  it("bypass requires the owner flag", async () => {
    delete process.env[BYPASS_OWNERS_ENV_VAR];
    const refused = await resolveTurnPermissionMode({ requested: "bypass", storedMode: null, username: "rodrigo" });
    expect(refused).toMatchObject({ mode: "default", source: "owner_check" });
    expect(refused.refusedBypass?.reason).toContain("owner-only");

    process.env[BYPASS_OWNERS_ENV_VAR] = "someone, rodrigo";
    expect(
      await resolveTurnPermissionMode({ requested: "bypass", storedMode: null, username: "rodrigo" }),
    ).toMatchObject({ mode: "bypass", source: "request" });
    expect(
      await resolveTurnPermissionMode({ requested: "bypass", storedMode: null, username: "mallory" }),
    ).toMatchObject({ mode: "default", source: "owner_check" });
  });

  it("bypass is never a default — a settings value of bypass reads as default", async () => {
    process.env[BYPASS_OWNERS_ENV_VAR] = "rodrigo";
    settingsSection.permissions = { defaultMode: "bypass" };
    expect(await resolveTurnPermissionMode({ storedMode: null, username: "rodrigo" })).toMatchObject({
      mode: "default",
      source: "settings",
    });
  });

  it("a handle tells its listeners about real changes only", () => {
    const handle = new PermissionModeHandle("plan", { source: "conversation" });
    const changes: unknown[] = [];
    handle.onChange((change) => changes.push(change));
    expect(handle.set("plan", "user")).toBe(false);
    expect(handle.set("default", "plan_approved")).toBe(true);
    expect(changes).toEqual([{ mode: "default", previousMode: "plan", source: "plan_approved" }]);
    expect(handle.cannotAsk).toBe(false);
    handle.set("dontAsk", "user");
    expect(handle.cannotAsk).toBe(true);
  });
});
