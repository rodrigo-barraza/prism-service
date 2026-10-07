import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildHookPayload } from "#src/services/hooks/buildPayload";
import {
  adaptHookArguments,
  commandWorkingDirectory,
} from "#src/services/hooks/ConfiguredHookRegistry";
import {
  _clearTurnHookFacts,
  claudePermissionMode,
  rememberTurnHookFacts,
  type TurnHookFacts,
} from "#src/services/hooks/TurnHookFacts";
import { TurnTranscript, _resetTranscriptsForTests } from "#src/services/hooks/ClaudeTranscript";
import { PermissionModeHandle } from "#src/services/permissions/PermissionModeState";
import { HOOK_EVENTS } from "#src/services/hooks/types";

// ────────────────────────────────────────────────────────────
// Claude Code's hook input as a superset, on EVERY payload —
// stored hooks and repository hooks alike: transcript_path,
// permission_mode, cwd (execute_command's own), tool_response,
// harness, workspace_root, and agent_id on sub-agent runs.
// ────────────────────────────────────────────────────────────

const ROOT = "/repo";

function facts(overrides: Partial<TurnHookFacts> = {}): TurnHookFacts {
  return { workspaceRoot: ROOT, worktree: null, permissionMode: () => "default", ...overrides };
}

async function learnTranscriptPath(conversationId: string, path: string) {
  const transcript = new TurnTranscript(
    { conversationId, root: ROOT },
    {
      baseUrl: "http://tools.test",
      fetchImplementation: (async () =>
        ({ ok: true, status: 200, json: async () => ({ path }) }) as unknown as Response) as typeof fetch,
    },
  );
  await transcript.appendPrompt(null);
}

describe("buildHookPayload — the turn's own events", () => {
  beforeEach(() => {
    _clearTurnHookFacts();
    _resetTranscriptsForTests();
  });

  it("carries Claude Code's fields and Prism's, from the turn's facts", async () => {
    await learnTranscriptPath("conv-1", "/tmp/prism-1000/transcripts/conv-1.jsonl");
    const release = rememberTurnHookFacts("conv-1", facts({ permissionMode: () => "plan" }));

    const payload = buildHookPayload(
      HOOK_EVENTS.USER_PROMPT_SUBMIT,
      { conversationId: "conv-1", agentConversationId: "conv-1", project: "prism-chat", username: "rodrigo", agent: "CODING" },
      { prompt: "Fix the build" },
    );
    expect(payload).toEqual({
      hook_event_name: "UserPromptSubmit",
      session_id: "conv-1",
      transcript_path: "/tmp/prism-1000/transcripts/conv-1.jsonl",
      cwd: ROOT,
      permission_mode: "plan",
      harness: "prism",
      workspace_root: ROOT,
      agent_conversation_id: "conv-1",
      project: "prism-chat",
      username: "rodrigo",
      agent: "CODING",
      prompt: "Fix the build",
    });
    release();
  });

  it("reports the workspace root it resolved, not the request's empty one (tools-service's default root)", () => {
    rememberTurnHookFacts("conv-1", facts({ workspaceRoot: "/default-root" }));
    const payload = buildHookPayload(HOOK_EVENTS.STOP, { conversationId: "conv-1", agentConversationId: "conv-1", workspaceRoot: null });
    expect(payload.cwd).toBe("/default-root");
    expect(payload.workspace_root).toBe("/default-root");
  });

  it("transcript_path is null until the transcript answers, and permission_mode defaults to `default`", () => {
    const payload = buildHookPayload(HOOK_EVENTS.TURN_START, { conversationId: "conv-2", agentConversationId: "conv-2" });
    expect(payload.transcript_path).toBeNull();
    expect(payload.permission_mode).toBe("default");
    expect(payload.harness).toBe("prism");
    expect(payload.cwd).toBeNull();
  });

  it("names a sub-agent run: agent_id is its own id, next to its parent's", () => {
    const payload = buildHookPayload(HOOK_EVENTS.SUBAGENT_START, {
      conversationId: "sub-1",
      agentConversationId: "sub-1",
      parentAgentConversationId: "conv-1",
      workspaceRoot: "/wt/sub-1",
    });
    expect(payload).toMatchObject({ agent_id: "sub-1", parent_agent_conversation_id: "conv-1", cwd: "/wt/sub-1" });
    expect(buildHookPayload(HOOK_EVENTS.TURN_START, { agentConversationId: "conv-1" }).agent_id).toBeUndefined();
  });

  it("a SessionEnd after its turn closed still reports the turn's facts it was handed", () => {
    const held = facts({ workspaceRoot: "/repo/web", permissionMode: () => "acceptEdits" });
    const release = rememberTurnHookFacts("conv-1", held);
    release();
    const payload = buildHookPayload(HOOK_EVENTS.SESSION_END, {
      conversationId: "conv-1",
      agentConversationId: "conv-1",
      hookFacts: held,
    });
    expect(payload).toMatchObject({ cwd: "/repo/web", workspace_root: "/repo/web", permission_mode: "acceptEdits" });
  });

  it("reads the mode off a full agentic context when no facts were recorded (compaction's caller)", () => {
    const payload = buildHookPayload(HOOK_EVENTS.PRE_COMPACT, {
      agentConversationId: "unrecorded",
      options: { _permissionMode: new PermissionModeHandle("plan") },
    });
    expect(payload.permission_mode).toBe("plan");
  });
});

