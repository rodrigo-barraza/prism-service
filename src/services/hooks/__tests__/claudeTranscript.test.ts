import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  TurnTranscript,
  _resetTranscriptsForTests,
  assistantLine,
  claudeUsage,
  openTurnTranscript,
  toolResultLine,
  toolResultText,
  transcriptPathFor,
  userTextLine,
  type TranscriptTarget,
} from "#src/services/hooks/ClaudeTranscript";
import { CLAUDE_TRANSCRIPT } from "#src/services/hooks/WorkspaceHookConstants";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// The Claude-shaped transcript: Claude Code's JSONL line shapes,
// the order lines land in, mid-turn input, the reply that came
// with its own batch, and a writer that never breaks a turn.
// ────────────────────────────────────────────────────────────

const TARGET: TranscriptTarget = {
  conversationId: "conv-1",
  root: "/repo",
  project: "prism-chat",
  username: "rodrigo",
  model: "claude-opus-4-1",
};
const PATH = "/tmp/prism-1000/transcripts/conv-1.jsonl";

interface Append {
  url: string;
  headers: Record<string, string>;
  body: { lines: Array<Record<string, unknown>>; root: string };
}

function fakeToolsService() {
  const appends: Append[] = [];
  const fetchImplementation = vi.fn(async (url: string, init: RequestInit) => {
    appends.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return { ok: true, status: 200, json: async () => ({ path: PATH }) } as unknown as Response;
  });
  return { appends, fetchImplementation, lines: () => appends.flatMap((append) => append.body.lines) };
}

const transport = (fetchImplementation: unknown) => ({
  baseUrl: "http://tools.test",
  fetchImplementation: fetchImplementation as typeof fetch,
});

describe("Claude Code line shapes", () => {
  it("a user line: the prompt as string content, with the session, time, cwd and a uuid", () => {
    const line = userTextLine(TARGET, "Fix the build");
    expect(line).toEqual({
      type: "user",
      sessionId: "conv-1",
      timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      cwd: "/repo",
      uuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      isSidechain: false,
      message: { role: "user", content: "Fix the build" },
    });
  });

  it("an assistant line: the text, then a tool_use block per call", () => {
    const line = assistantLine(TARGET, "Running it.", [
      { id: "call-1", name: "execute_command", args: { command: "npm test", cwd: "web" } },
      { id: "call-2", name: "read_file", args: { path: "a.ts" } },
    ]);
    expect(line.type).toBe("assistant");
    expect(line.message).toEqual({
      role: "assistant",
      model: "claude-opus-4-1",
      content: [
        { type: "text", text: "Running it." },
        { type: "tool_use", id: "call-1", name: "execute_command", input: { command: "npm test", cwd: "web" } },
        { type: "tool_use", id: "call-2", name: "read_file", input: { path: "a.ts" } },
      ],
    });
    // No text: only the tool_use blocks.
    expect(assistantLine(TARGET, "  ", [{ id: "c", name: "x", args: {} }]).message.content).toEqual([
      { type: "tool_use", id: "c", name: "x", input: {} },
    ]);
  });

  it("a reply carries its call's token usage in Claude Code's names, and none when nothing was counted", () => {
    const usage = { inputTokens: 5, outputTokens: 40, cacheReadInputTokens: 1000, cacheCreationInputTokens: 100 };
    expect(assistantLine(TARGET, "Done.", [], usage).message.usage).toEqual({
      input_tokens: 5,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 40,
    });
    expect(assistantLine(TARGET, "Done.").message).not.toHaveProperty("usage");
    expect(claudeUsage({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })).toBeNull();
    expect(claudeUsage({ inputTokens: Number.NaN, outputTokens: 3 })).toEqual({
      input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 3,
    });
  });

  it("a tool_result line: one block per call in call order, the text the model read, is_error on failure", () => {
    const line = toolResultLine(
      TARGET,
      [
        { id: "call-1", name: "execute_command", args: {} },
        { id: "call-2", name: "read_file", args: {} },
        { id: "call-3", name: "read_file", args: {} },
      ],
      [
        { id: "call-2", name: "read_file", result: "file text" },
        { id: "call-1", name: "execute_command", result: { success: false, exitCode: 1, stderr: "boom" } },
      ],
    );
    expect(line.type).toBe("user");
    expect(line.message).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: '{"success":false,"exitCode":1,"stderr":"boom"}',
          is_error: true,
        },
        { type: "tool_result", tool_use_id: "call-2", content: "file text" },
        // A call with no result (blocked before it ran) reads as failed.
        { type: "tool_result", tool_use_id: "call-3", content: "null", is_error: true },
      ],
    });
  });

  it("caps a tool result at 32 KB and marks the cut", () => {
    const big = "x".repeat(CLAUDE_TRANSCRIPT.MAX_TOOL_RESULT_CHARS + 10);
    const text = toolResultText(big);
    expect(text.startsWith("x".repeat(CLAUDE_TRANSCRIPT.MAX_TOOL_RESULT_CHARS))).toBe(true);
    expect(text).toMatch(/…\[truncated at 32768 chars\]$/);
    expect(toolResultText("short")).toBe("short");
  });

  it("a sub-agent's lines are a sidechain carrying its id", () => {
    const line = userTextLine({ ...TARGET, conversationId: "sub-1", agentId: "sub-1" }, "task");
    expect(line).toMatchObject({ sessionId: "sub-1", isSidechain: true, agentId: "sub-1" });
  });
});

