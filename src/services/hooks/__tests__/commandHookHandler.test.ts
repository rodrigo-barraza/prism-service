import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TOOLS_SERVICE_URL: "http://tools.test",
}));

import runCommandHook, {
  interpretCommandOutcome,
} from "#src/services/hooks/handlers/CommandHookHandler";
import { isCommandHookOwner } from "#src/services/hooks/CommandHookOwners";
import { runAs } from "../../../../tests/helpers/auth.ts";
import {
  runConfiguredHook,
  normalizeDecision,
  resolveHookTimeout,
} from "#src/services/hooks/HookRunner";
import { HOOK_EVENTS } from "#src/services/hooks/types";
import type {
  CommandHookHandlerConfig,
  ConfiguredHookDocument,
} from "#src/services/hooks/types";
import { HOOKS } from "#src/constants";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// The command handler, run against REAL temporary scripts: the
// fetch stand-in executes what tools-service would execute —
// `bash -c <command>` with the payload on stdin, killed at the
// timeout — and answers in tools-service's response shape.
// ────────────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), "prism-command-hook-"));

function script(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** tools-service's POST /agentic/hook-command/run, in-process. */
function runLikeToolsService(_url: string, init: RequestInit) {
  const body = JSON.parse(String(init.body)) as {
    command: string;
    stdin: string;
    timeoutMilliseconds: number;
    env: Record<string, string>;
  };
  const result = spawnSync("bash", ["-c", body.command], {
    input: body.stdin,
    timeout: body.timeoutMilliseconds,
    killSignal: "SIGKILL",
    env: { PATH: process.env.PATH ?? "", ...body.env },
    encoding: "utf8",
  });
  const timedOut = result.error?.message.includes("ETIMEDOUT") ?? false;
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({
      exitCode: timedOut ? null : result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut,
    }),
  } as unknown as Response);
}

const PAYLOAD = { hook_event_name: "PreToolUse", tool_name: "execute_shell", tool_input: { command: "rm -rf /" } };
const OWNER = "rodrigo";

/** A hook runs inside its turn: here, a turn the owner signed in to (AuthMiddleware). */
function asOwner<T>(fn: () => T): T {
  return runAs("user", OWNER, fn);
}