describe("claudePermissionMode — Claude Code's names", () => {
  it("passes every mode through, names bypass bypassPermissions, and reads approve-all on default as bypass", () => {
    expect(claudePermissionMode("default")).toBe("default");
    expect(claudePermissionMode("plan")).toBe("plan");
    expect(claudePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(claudePermissionMode("auto")).toBe("auto");
    expect(claudePermissionMode("dontAsk")).toBe("dontAsk");
    expect(claudePermissionMode("bypass")).toBe("bypassPermissions");
    expect(claudePermissionMode(new PermissionModeHandle("plan"), true)).toBe("plan");
    expect(claudePermissionMode(new PermissionModeHandle("default"), true)).toBe("bypassPermissions");
    expect(claudePermissionMode(null)).toBe("default");
    expect(claudePermissionMode("nonsense")).toBe("default");
  });

  it("follows a mode switched mid-turn, read when the payload is built", () => {
    const handle = new PermissionModeHandle("default");
    const release = rememberTurnHookFacts("conv-1", facts({ permissionMode: () => claudePermissionMode(handle) }));
    expect(buildHookPayload(HOOK_EVENTS.STOP, { agentConversationId: "conv-1" }).permission_mode).toBe("default");
    handle.set("plan", "user");
    expect(buildHookPayload(HOOK_EVENTS.STOP, { agentConversationId: "conv-1" }).permission_mode).toBe("plan");
    release();
  });
});

describe("adaptHookArguments — tool events", () => {
  const scope = { project: "prism-chat", username: "rodrigo", agent: "CODING", conversationId: "conv-1", agentConversationId: "conv-1" };

  beforeEach(() => {
    _clearTurnHookFacts();
    _resetTranscriptsForTests();
  });
  afterEach(() => _clearTurnHookFacts());

  it("cwd is execute_command's own cwd, resolved against the workspace root", () => {
    rememberTurnHookFacts("conv-1", facts());
    const cwdOf = (args: Record<string, unknown>) =>
      adaptHookArguments(HOOK_EVENTS.PRE_TOOL_USE, [{ name: "execute_command", args, id: "c1" }], scope).payload.cwd;
    expect(cwdOf({ command: "ls" })).toBe(ROOT);
    expect(cwdOf({ command: "ls", cwd: "web/src" })).toBe("/repo/web/src");
    expect(cwdOf({ command: "ls", cwd: "../elsewhere" })).toBe("/elsewhere");
    expect(cwdOf({ command: "ls", cwd: "/tmp/build/" })).toBe("/tmp/build/");
    expect(cwdOf({ command: "ls", cwd: "  " })).toBe(ROOT);
  });

  it("every other tool's cwd is the workspace root, whatever its arguments say", () => {
    rememberTurnHookFacts("conv-1", facts());
    const { payload } = adaptHookArguments(
      HOOK_EVENTS.PRE_TOOL_USE,
      [{ name: "write_file", args: { path: "a.ts", cwd: "/elsewhere" }, id: "c1" }],
      scope,
    );
    expect(payload.cwd).toBe(ROOT);
    expect(payload.workspace_root).toBe(ROOT);
  });

  it("a sub-agent in a worktree: cwd into its checkout moves into the worktree, as its command did", () => {
    const worktree = { originalRoot: "/repo", repoPath: "/repo", worktreePath: "/wt/sub-1" };
    rememberTurnHookFacts("sub-1", facts({ workspaceRoot: "/wt/sub-1", worktree }));
    const { payload } = adaptHookArguments(
      HOOK_EVENTS.PRE_TOOL_USE,
      [{ name: "execute_command", args: { command: "make", cwd: "/repo/web" }, id: "c1" }],
      { ...scope, agentConversationId: "sub-1", conversationId: "sub-1", parentAgentConversationId: "conv-1" },
    );
    expect(payload.cwd).toBe("/wt/sub-1/web");
    expect(payload.workspace_root).toBe("/wt/sub-1");
    expect(payload.agent_id).toBe("sub-1");
    expect(commandWorkingDirectory("sub", "/wt/sub-1", worktree)).toBe("/wt/sub-1/sub");
  });

  it("PostToolUse carries tool_response — the same value as tool_output, which stays", () => {
    const result = { success: true, stdout: "ok" };
    for (const event of [HOOK_EVENTS.POST_TOOL_USE, HOOK_EVENTS.POST_TOOL_USE_FAILURE]) {
      const { payload } = adaptHookArguments(event, [{ name: "execute_command", args: {}, id: "c1" }, result, {}], scope);
      expect(payload.tool_output).toBe(result);
      expect(payload.tool_response).toBe(result);
    }
    const { payload: before } = adaptHookArguments(HOOK_EVENTS.PRE_TOOL_USE, [{ name: "x", args: {}, id: "c" }], scope);
    expect(before.tool_response).toBeUndefined();
  });

  it("session_id is the conversation when the scope names no session; transcript_path and harness are there", async () => {
    await learnTranscriptPath("conv-1", "/tmp/t/conv-1.jsonl");
    rememberTurnHookFacts("conv-1", facts({ permissionMode: () => "bypassPermissions" }));
    const { payload } = adaptHookArguments(HOOK_EVENTS.PRE_TOOL_USE, [{ name: "read_file", args: {}, id: "c1" }], scope);
    expect(payload).toMatchObject({
      session_id: "conv-1",
      transcript_path: "/tmp/t/conv-1.jsonl",
      permission_mode: "bypassPermissions",
      harness: "prism",
      tool_use_id: "c1",
    });
  });

  it("without recorded facts, the mode comes from the agentic context passed with the call", () => {
    const { payload } = adaptHookArguments(
      HOOK_EVENTS.PRE_TOOL_USE,
      [
        { name: "read_file", args: {}, id: "c1" },
        { provider: {}, messages: [], agentConversationId: "other", options: { _permissionMode: new PermissionModeHandle("dontAsk") } },
      ],
      scope,
    );
    expect(payload.permission_mode).toBe("dontAsk");
  });

  it("the PermissionRequest caller's own permission_mode still wins (it is the approval engine's)", () => {
    rememberTurnHookFacts("conv-1", facts({ permissionMode: () => "default" }));
    const { payload } = adaptHookArguments(
      HOOK_EVENTS.PERMISSION_REQUEST,
      [{ name: "write_file", args: {}, id: "c1" }, { permission_mode: "bypassPermissions", tier: "write" }],
      scope,
    );
    expect(payload.permission_mode).toBe("bypassPermissions");
  });
});
