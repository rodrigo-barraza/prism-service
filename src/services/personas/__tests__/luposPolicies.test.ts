import { describe, it, expect, vi } from "vitest";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import PolicyEngine from "#src/services/PolicyEngine";
import { AGENT_IDS } from "#src/services/ToolTaxonomyConstants";
import type { PermissionMode } from "#src/services/permissions/PermissionModes";

// A Discord reply runs under autoApprove for whoever pinged the wolf. The
// tools below are already outside his resolved set; the persona's DENY
// policies are the backstop if some future path hands him one anyway, so
// they must hold exactly where nothing else asks: full auto, every mode.

const lupos = AgentPersonaRegistry.get(AGENT_IDS.LUPOS);
const policies = lupos?.policies ?? [];

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
    expect(policies.every((policy) => policy.decision === "DENY")).toBe(true);
  });

  it("deny every Discord-unsafe tool by name", () => {
    const denied = policies.map((policy) => policy.tool).sort();
    expect(denied).toEqual([...MUST_NEVER_RUN].sort());
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
