/**
 * acpClientRuntime.test.ts — Prism as the ACP CLIENT (prompt 24, Landing 3).
 *
 * A sub-agent run on the `acp` runtime, through the REAL AgenticLoopService
 * → HarnessRegistry → AcpAgentRuntime, against a REAL external process: the
 * fake ACP agent in fixtures/ (built on the same pinned SDK, speaking ACP v1
 * on stdio). Approvals are decided through the real POST /agent/approve
 * handler. What is pinned:
 *
 *   - the agent's session updates become Prism sub-agent events, every one
 *     valid against the protocol (thinking, text, plan, a tool call with
 *     live output and a result, the cost, `done`), and its transcript is
 *     persisted ReAct-shaped with one request row;
 *   - its permission requests become approval cards a person answers —
 *     allow / deny / approve-all map to the options it offered, edits are
 *     refused, and nothing is auto-approved by default (not even under
 *     autoApprove); plan and don't-ask modes deny, bypass allows;
 *   - a stop cancels the prompt (and an open request), a crash or a missing
 *     command fails the run with a clean error naming the exit and stderr;
 *   - the process sees the base environment plus its allowlist, never
 *     prism-service's secrets;
 *   - who may run it, and where (owners, stored agents, sub-agents only).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import supertest from "supertest";

vi.mock("#config", () => ({
  MONGO_DB_NAME: "prism-test",
  TOOLS_SERVICE_URL: "http://localhost:5590",
  PROVIDER_LM_STUDIO: [],
  PROVIDER_VLLM: [],
  PROVIDER_OLLAMA: [],
  PROVIDER_LLAMA_CPP: [],
  PROVIDER_SGLANG: [],
  getModelRoleChainFromEnvironment: () => [],
}));
vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn(), request: vi.fn() },
}));
vi.mock("#src/services/ConversationStatusRegistry", () => ({
  default: { set: vi.fn(), patch: vi.fn(), delete: vi.fn(), remove: vi.fn() },
}));
vi.mock("#src/services/ConversationGenerationTracker", () => ({
  default: { register: vi.fn(), complete: vi.fn(), cleanup: vi.fn(), setEstimatedInputTokens: vi.fn() },
}));
const requestRows = vi.fn();
vi.mock("#src/services/RequestLogger", () => ({
  default: { log: (...args: unknown[]) => requestRows(...args) },
}));
const appendAndFinalizeMock = vi.fn();
vi.mock("#src/utils/ConversationUtilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/utils/ConversationUtilities")>()),
  appendAndFinalize: (...args: unknown[]) => appendAndFinalizeMock(...args),
}));
vi.mock("#src/services/WebhookEventBus", () => ({ default: { emit: vi.fn() } }));

import AgenticLoopService from "#src/services/AgenticLoopService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import HarnessRegistry from "#src/services/harnesses/HarnessRegistry";
import TurnInputMailbox from "#src/services/TurnInputMailbox";
import { ApprovalRegistry } from "#src/services/ApprovalRegistry";
import { handleApprovalDecision } from "#src/routes/ApprovalDecisionRoute";
import { PermissionModeHandle } from "#src/services/permissions/PermissionModeState";
import type { PermissionMode } from "#src/services/permissions/PermissionModes";
import { SharedCostBudget } from "#src/services/harnesses/lifecycle/CostBudgetEnforcer";
import { ACP_AGENT_OWNERS_ENV_VAR } from "#src/services/agents/AgentRuntime";
import { validateTurnEvent } from "#src/protocol/events";
import type { AgenticContext, ConversationMessage, LLMProvider } from "#src/services/harnesses/types";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fakeAcpAgent.ts", import.meta.url));
const OWNER = "acp-owner";
const AGENT_ID = "CUSTOM_FAKE_AGENT";

type Event = { type: string; [key: string]: unknown };

let workspace: string;
let conversationCounter = 0;

function registerAgent({
  args = [],
  envAllowlist = [],
  owner = OWNER,
  command = process.execPath,
}: { args?: string[]; envAllowlist?: string[]; owner?: string; command?: string } = {}) {
  AgentPersonaRegistry.registerCustom({
    agentId: AGENT_ID,
    name: "Fake Agent",
    description: "An external ACP agent.",
    runtime: "acp",
    acp: { command, args: [FAKE_AGENT, ...args], envAllowlist, owner },
  });
}

interface RunOptions {
  task: string;
  mode?: PermissionMode | null;
  /** The run's mode handle itself (a test that switches it); overrides `mode`. */
  handle?: PermissionModeHandle;
  unattended?: boolean;
  autoApprove?: boolean;
  username?: string;
  isSubAgent?: boolean;
  history?: ConversationMessage[];
  budget?: SharedCostBudget;
}

