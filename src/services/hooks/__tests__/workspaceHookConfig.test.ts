import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TOOLS_SERVICE_URL: "http://tools.test",
}));

import {
  fetchWorkspaceHooksConfig,
  invalidateWorkspaceHooksConfig,
  parseWorkspaceHooksFile,
  timeoutMillisecondsOf,
} from "#src/services/hooks/WorkspaceHookConfig";
import { WORKSPACE_HOOKS } from "#src/services/hooks/WorkspaceHookConstants";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// Discovery of a repository's hooks: the file schemas Claude Code
// and Codex write, what is skipped and why, seconds → milliseconds,
// and the ≤ 10 s per-root cache over tools-service's answer.
// ────────────────────────────────────────────────────────────

const FILE = "/repo/.prism/hooks.json";

/** paper-tiles' `.codex/hooks.json`, verbatim in shape. */
const CODEX_SHAPED = {
  description: "Paper Tiles' guards, shared with Claude Code.",
  hooks: {
    PreToolUse: [
      {
        matcher: "^(Bash|apply_patch)$",
        hooks: [
          {
            type: "command",
            command: 'f=".claude/hooks/codex-hook.sh"; [ -x "$f" ] && exec "$f"; exit 0',
            commandWindows: "wsl.exe -e .claude/hooks/codex-hook.sh",
            timeout: 15,
            statusMessage: "Paper Tiles guards",
          },
        ],
      },
    ],
    Stop: [{ hooks: [{ type: "command", command: "node stop.mjs", timeout: 45 }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: "node end.mjs", timeout: 3 }] }],
  },
};

/** `.claude/settings.json`'s hooks block: name lists, a Read matcher, no timeout. */
const CLAUDE_SHAPED = {
  hooks: {
    PreToolUse: [
      { matcher: "execute_command", hooks: [{ type: "command", command: "node pre.mjs" }] },
      { matcher: "read_file", hooks: [{ type: "command", command: "node pre-read.mjs", timeout: 10 }] },
    ],
    PostToolUse: [
      {
        matcher: "write_file|replace_in_file",
        hooks: [
          { type: "command", command: "node post-edit.mjs" },
          { type: "command", command: "node post-edit-2.mjs", timeout: 1.5 },
        ],
      },
    ],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "node prompt.mjs" }] }],
  },
};

