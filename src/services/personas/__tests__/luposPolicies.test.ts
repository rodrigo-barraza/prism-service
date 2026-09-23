import { describe, it, expect, vi } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import AutoApprovalEngine, { APPROVAL_TIERS } from "#src/services/AutoApprovalEngine";
import PolicyEngine, { allow } from "#src/services/PolicyEngine";
import { AGENT_IDS } from "#src/services/ToolTaxonomyConstants";
import type { PermissionMode } from "#src/services/permissions/PermissionModes";
import { PermissionModeHandle } from "#src/services/permissions/PermissionModeState";
import { LUPOS_TOOL_POLICY_SECTIONS } from "#src/services/personas/LuposPersona";

// A Discord reply acts for whoever pinged the wolf. The DENY tools below are
// already outside his resolved set; the persona's DENY policies are the
// backstop if some future path hands him one anyway, so they must hold
// exactly where nothing else asks: full auto, every mode. Everything else
// he may run is an APPROVE rule, and his turns are pinned to dontAsk.

const lupos = AgentPersonaRegistry.get(AGENT_IDS.LUPOS);
const policies = lupos?.policies ?? [];
const deniedNames = policies.filter((policy) => policy.decision === "DENY").map((policy) => policy.tool);
const allowedNames = policies.filter((policy) => policy.decision === "APPROVE").map((policy) => policy.tool);

/** The handle a LUPOS turn runs under (AgenticLoopService.openPermissionMode). */
const pinnedHandle = () =>
  new PermissionModeHandle("dontAsk", { source: "persona", pinned: true });
/** His engine as the harness builds it — a stale autoApprove included. */
const luposEngine = (extraPolicies = policies) =>
  new AutoApprovalEngine({ fullAuto: true, policies: extraPolicies, permissionMode: pinnedHandle() });
const call = (name: string, args: Record<string, unknown> = {}) => ({ id: `call-${name}`, name, args });

const MUST_NEVER_RUN = [
  // shell / command execution
  "execute_shell",
  "execute_command",
  // background and programmatic dispatch
  "run_async_task",
  "run_tool_program",
  // sub-agents and agent definitions
  "create_subagent",
  "create_subagents",
  "send_subagent_message",
  "resume_subagent",
  "create_custom_agent",
  "update_custom_agent",
  // skills
  "create_skill",
  "execute_skill",
  "delete_skill",
  // datastore and project-instruction writes
  "write_datastore",
  "delete_datastore",
  "update_project_instructions",
  "edit_project_instructions",
  // timers and schedules
  "set_timer",
  "cancel_timer",
  "create_cron_job",
  "delete_cron_job",
  "trigger_cron_job",
  // a question nobody in the channel can answer
  "ask_user",
  // the owner's accounts and home
  "send_email",
  "send_sms",
  "send_push_notification",
  "send_webhook",
  "control_spotify",
  "set_light_state",
  "set_light_states",
  "adjust_light_state",
  "toggle_light_power",
  "start_light_breathe_effect",
  "start_light_pulse_effect",
  "start_light_move_effect",
  "start_light_flame_effect",
  "start_light_morph_effect",
  "stop_light_effects",
  "paint_lights_from_image",
  "activate_light_scene",
  "enable_light_night_lock",
];

/** What he is for — none of it may trip a policy. */
const HIS_OWN_TOOLS = [
  "execute_python",
  "execute_javascript",
  "search_web",
  "read_url",
  "generate_image",
  "react_to_discord_message",
  "give_discord_gold",
  "mug_discord_gold",
  "get_discord_user_profile",
  "search_discord_messages",
  "create_discord_poll",
  "schedule_discord_reminder",
  "search_spotify",
];

const MODES: PermissionMode[] = ["default", "acceptEdits", "auto", "bypass"];

describe("LUPOS tool policies", () => {
  it("are served by the persona registry, not only declared on the module", () => {
    expect(policies.length).toBeGreaterThan(0);
    expect(policies.every((policy) => ["DENY", "APPROVE"].includes(policy.decision))).toBe(true);
    // No tool is on both lists: an APPROVE never exists to be overruled.
    expect(allowedNames.filter((name) => deniedNames.includes(name))).toEqual([]);
  });

  it("deny every Discord-unsafe tool by name", () => {
    expect([...deniedNames].sort()).toEqual([...MUST_NEVER_RUN].sort());
    for (const toolName of MUST_NEVER_RUN) {
      expect(PolicyEngine.isDenied(policies, toolName, {})).toBe(true);
    }
  });

  it.each(MODES)(
    "hold under autoApprove in %s mode — a terminal denial, never a prompt",
    (permissionMode) => {
      const engine = new AutoApprovalEngine({
        fullAuto: true,
        policies,
        permissionMode,
      });
      for (const toolName of MUST_NEVER_RUN) {
        const result = engine.check({ id: `call-${toolName}`, name: toolName, args: {} });
        expect(result, toolName).toMatchObject({
          isApproved: false,
          isDenied: true,
          deniedBy: "rule",
          layer: "agent_policy",
        });
      }
    },
  );

  it("leave his own tools running under autoApprove", () => {
    const engine = new AutoApprovalEngine({ fullAuto: true, policies });
    for (const toolName of HIS_OWN_TOOLS) {
      const result = engine.check({ id: `call-${toolName}`, name: toolName, args: {} });
      expect(result.isDenied, toolName).toBeFalsy();
      expect(result.isApproved, toolName).toBe(true);
    }
  });
});