function commandHook(
  command: string,
  overrides: Partial<ConfiguredHookDocument> = {},
  handler: Partial<CommandHookHandlerConfig> = {},
): ConfiguredHookDocument {
  return {
    id: "command-1",
    project: "prism",
    username: OWNER,
    agent: null,
    name: "shell gate",
    description: "",
    event: HOOK_EVENTS.PRE_TOOL_USE,
    matcher: "",
    handler: { type: "command", command, ...handler },
    enabled: true,
    timeoutMilliseconds: 2_000,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("CommandHookHandler", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let previousOwners: string | undefined;

  beforeEach(() => {
    previousOwners = process.env[HOOKS.COMMAND_OWNERS_ENV_VAR];
    process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] = OWNER;
    fetchMock = vi.fn(runLikeToolsService);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (previousOwners === undefined) delete process.env[HOOKS.COMMAND_OWNERS_ENV_VAR];
    else process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] = previousOwners;
  });

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it("exit 0 with a JSON decision passes it through, and the script read the payload on stdin", async () => {
    const path = script(
      "deny-rm.sh",
      `payload=$(cat)
if printf '%s' "$payload" | grep -q 'rm -rf'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"rm -rf is not allowed"}}'
fi
exit 0`,
    );
    const result = await asOwner(() => runConfiguredHook(commandHook(path), PAYLOAD as never));
    expect(normalizeDecision(result, HOOK_EVENTS.PRE_TOOL_USE)).toMatchObject({
      permissionDecision: "deny",
      reason: "rm -rf is not allowed",
    });
  });

  it("exit 2 blocks, with stderr as the reason, whatever stdout says", async () => {
    const path = script("block.sh", `echo '{"permissionDecision":"allow"}'; echo "protected path" >&2; exit 2`);
    const result = await asOwner(() => runConfiguredHook(commandHook(path), PAYLOAD as never));
    expect(normalizeDecision(result, HOOK_EVENTS.PRE_TOOL_USE)).toMatchObject({
      isApproved: false,
      permissionDecision: "deny",
      reason: "protected path",
    });
  });

  it("exit 2 on Stop keeps the agent going", async () => {
    const path = script("stop.sh", `echo "tests still failing" >&2; exit 2`);
    const result = await asOwner(() => runConfiguredHook(
      commandHook(path, { event: HOOK_EVENTS.STOP }),
      { hook_event_name: "Stop" } as never,
    ));
    expect(normalizeDecision(result, HOOK_EVENTS.STOP)).toMatchObject({
      permissionDecision: "deny",
      reason: "tests still failing",
    });
  });

  it("any other exit status without JSON is a non-blocking failure", async () => {
    const path = script("crash.sh", `echo "boom" >&2; exit 1`);
    const result = await asOwner(() => runConfiguredHook(commandHook(path), PAYLOAD as never));
    expect(result).toMatchObject({ _handlerFailed: true, _reason: "command_exit_1" });
    expect(normalizeDecision(result, HOOK_EVENTS.PRE_TOOL_USE)).toEqual({});
  });

  it("plain stdout on UserPromptSubmit becomes context the model sees", async () => {
    const path = script("context.sh", `echo "Sprint ends Friday."`);
    const result = await asOwner(() => runConfiguredHook(
      commandHook(path, { event: HOOK_EVENTS.USER_PROMPT_SUBMIT }),
      { hook_event_name: "UserPromptSubmit" } as never,
    ));
    expect(result).toMatchObject({ additionalContext: "Sprint ends Friday." });
  });

  it("passes the hook's identity as PRISM_HOOK_* variables", async () => {
    const path = script(
      "env.sh",
      `printf '{"additionalContext":"%s %s"}' "$PRISM_HOOK_EVENT" "$PRISM_HOOK_NAME"`,
    );
    const result = await asOwner(() => runConfiguredHook(commandHook(path), PAYLOAD as never));
    expect(result).toMatchObject({ additionalContext: "PreToolUse shell gate" });
  });

  describe("timeouts — fail_open by default, fail_closed on request", () => {
    const slow = () => script("slow.sh", `sleep 5; echo '{}'`);

    it("fail_open: a timeout is no decision, the action proceeds", async () => {
      const result = await asOwner(() => runConfiguredHook(
        commandHook(slow(), { timeoutMilliseconds: 800 }),
        PAYLOAD as never,
      ));
      expect(result._handlerFailed).toBe(true);
      expect(normalizeDecision(result, HOOK_EVENTS.PRE_TOOL_USE)).toEqual({});
    });

    it("fail_closed: a timeout on a blocking event blocks", async () => {
      const result = await asOwner(() => runConfiguredHook(
        commandHook(slow(), { timeoutMilliseconds: 800 }, { timeoutBehavior: "fail_closed" }),
        PAYLOAD as never,
      ));
      expect(normalizeDecision(result, HOOK_EVENTS.PRE_TOOL_USE)).toMatchObject({
        isApproved: false,
        permissionDecision: "deny",
      });
      expect(String(normalizeDecision(result, HOOK_EVENTS.PRE_TOOL_USE).reason)).toContain("timed out");
    });

    it("fail_closed on an event that cannot block stays fail-open", () => {
      const result = interpretCommandOutcome(
        { exitCode: null, stdout: "", stderr: "", timedOut: true },
        HOOK_EVENTS.POST_TOOL_USE,
        { type: "command", command: "x", timeoutBehavior: "fail_closed" },
      );
      expect(result._handlerFailed).toBe(true);
    });

    it("fail_closed also applies when the runner's own deadline wins the race", async () => {
      fetchMock.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      const result = await asOwner(() => runConfiguredHook(
        commandHook("sleep 10", { timeoutMilliseconds: 300 }, { timeoutBehavior: "fail_closed" }),
        PAYLOAD as never,
      ));
      expect(normalizeDecision(result, HOOK_EVENTS.PRE_TOOL_USE)).toMatchObject({
        permissionDecision: "deny",
      });
    });
  });

  describe("ownership", () => {
    it("reads the owner list per call, comma-separated", () => {
      process.env[HOOKS.COMMAND_OWNERS_ENV_VAR] = " alice , rodrigo ";
      asOwner(() => {
        expect(isCommandHookOwner("rodrigo")).toBe(true);
        expect(isCommandHookOwner("mallory")).toBe(false);
        delete process.env[HOOKS.COMMAND_OWNERS_ENV_VAR];
        expect(isCommandHookOwner("rodrigo")).toBe(false);
      });
    });

    it("an owner only in a signed-in user's turn: a service under the owner's name, or no request, is not", () => {
      expect(runAs("service", OWNER, () => isCommandHookOwner(OWNER))).toBe(false);
      expect(runAs(null, OWNER, () => isCommandHookOwner(OWNER))).toBe(false);
      expect(isCommandHookOwner(OWNER)).toBe(false);
    });

    it("never runs the owner's command hook in a service's turn named after the owner", async () => {
      const path = script("service.sh", `echo '{"permissionDecision":"allow"}'`);
      const result = await runAs("service", OWNER, () => runConfiguredHook(commandHook(path), PAYLOAD as never));
      expect(result).toMatchObject({ _handlerFailed: true, _reason: "command_owner_required" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("never runs a command hook whose document belongs to a non-owner", async () => {
      const path = script("never.sh", `echo '{"permissionDecision":"allow"}'`);
      const result = await asOwner(() => runConfiguredHook(
        commandHook(path, { username: "mallory" }),
        PAYLOAD as never,
      ));
      expect(result).toMatchObject({ _handlerFailed: true, _reason: "command_owner_required" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("reports a tools-service refusal as a failure, not a verdict", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: "bad request" }),
    });
    const result = await asOwner(() => runCommandHook(
      { type: "command", command: "true" },
      { payloadJson: "{}", event: HOOK_EVENTS.PRE_TOOL_USE, timeoutMilliseconds: 1_000, owner: OWNER },
    ));
    expect(result).toMatchObject({ _handlerFailed: true, _reason: "command_service_400" });
  });

  it("sends tools-service the command, the payload as stdin, and a deadline inside the runner's", async () => {
    await asOwner(() => runCommandHook(
      { type: "command", command: "true" },
      {
        payloadJson: '{"hook_event_name":"PreToolUse"}',
        event: HOOK_EVENTS.PRE_TOOL_USE,
        timeoutMilliseconds: 5_000,
        owner: OWNER,
        project: "prism",
        hookName: "gate",
      },
    ));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://tools.test${HOOKS.COMMAND_RUN_PATH}`);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      command: "true",
      stdin: '{"hook_event_name":"PreToolUse"}',
      owner: OWNER,
      env: expect.objectContaining({ PRISM_HOOK_EVENT: "PreToolUse", PRISM_HOOK_NAME: "gate" }),
    });
    expect(body.timeoutMilliseconds).toBeLessThan(5_000);
    // A stored hook runs in its owner's hooks directory, never a workspace.
    expect(body.workspace).toBeUndefined();
    expect(body.cwd).toBeUndefined();
  });

  describe("a repository's own hook (workspace)", () => {
    const workspace = {
      cwd: "/repo",
      path: "/repo/.prism/hooks.json",
      sha256: "a".repeat(64),
      scope: "project" as const,
    };

    it("asks tools-service to run it in the file's directory: {workspace: true, cwd}", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      });
      await asOwner(() => runCommandHook(
        { type: "command", command: ".claude/hooks/prism-hook.sh", workspace },
        { payloadJson: "{}", event: HOOK_EVENTS.PRE_TOOL_USE, timeoutMilliseconds: 15_000, owner: OWNER },
      ));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({
        command: ".claude/hooks/prism-hook.sh",
        workspace: true,
        cwd: "/repo",
        owner: OWNER,
      });
      expect((init.headers as Record<string, string>)["x-workspace-override"]).toBeUndefined();
    });

    it("sends a sub-agent's worktree as the workspace override, so the sandbox admits its path", async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      });
      await asOwner(() => runCommandHook(
        {
          type: "command",
          command: "true",
          workspace: { ...workspace, cwd: "/worktrees/agent-1", worktreePath: "/worktrees/agent-1" },
        },
        { payloadJson: "{}", event: HOOK_EVENTS.STOP, timeoutMilliseconds: 5_000, owner: OWNER },
      ));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body)).cwd).toBe("/worktrees/agent-1");
      expect((init.headers as Record<string, string>)["x-workspace-override"]).toBe("/worktrees/agent-1");
    });

    it("keeps the file's own timeout past the stored hooks' 60 s ceiling, up to 10 minutes", () => {
      const stored = commandHook("true", { timeoutMilliseconds: 120_000 });
      const repository = commandHook("true", { timeoutMilliseconds: 120_000 }, { workspace });
      expect(resolveHookTimeout(stored)).toBe(HOOKS.MAX_TIMEOUT_MILLISECONDS);
      expect(resolveHookTimeout(repository)).toBe(120_000);
      expect(resolveHookTimeout(commandHook("true", { timeoutMilliseconds: 3_600_000 }, { workspace }))).toBe(
        600_000,
      );
    });

    it("is still refused for a user outside the owner list", async () => {
      const result = await asOwner(() => runCommandHook(
        { type: "command", command: "true", workspace },
        { payloadJson: "{}", event: HOOK_EVENTS.PRE_TOOL_USE, timeoutMilliseconds: 1_000, owner: "mallory" },
      ));
      expect(result).toMatchObject({ _handlerFailed: true, _reason: "command_owner_required" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