describe("parseWorkspaceHooksFile", () => {
  beforeEach(() => {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("reads Codex's schema: matcher regex, seconds, statusMessage; commandWindows is not Prism's", () => {
    const { entries, skipped, error } = parseWorkspaceHooksFile(JSON.stringify(CODEX_SHAPED), FILE);
    expect(error).toBeUndefined();
    expect(skipped).toEqual([]);
    expect(entries).toEqual([
      {
        event: "PreToolUse",
        matcher: "^(Bash|apply_patch)$",
        command: CODEX_SHAPED.hooks.PreToolUse[0].hooks[0].command,
        timeoutMilliseconds: 15_000,
        statusMessage: "Paper Tiles guards",
      },
      { event: "Stop", matcher: "", command: "node stop.mjs", timeoutMilliseconds: 45_000 },
      { event: "SessionEnd", matcher: "", command: "node end.mjs", timeoutMilliseconds: 3_000 },
    ]);
  });

  it("keeps `async: true` (it runs in the background), and nothing else of an entry's extra fields", () => {
    const { entries } = parseWorkspaceHooksFile(
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { hooks: [{ type: "command", command: "log", async: true, once: true, commandWindows: "x" }] },
            { hooks: [{ type: "command", command: "gate", async: "yes" }] },
          ],
        },
      }),
      FILE,
    );
    expect(entries).toEqual([
      { event: "PostToolUse", matcher: "", command: "log", timeoutMilliseconds: 60_000, async: true },
      { event: "PostToolUse", matcher: "", command: "gate", timeoutMilliseconds: 60_000 },
    ]);
  });

  it("reads Claude Code's schema: name-list matchers, several handlers per group, the 60 s default", () => {
    const { entries } = parseWorkspaceHooksFile(JSON.stringify(CLAUDE_SHAPED), FILE);
    expect(entries.map(({ event, matcher, command, timeoutMilliseconds }) => [event, matcher, command, timeoutMilliseconds])).toEqual([
      ["PreToolUse", "execute_command", "node pre.mjs", 60_000],
      ["PreToolUse", "read_file", "node pre-read.mjs", 10_000],
      ["PostToolUse", "write_file|replace_in_file", "node post-edit.mjs", 60_000],
      ["PostToolUse", "write_file|replace_in_file", "node post-edit-2.mjs", 1_500],
      ["UserPromptSubmit", "", "node prompt.mjs", 60_000],
    ]);
  });

  it("converts `timeout` from seconds, defaults a missing or nonsensical one to 60 s, caps it at 10 min", () => {
    expect(timeoutMillisecondsOf(15)).toBe(15_000);
    expect(timeoutMillisecondsOf(0.25)).toBe(250);
    expect(timeoutMillisecondsOf(undefined)).toBe(WORKSPACE_HOOKS.DEFAULT_TIMEOUT_SECONDS * 1000);
    expect(timeoutMillisecondsOf(0)).toBe(60_000);
    expect(timeoutMillisecondsOf(-5)).toBe(60_000);
    expect(timeoutMillisecondsOf("15")).toBe(60_000);
    expect(timeoutMillisecondsOf(Number.NaN)).toBe(60_000);
    expect(timeoutMillisecondsOf(99_999)).toBe(WORKSPACE_HOOKS.MAX_TIMEOUT_MILLISECONDS);
  });

  it("skips, with a log line, an event Prism does not have — and keeps the rest of the file", () => {
    const { entries, skipped } = parseWorkspaceHooksFile(
      JSON.stringify({
        hooks: {
          Elicitation: [{ hooks: [{ type: "command", command: "x" }] }],
          Stop: [{ hooks: [{ type: "command", command: "node stop.mjs" }] }],
        },
      }),
      FILE,
    );
    expect(entries.map((entry) => entry.event)).toEqual(["Stop"]);
    expect(skipped).toEqual(['unknown event "Elicitation"']);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('unknown event "Elicitation"'));
  });

  it("accepts Prism's own events (TurnStart, PostToolBatch) alongside Claude Code's", () => {
    const { entries } = parseWorkspaceHooksFile(
      JSON.stringify({
        hooks: {
          TurnStart: [{ hooks: [{ type: "command", command: "a" }] }],
          PostToolBatch: [{ hooks: [{ type: "command", command: "b" }] }],
        },
      }),
      FILE,
    );
    expect(entries.map((entry) => entry.event)).toEqual(["TurnStart", "PostToolBatch"]);
  });

  it("skips handlers that are not commands, have no command, and groups without a hooks list", () => {
    const { entries, skipped } = parseWorkspaceHooksFile(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "write_file", hooks: [{ type: "prompt", prompt: "is $ARGUMENTS safe?" }] },
            { matcher: "write_file", hooks: [{ type: "command", command: "   " }, { type: "command" }] },
            { matcher: "write_file" },
            { matcher: 7, hooks: [{ type: "command", command: "x" }] },
            "not a group",
          ],
          Stop: { hooks: [] },
          SessionEnd: [{ matcher: null, hooks: [{ type: "command", command: "ok" }] }],
        },
      }),
      FILE,
    );
    expect(entries).toEqual([{ event: "SessionEnd", matcher: "", command: "ok", timeoutMilliseconds: 60_000 }]);
    expect(skipped).toEqual([
      'PreToolUse[0].hooks[0] is type "prompt"; only "command" runs',
      "PreToolUse[1].hooks[0] has no command",
      "PreToolUse[1].hooks[1] has no command",
      'PreToolUse[2] has no "hooks" list',
      "PreToolUse[3]'s matcher is not a string",
      'PreToolUse[4] has no "hooks" list',
      "Stop is not a list of matcher groups",
    ]);
  });

  it("skips a matcher that can never match instead of registering a dead hook", () => {
    const { entries, skipped } = parseWorkspaceHooksFile(
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "(unclosed", hooks: [{ type: "command", command: "x" }] },
            { matcher: "execute_command(git *)", hooks: [{ type: "command", command: "y" }] },
          ],
        },
      }),
      FILE,
    );
    expect(entries.map((entry) => entry.matcher)).toEqual(["execute_command(git *)"]);
    expect(skipped).toEqual(['PreToolUse[0]\'s matcher "(unclosed" can never match']);
  });

  it("reports text that is not JSON, or not an object, as an error with no entries", () => {
    for (const [content, error] of [
      ["{ not json", /not valid JSON/],
      ["[1, 2]", /not a JSON object/],
      ['{"hooks": []}', /"hooks" is not an object/],
    ] as const) {
      const parsed = parseWorkspaceHooksFile(content, FILE);
      expect(parsed.entries).toEqual([]);
      expect(parsed.error).toMatch(error);
    }
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it("reads a file with no hooks key as no hooks, not an error; a BOM is fine", () => {
    expect(parseWorkspaceHooksFile('{"description":"later"}', FILE)).toEqual({ entries: [], skipped: [] });
    const bom = parseWorkspaceHooksFile(`﻿${JSON.stringify(CODEX_SHAPED)}`, FILE);
    expect(bom.entries).toHaveLength(3);
  });

  it("stops at the per-file entry limit", () => {
    const many = Array.from({ length: WORKSPACE_HOOKS.MAX_ENTRIES_PER_FILE + 3 }, (_, index) => ({
      type: "command",
      command: `echo ${index}`,
    }));
    const { entries, skipped } = parseWorkspaceHooksFile(
      JSON.stringify({ hooks: { Stop: [{ hooks: many }] } }),
      FILE,
    );
    expect(entries).toHaveLength(WORKSPACE_HOOKS.MAX_ENTRIES_PER_FILE);
    expect(skipped).toHaveLength(3);
  });

  it("can read without logging (the settings page)", () => {
    parseWorkspaceHooksFile('{"hooks":{"Nope":[]}}', FILE, { log: false });
    parseWorkspaceHooksFile("{", FILE, { log: false });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("fetchWorkspaceHooksConfig", () => {
  const SHA = "b".repeat(64);
  const answer = {
    project: { path: FILE, dir: "/repo", exists: true, content: "{}", sha256: SHA },
    user: null,
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    invalidateWorkspaceHooksConfig();
    fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => answer }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    invalidateWorkspaceHooksConfig();
  });

  it("asks tools-service for the root's files, with the caller's identity", async () => {
    const config = await fetchWorkspaceHooksConfig("/repo/sub dir", {
      project: "prism-chat",
      username: "rodrigo",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://tools.test/agentic/hooks/config?root=%2Frepo%2Fsub%20dir");
    expect(init.headers).toMatchObject({ "x-project": "prism-chat", "x-username": "rodrigo" });
    expect(config).toEqual({
      root: "/repo/sub dir",
      user: null,
      project: { scope: "project", path: FILE, dir: "/repo", exists: true, content: "{}", sha256: SHA },
    });
  });

  it("drops a file reported missing, or without content or sha256", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        project: { path: FILE, dir: "/repo", exists: false, content: "", sha256: "" },
        user: { path: "/home/u/.prism/hooks.json", dir: "/home/u", exists: true, content: "{}" },
      }),
    });
    expect(await fetchWorkspaceHooksConfig("/repo")).toMatchObject({ project: null, user: null });
  });

  it("reuses a root's answer for at most 10 s, and shares one request between concurrent turns", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    await Promise.all([fetchWorkspaceHooksConfig("/repo"), fetchWorkspaceHooksConfig("/repo")]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-06T12:00:09.900Z"));
    await fetchWorkspaceHooksConfig("/repo");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-06T12:00:10.100Z"));
    await fetchWorkspaceHooksConfig("/repo");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await fetchWorkspaceHooksConfig("/other");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reads fresh when asked, and after an invalidation", async () => {
    await fetchWorkspaceHooksConfig("/repo");
    await fetchWorkspaceHooksConfig("/repo", { fresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    invalidateWorkspaceHooksConfig("/repo");
    await fetchWorkspaceHooksConfig("/repo");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects when tools-service cannot answer, and does not keep the failure", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "workspace agent rodrigo-wsl is offline" }),
    });
    await expect(fetchWorkspaceHooksConfig("/repo")).rejects.toThrow(/409: workspace agent rodrigo-wsl is offline/);
    // Not cached: the next turn asks again and gets the files.
    expect((await fetchWorkspaceHooksConfig("/repo")).project?.sha256).toBe(SHA);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