describe("TurnTranscript", () => {
  beforeEach(() => {
    _resetTranscriptsForTests();
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("appends the turn in order — prompt, batch (assistant, then tool_result), final answer — and learns the path", async () => {
    const service = fakeToolsService();
    const transcript = new TurnTranscript(TARGET, transport(service.fetchImplementation));
    expect(transcript.path).toBeNull();

    void transcript.appendPrompt("Run the tests");
    void transcript.appendBatch({
      text: "Running them.",
      toolCalls: [{ id: "call-1", name: "execute_command", args: { command: "npm test" } }],
      results: [{ id: "call-1", name: "execute_command", result: { success: true, stdout: "ok" } }],
      iteration: 1,
    });
    void transcript.appendFinal("All green.", [], 2);
    await transcript.flush();

    expect(service.appends.map((append) => append.url)).toEqual([
      "http://tools.test/agentic/transcripts/conv-1/append",
      "http://tools.test/agentic/transcripts/conv-1/append",
      "http://tools.test/agentic/transcripts/conv-1/append",
    ]);
    expect(service.appends[0].body.root).toBe("/repo");
    expect(service.appends[0].headers).toMatchObject({ "x-project": "prism-chat", "x-username": "rodrigo" });
    const lines = service.lines();
    expect(lines.map((line) => [line.type, (line.message as { content: unknown }).content])).toEqual([
      ["user", "Run the tests"],
      [
        "assistant",
        [
          { type: "text", text: "Running them." },
          { type: "tool_use", id: "call-1", name: "execute_command", input: { command: "npm test" } },
        ],
      ],
      ["user", [{ type: "tool_result", tool_use_id: "call-1", content: '{"success":true,"stdout":"ok"}' }]],
      ["assistant", [{ type: "text", text: "All green." }]],
    ]);
    expect(transcript.path).toBe(PATH);
    expect(transcriptPathFor("conv-1")).toBe(PATH);
  });

  it("chains appends: the next request waits for the previous one to land", async () => {
    let releaseFirst!: () => void;
    const order: string[] = [];
    const fetchImplementation = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { lines: Array<{ message: { content: unknown } }> };
      const label = String(body.lines[0]?.message.content);
      order.push(`start:${label}`);
      if (label === "first") await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push(`end:${label}`);
      return { ok: true, status: 200, json: async () => ({ path: PATH }) } as unknown as Response;
    });
    const transcript = new TurnTranscript(TARGET, transport(fetchImplementation));
    void transcript.appendPrompt("first");
    // A second turn's writer on the same conversation queues behind it too.
    const second = new TurnTranscript(TARGET, transport(fetchImplementation)).appendPrompt("second");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(["start:first"]);
    releaseFirst();
    await second;
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("a re-driven turn writes no prompt: an empty append only learns the path, and none once it is known", async () => {
    const service = fakeToolsService();
    const transcript = new TurnTranscript(TARGET, transport(service.fetchImplementation));
    await transcript.appendPrompt(null);
    expect(service.appends).toHaveLength(1);
    expect(service.appends[0].body.lines).toEqual([]);
    expect(transcript.path).toBe(PATH);

    const again = new TurnTranscript(TARGET, transport(service.fetchImplementation));
    await again.appendPrompt(null);
    expect(service.appends).toHaveLength(1);
  });

  it("a reply that came with its own batch is that batch's line, not a second one", async () => {
    const service = fakeToolsService();
    const transcript = new TurnTranscript(TARGET, transport(service.fetchImplementation));
    void transcript.appendBatch({
      text: "Posted it.",
      toolCalls: [{ id: "c1", name: "send_message", args: {} }],
      results: [{ id: "c1", name: "send_message", result: { success: true } }],
      iteration: 3,
    });
    void transcript.appendFinal("Posted it.", [], 3);
    await transcript.flush();
    expect(service.lines().filter((line) => line.type === "assistant")).toHaveLength(1);

    // The same words in a LATER pass are a new message.
    void transcript.appendBatch({
      text: "Done.",
      toolCalls: [{ id: "c2", name: "read_file", args: {} }],
      results: [{ id: "c2", name: "read_file", result: "x" }],
      iteration: 4,
    });
    void transcript.appendFinal("Done.", [], 5);
    await transcript.flush();
    expect(service.lines().filter((line) => line.type === "assistant")).toHaveLength(3);
  });

  it("writes input the turn took in mid-way where it entered — never the history's, never twice", async () => {
    const service = fakeToolsService();
    const transcript = new TurnTranscript(TARGET, transport(service.fetchImplementation));
    const earlier = { role: "user", content: "<user-update>old</user-update>", _turnInput: { id: "old-1" } };
    const messages: Array<Record<string, unknown>> = [earlier, { role: "user", content: "Watch the build" }];
    void transcript.appendPrompt("Watch the build", messages);

    const notification =
      "<task-notification>\n<task-id>monitor-ab12cd34</task-id>\n<event>\nBUILD FAILED\n</event>\n</task-notification>";
    messages.push(
      { role: "assistant", content: "" },
      { role: "user", content: notification, _turnInput: { id: "in-1", kind: "task_notification" } },
      { role: "system", content: "<hook-context>x</hook-context>" },
    );
    void transcript.appendBatch({
      text: "",
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "build.log" } }],
      results: [{ id: "c1", name: "read_file", result: "log" }],
      messages,
      iteration: 2,
    });
    void transcript.appendFinal("It failed on lint.", messages, 3);
    await transcript.flush();

    expect(service.lines().map((line) => [line.type, typeof (line.message as { content: unknown }).content])).toEqual([
      ["user", "string"], // the prompt
      ["user", "string"], // the notification, before the assistant line that followed it
      ["assistant", "object"],
      ["user", "object"], // tool_result
      ["assistant", "object"], // the final answer — the notification is not repeated
    ]);
    expect((service.lines()[1].message as { content: string }).content).toBe(notification);
  });

  it("never breaks the turn: a failed append is logged once, resolves, and the next one still goes out", async () => {
    let calls = 0;
    const fetchImplementation = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNREFUSED");
      if (calls === 2) return { ok: false, status: 404, json: async () => ({ error: "no route" }) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ path: PATH }) } as unknown as Response;
    });
    const transcript = new TurnTranscript(TARGET, transport(fetchImplementation));
    await expect(transcript.appendPrompt("one")).resolves.toBeNull();
    await expect(transcript.appendFinal("two", [], 1)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    await expect(transcript.appendFinal("three", [], 2)).resolves.toBe(PATH);
  });

  it("flush waits at most its budget for an append that hangs", async () => {
    const fetchImplementation = vi.fn(() => new Promise<Response>(() => {}));
    const transcript = new TurnTranscript(TARGET, transport(fetchImplementation));
    void transcript.appendPrompt("stuck");
    const started = Date.now();
    await expect(transcript.flush(30)).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("openTurnTranscript", () => {
  it("keeps none without tools-service, a workspace, or a conversation id the route accepts", () => {
    const base = { conversationId: "conv-1", agentConversationId: "conv-1" };
    expect(openTurnTranscript(base, { root: "/repo" }, { baseUrl: "" })).toBeNull();
    expect(openTurnTranscript(base, { root: null }, { baseUrl: "http://tools.test" })).toBeNull();
    expect(openTurnTranscript({}, { root: "/repo" }, { baseUrl: "http://tools.test" })).toBeNull();
    expect(
      openTurnTranscript({ conversationId: "bad/id" }, { root: "/repo" }, { baseUrl: "http://tools.test" }),
    ).toBeNull();
  });

  it("targets the conversation's file; a sub-agent its own, as a sidechain, routed by its checkout", () => {
    const root = openTurnTranscript(
      { conversationId: "conv-1", agentConversationId: "conv-1", project: "p", username: "u", resolvedModel: "m" },
      { root: "/repo" },
      { baseUrl: "http://tools.test" },
    );
    expect(root?.target).toEqual({
      conversationId: "conv-1",
      root: "/repo",
      cwd: "/repo",
      project: "p",
      username: "u",
      agentId: null,
      model: "m",
    });
    const subAgent = openTurnTranscript(
      { conversationId: "sub-1", agentConversationId: "sub-1", parentAgentConversationId: "conv-1" },
      { root: "/repo", cwd: "/tmp/prism-worktrees/sub-1" },
      { baseUrl: "http://tools.test" },
    );
    expect(subAgent?.target).toMatchObject({ conversationId: "sub-1", root: "/repo", agentId: "sub-1" });
    // Its lines say where it works.
    expect(userTextLine(subAgent!.target, "task").cwd).toBe("/tmp/prism-worktrees/sub-1");
  });
});