function startRun({
  task,
  mode = "default",
  unattended = false,
  autoApprove = false,
  username = OWNER,
  isSubAgent = true,
  history = [],
  budget,
  handle,
}: RunOptions) {
  conversationCounter += 1;
  const conversationId = `acp-sub-${conversationCounter}`;
  const events: Event[] = [];
  const abort = new AbortController();
  const context: AgenticContext = {
    provider: null as unknown as LLMProvider,
    providerName: "acp",
    resolvedModel: "Fake Agent",
    messages: [
      ...history.map((message) => ({ ...message, _alreadyPersisted: true })),
      { role: "system", content: "<operational-context>You are a sub-agent.</operational-context>" },
      { role: "user", content: task },
    ],
    options: {
      runtime: "acp",
      isSubAgent,
      autoApprove,
      ...(handle
        ? { _permissionMode: handle }
        : mode
          ? { _permissionMode: new PermissionModeHandle(mode, { unattended }) }
          : {}),
      ...(budget ? { _sharedCostBudget: budget } : {}),
    },
    agentConversationId: conversationId,
    parentAgentConversationId: "parent-agent-conversation",
    conversationId,
    parentConversationId: "parent-conversation",
    project: "coding",
    username,
    agent: AGENT_ID,
    emit: (event) => {
      events.push(event as Event);
    },
    signal: abort.signal,
    workspaceRoot: workspace,
  };
  const run = AgenticLoopService.runAgenticLoop(context);
  // Surface a rejection through the test's own await, never as unhandled.
  run.catch(() => {});
  return { run, events, abort, conversationId };
}

function textOf(events: Event[]): string {
  return events
    .filter((event) => event.type === "chunk")
    .map((event) => event.content as string)
    .join("");
}

async function waitForEvent(events: Event[], predicate: (event: Event) => boolean): Promise<Event> {
  let found: Event | undefined;
  await vi.waitFor(
    () => {
      found = events.find(predicate);
      expect(found).toBeDefined();
    },
    { timeout: 15_000, interval: 20 },
  );
  return found!;
}

function expectValidEvents(events: Event[]) {
  for (const event of events) {
    const result = validateTurnEvent(event);
    expect(result.success, `${JSON.stringify(event)}\n${result.error?.message ?? ""}`).toBe(true);
  }
}

const decisionApp = express();
decisionApp.use(express.json());
decisionApp.post("/agent/approve", (request, response) => {
  void handleApprovalDecision(request, response, "[test]");
});
const http = supertest(decisionApp);