describe("LUPOS least privilege — pinned dontAsk and an allow list", () => {
  it("pins his turns to dontAsk", () => {
    expect(lupos?.pinnedPermissionMode).toBe("dontAsk");
  });

  it("runs every allow-listed tool without asking, whatever its tier", () => {
    const engine = luposEngine();
    const tiers = new Set(allowedNames.map((name) => engine.getTier(name)));
    // The list is there for tools the tier would ask about: WRITE and DANGER.
    expect([...tiers].sort()).toEqual([APPROVAL_TIERS.WRITE, APPROVAL_TIERS.DANGER]);
    for (const toolName of allowedNames) {
      expect(engine.check(call(toolName)), toolName).toMatchObject({
        isApproved: true,
        layer: "agent_policy",
        mode: "dontAsk",
      });
    }
  });

  it("covers what his own prompt tells him to call", () => {
    // enabledByDefaultTools and every tool a tool-policy section names: an
    // instruction he cannot follow would only earn a refusal.
    const engine = luposEngine();
    const named = new Set([
      ...(lupos?.enabledByDefaultTools ?? []),
      ...LUPOS_TOOL_POLICY_SECTIONS.flatMap((section) => section.requires ?? []),
    ]);
    const refused = [...named].filter((toolName) => !engine.check(call(toolName)).isApproved);
    expect(refused).toEqual([]);
  });

  it("refuses a WRITE tool of his universe that is not listed — with the don't-ask message, no card", () => {
    const engine = luposEngine();
    // get_ip_info sits in his Utilities domain; with no argument it looks up
    // the server's own address.
    const result = engine.check(call("get_ip_info"));
    expect(engine.getTier("get_ip_info")).toBe(APPROVAL_TIERS.WRITE);
    expect(result).toMatchObject({ isApproved: false, isDenied: true, deniedBy: "mode", mode: "dontAsk" });
    expect(result.reason).toContain(`[Don't-ask mode] "get_ip_info" needs approval`);
  });

  it("refuses a DANGER tool he has no rule for (an MCP tool, a future sandbox)", () => {
    const engine = luposEngine();
    for (const toolName of ["mcp__github__create_issue", "execute_ruby"]) {
      const result = engine.check(call(toolName));
      expect(result, toolName).toMatchObject({ isApproved: false, isDenied: true, deniedBy: "mode" });
    }
    expect(engine.getTier("mcp__github__create_issue")).toBe(APPROVAL_TIERS.DANGER);
  });

  it("never leaves a call waiting on approval — every call is run or refused", () => {
    const engine = luposEngine();
    const calls = [
      ...allowedNames,
      ...deniedNames,
      "get_ip_info",
      "write_file",
      "execute_shell",
      "mcp__github__create_issue",
      "ask_user",
      "exit_plan_mode",
      "search_web",
      "some_tool_added_next_month",
    ].map((name) => call(name));
    const { needsApproval, autoApproved, denied } = engine.checkBatch(calls);
    expect(needsApproval).toEqual([]);
    expect(autoApproved.length + denied.length).toBe(calls.length);
  });

  it("keeps a DENY final over an APPROVE for the same tool", () => {
    // A future edit that allow-lists a denied tool changes nothing.
    const engine = luposEngine([...policies, allow("execute_shell"), allow("send_email")]);
    for (const toolName of ["execute_shell", "send_email"]) {
      expect(engine.check(call(toolName)), toolName).toMatchObject({
        isApproved: false,
        isDenied: true,
        deniedBy: "rule",
        layer: "agent_policy",
      });
    }
  });

  it("ignores full auto and a mid-turn approve-all under the pinned mode", async () => {
    const engine = luposEngine();
    const hook = engine.createHook();
    const result = await hook(call("get_ip_info"), { options: { autoApprove: true } } as never);
    expect(result).toMatchObject({ isApproved: false, isDenied: true, deniedBy: "mode" });
    // The same engine without the pin: full auto would have run it.
    const unpinned = new AutoApprovalEngine({ fullAuto: true, policies, permissionMode: "dontAsk" });
    expect(unpinned.check(call("get_ip_info"))).toMatchObject({ isApproved: true, layer: "full_auto" });
  });
});