describe("Prism as an ACP client: a sub-agent on an external agent process", () => {
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "prism-acp-worktree-"));
  });
  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });
  beforeEach(() => {
    process.env[ACP_AGENT_OWNERS_ENV_VAR] = OWNER;
    requestRows.mockReset();
    appendAndFinalizeMock.mockReset();
    registerAgent();
  });
  afterEach(() => {
    delete process.env[ACP_AGENT_OWNERS_ENV_VAR];
    AgentPersonaRegistry.unregister(AGENT_ID);
    ApprovalRegistry._clearAll();
  });

  it("is an external runtime of HarnessRegistry — never a harness a request can pick", () => {
    expect(HarnessRegistry.runtime("acp")?.id).toBe("acp");
    expect(HarnessRegistry.list().map((harness) => harness.id)).not.toContain("acp");
    expect(HarnessRegistry.get("acp")?.id).toBe("standard");
  });

  it("maps the agent's session into valid Prism sub-agent events, and keeps the run", async () => {
    const { run, events, conversationId } = startRun({ task: "SCENARIO=stream Read the notes." });
    const result = await run;

    const types = events.map((event) => event.type);
    expect(types).toContain("thinking");
    expect(types).toContain("todo_update");
    expect(textOf(events)).toBe("Looking at the file. All done: the file has two lines.");
    const calling = events.find((event) => event.type === "tool_execution" && event.status === "calling")!;
    expect(calling.tool).toEqual({
      id: "read-1",
      name: "Read notes.md",
      args: { title: "Read notes.md", kind: "read", input: { path: "notes.md" }, locations: ["/work/notes.md"] },
    });
    const output = events
      .filter((event) => event.type === "tool_output")
      .map((event) => event.data)
      .join("");
    expect(output).toBe("line one\nline two");
    const done = events.find((event) => event.type === "tool_execution" && event.status === "done")!;
    expect((done.tool as { result: unknown }).result).toEqual({ output: "line one\nline two" });
    expect(events.find((event) => event.type === "usage_update")?.estimatedCost).toBe(0.0123);
    const turnDone = events.find((event) => event.type === "done")!;
    expect(turnDone).toMatchObject({ provider: "acp", model: "Fake Agent", estimatedCost: 0.0123 });
    expectValidEvents(events);

    // The transcript: the step before the tool, then the report on its own.
    const assistants = result.messages.filter((message) => message.role === "assistant");
    expect(assistants.at(-1)!.content).toBe("All done: the file has two lines.");
    expect(assistants[0]).toMatchObject({ content: "Looking at the file. ", thinking: "Thinking it over." });
    expect(assistants[0].toolCalls?.[0]).toMatchObject({ id: "read-1", status: "done" });

    // Persisted to the sub-agent's own conversation, results as tool messages.
    expect(appendAndFinalizeMock).toHaveBeenCalledTimes(1);
    const [persistedId, , , persisted, meta] = appendAndFinalizeMock.mock.calls[0] as [
      string,
      string,
      string,
      Array<{ role: string; content?: string }>,
      Record<string, unknown>,
    ];
    expect(persistedId).toBe(conversationId);
    expect(persisted.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(meta).toMatchObject({ isSubAgent: true, settings: { provider: "acp", model: "Fake Agent", harness: "acp" } });
    expect(requestRows).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "acp", model: "Fake Agent", estimatedCost: 0.0123, success: true }),
    );
  });

  it("marks the cost unknown when the agent reports none", async () => {
    const { run, events } = startRun({ task: "SCENARIO=echo hello" });
    await run;
    expect(events.find((event) => event.type === "done")?.estimatedCost).toBeNull();
    expect(requestRows).toHaveBeenCalledWith(expect.objectContaining({ estimatedCost: null }));
  });

  describe("permission requests are Prism approvals", () => {
    async function answerFirstCard(
      events: Event[],
      conversationId: string,
      body: Record<string, unknown>,
    ) {
      const card = await waitForEvent(events, (event) => event.type === "approval_required");
      const response = await http
        .post("/agent/approve")
        .send({ conversationId, toolCallId: card.toolCallId, ...body });
      return { card, response };
    }

    it("a person allows: the agent gets its allow_once option, and the card shows the diff", async () => {
      const { run, events, conversationId } = startRun({ task: "SCENARIO=permission edit the notes" });
      const { card, response } = await answerFirstCard(events, conversationId, { decision: "allow" });
      expect(response.status).toBe(200);
      expect(card).toMatchObject({
        toolCallId: "edit-1",
        batchSize: 1,
        toolCall: { id: "edit-1", name: "Edit notes.md" },
        tier: 2,
        requestedBy: "external_agent",
        mode: "default",
      });
      expect(card.reason).toContain("Fake Agent");
      expect((card.preview as { diff: string }).diff).toContain("-old text");
      expect((card.preview as { diff: string }).diff).toContain("+new text");
      const result = await run;
      expect(textOf(events)).toBe("PERMISSION:selected:yes");
      expect(events).toContainEqual(
        expect.objectContaining({ type: "approval_decided", toolCallId: "edit-1", decision: "allow", source: "user" }),
      );
      const call = result.messages.flatMap((message) => message.toolCalls ?? []).find((toolCall) => toolCall.id === "edit-1");
      expect(call?._approval).toMatchObject({ isApproved: true, decidedBy: "user" });
      expectValidEvents(events);
    });

    it("a person denies: the agent gets reject_once and its call fails", async () => {
      const { run, events, conversationId } = startRun({ task: "SCENARIO=permission edit the notes" });
      await answerFirstCard(events, conversationId, { decision: "deny", reason: "not now" });
      await run;
      expect(textOf(events)).toBe("PERMISSION:selected:no");
      expect(events).toContainEqual(
        expect.objectContaining({ type: "tool_execution", status: "error", tool: expect.objectContaining({ id: "edit-1" }) }),
      );
    });

    it("'approve all for this conversation' gives the agent allow_always", async () => {
      const { run, events, conversationId } = startRun({ task: "SCENARIO=permission edit the notes" });
      await answerFirstCard(events, conversationId, { decision: "allow", scope: "conversation" });
      await run;
      expect(textOf(events)).toBe("PERMISSION:selected:always");
    });

    it("its arguments cannot be edited — the edit is refused and the card stays open", async () => {
      const { run, events, conversationId } = startRun({ task: "SCENARIO=permission edit the notes" });
      const { response } = await answerFirstCard(events, conversationId, {
        decision: "allow",
        editedArgs: { path: "other.md" },
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/external agent's call cannot be edited/);
      const allowed = await http.post("/agent/approve").send({ conversationId, toolCallId: "edit-1", decision: "allow" });
      expect(allowed.status).toBe(200);
      await run;
      expect(textOf(events)).toBe("PERMISSION:selected:yes");
    });

    it("is never auto-approved by default — autoApprove (full auto) still asks a person", async () => {
      const { run, events, conversationId } = startRun({
        task: "SCENARIO=permission edit the notes",
        autoApprove: true,
      });
      await answerFirstCard(events, conversationId, { decision: "allow" });
      await run;
      expect(textOf(events)).toBe("PERMISSION:selected:yes");
    });

    it.each([
      ["plan", false, "selected:no"],
      ["dontAsk", false, "selected:no"],
      ["default", true, "selected:no"],
      ["bypass", false, "selected:yes"],
    ] as const)("%s mode (unattended: %s) answers without a card: %s", async (mode, unattended, answer) => {
      const { run, events } = startRun({ task: "SCENARIO=permission edit the notes", mode, unattended });
      await run;
      expect(events.some((event) => event.type === "approval_required")).toBe(false);
      expect(textOf(events)).toBe(`PERMISSION:${answer}`);
      expectValidEvents(events);
    });
  });

  it("plan mode selects the agent's own plan mode", async () => {
    const { run, events } = startRun({ task: "SCENARIO=mode", mode: "plan" });
    await run;
    expect(textOf(events)).toBe("MODE:plan");
  });

  it("a switch into plan mode while it works follows into the agent's own plan mode", async () => {
    const handle = new PermissionModeHandle("default");
    const { run, events, conversationId } = startRun({ task: "SCENARIO=slow-echo first", handle });
    await waitForEvent(events, (event) => event.type === "status" && event.message === "iteration_progress");
    handle.set("plan", "user");
    expect(TurnInputMailbox.post(conversationId, { kind: "agent_message", text: "SCENARIO=mode" }).accepted).toBe(true);
    await run;
    expect(textOf(events).endsWith("MODE:plan")).toBe(true);
  });

  it("a stop sends session/cancel: the prompt ends cancelled, without `done`", async () => {
    const { run, events, abort } = startRun({ task: "SCENARIO=cancel keep going" });
    await waitForEvent(events, (event) => event.type === "chunk" && event.content === "WORKING");
    abort.abort();
    await run;
    expect(textOf(events)).toBe("WORKINGCANCEL RECEIVED");
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it("a stop while a card is open answers the request `cancelled` and lapses the card", async () => {
    const { run, events, abort, conversationId } = startRun({ task: "SCENARIO=cancel-permission" });
    await waitForEvent(events, (event) => event.type === "approval_required");
    abort.abort();
    await run;
    expect(textOf(events)).toBe("PERMISSION:cancelled");
    expect((await AgenticLoopService.getPendingApproval(conversationId)).isPending).toBe(false);
  });

  it("a process that dies mid-prompt fails the run with its exit code and stderr", async () => {
    const { run } = startRun({ task: "SCENARIO=crash" });
    await expect(run).rejects.toThrow(/Fake Agent exited with code 3 during the prompt\..*the fake agent broke on purpose/s);
    expect(appendAndFinalizeMock).toHaveBeenCalledTimes(1);
    expect(requestRows).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it("a command that is not installed fails cleanly", async () => {
    registerAgent({ command: join(workspace, "no-such-agent") });
    const { run } = startRun({ task: "SCENARIO=echo" });
    await expect(run).rejects.toThrow(/Fake Agent could not be started \(ENOENT\).*installed on the prism-service host/s);
  });

  it("an agent that needs signing in, or speaks another protocol version, fails cleanly", async () => {
    registerAgent({ args: ["--init=auth"] });
    await expect(startRun({ task: "SCENARIO=echo" }).run).rejects.toThrow(
      /Fake Agent is not signed in \(it offers: Fake login\)/,
    );
    registerAgent({ args: ["--init=v2"] });
    await expect(startRun({ task: "SCENARIO=echo" }).run).rejects.toThrow(
      /speaks ACP version 2; Prism implements version 1/,
    );
  });

  it("the process gets the base environment and its allowlist — never prism-service's secrets", async () => {
    process.env.PRISM_TEST_SECRET_TOKEN = "hunter2";
    process.env.ANTHROPIC_API_KEY = "sk-test-secret";
    process.env.ACP_TEST_ALLOWED = "yes";
    try {
      registerAgent({ envAllowlist: ["ACP_TEST_ALLOWED"] });
      const { run, events } = startRun({ task: "SCENARIO=env" });
      await run;
      const names = JSON.parse(textOf(events).slice("ENV:".length)) as string[];
      expect(names).toContain("ACP_TEST_ALLOWED");
      expect(names).toContain("PATH");
      expect(names).not.toContain("PRISM_TEST_SECRET_TOKEN");
      expect(names).not.toContain("ANTHROPIC_API_KEY");
      expect(names).not.toContain(ACP_AGENT_OWNERS_ENV_VAR);
    } finally {
      delete process.env.PRISM_TEST_SECRET_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ACP_TEST_ALLOWED;
    }
  });

  it("a follow-up the parent sends while it works becomes the next prompt", async () => {
    const { run, events, conversationId } = startRun({ task: "SCENARIO=slow-echo first" });
    await vi.waitFor(() => expect(TurnInputMailbox.isOpen(conversationId)).toBe(true));
    expect(
      TurnInputMailbox.post(conversationId, { kind: "agent_message", text: "and a follow-up" }).accepted,
    ).toBe(true);
    const result = await run;
    expect(textOf(events)).toBe("ECHO:<operational-context>You are a sub-agent.</operational-context>\n\nSCENARIO=slow-echo firstECHO:and a follow-up");
    expect(result.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "SCENARIO=slow-echo first",
      "and a follow-up",
    ]);
  });

  it("a continuation recalls the earlier runs' transcript in its first prompt", async () => {
    const { run, events } = startRun({
      task: "one more thing",
      history: [
        { role: "user", content: "the first task" },
        { role: "assistant", content: "the first report" },
      ],
    });
    await run;
    const echoed = textOf(events);
    expect(echoed).toContain("You are continuing earlier work on this task");
    expect(echoed).toContain("Task:\nthe first task");
    expect(echoed).toContain("Your report:\nthe first report");
    expect(echoed.endsWith("one more thing")).toBe(true);
  });

  it("a reported cost counts against the tree's budget, and the cap stops the prompt", async () => {
    const budget = new SharedCostBudget(0.01);
    const { run, events } = startRun({ task: "SCENARIO=stream", budget });
    await run;
    expect(budget.totalSpentDollars()).toBe(0.0123);
    expect(events).toContainEqual(expect.objectContaining({ type: "status", message: "cost_limit_reached" }));
    expectValidEvents(events);
  });

  describe("who may run it", () => {
    it("only in a turn of an owner", async () => {
      await expect(startRun({ task: "SCENARIO=echo", username: "someone-else" }).run).rejects.toThrow(
        /runs only in turns of the users in PRISM_ACP_AGENT_OWNERS; "someone-else" is not one/,
      );
    });

    it("only with a launch configuration an owner wrote", async () => {
      registerAgent({ owner: "former-owner" });
      await expect(startRun({ task: "SCENARIO=echo" }).run).rejects.toThrow(
        /written by "former-owner", who is not in PRISM_ACP_AGENT_OWNERS/,
      );
    });

    it("never when nobody is an owner", async () => {
      delete process.env[ACP_AGENT_OWNERS_ENV_VAR];
      await expect(startRun({ task: "SCENARIO=echo" }).run).rejects.toThrow(/PRISM_ACP_AGENT_OWNERS/);
    });

    it("only as a sub-agent", async () => {
      await expect(startRun({ task: "SCENARIO=echo", isSubAgent: false }).run).rejects.toThrow(
        /runs only as a sub-agent/,
      );
    });

    it("only for a stored agent — a workspace file never names a runtime", async () => {
      AgentPersonaRegistry.registerCustom(
        { agentId: AGENT_ID, name: "Fake Agent", runtime: "acp", acp: { command: process.execPath, owner: OWNER } },
        { source: "file" },
      );
      AgentPersonaRegistry.unregister(AGENT_ID);
      try {
        await expect(startRun({ task: "SCENARIO=echo" }).run).rejects.toThrow(
          /not a stored custom agent with runtime acp/,
        );
      } finally {
        AgentPersonaRegistry.useAgentDefinitionFiles(() => []);
      }
    });
  });
});
