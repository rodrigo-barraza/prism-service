/**
 * acpServer.conformance.test.ts — the ACP server as an editor sees it.
 *
 * Spawns `node src/acp/server.ts` against a stand-in prism-service
 * (mockPrism.ts, replaying protocol events) and drives it with a scripted
 * JSON-RPC client over its stdio pipes. Every message the server writes is
 * checked against ACP's own schemas (the SDK's generated zod), and every
 * event the mock sends against Prism's.
 *
 *   initialize → session/new → session/prompt → updates → a permission
 *   round-trip → set_mode → cancel; questions, plans, errors, decisions made
 *   elsewhere; malformed JSON-RPC answered with errors, never a crash.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnEvent } from "#src/protocol/events";
import { SERVICE_ROOT } from "../../protocol/__tests__/siblingCheckout.ts";
import { MockPrism, type ScriptedTurn } from "./mockPrism.ts";

type Json = Record<string, unknown>;
interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string; data?: unknown };
}
type Schema = { safeParse(value: unknown): { success: boolean; error?: { issues: unknown } } };

const SERVER = join(SERVICE_ROOT, "src/acp/server.ts");
const acpSchemas = (await import(
  pathToFileURL(join(SERVICE_ROOT, "node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js")).href
)) as Record<string, Schema>;

/** The ACP schema each inbound method's params, or each outbound method's result, must match. */
const PARAMS_SCHEMA: Record<string, string> = {
  "session/update": "zSessionNotification",
  "session/request_permission": "zRequestPermissionRequest",
  "elicitation/create": "zCreateElicitationRequest",
};
const RESULT_SCHEMA: Record<string, string> = {
  initialize: "zInitializeResponse",
  "session/new": "zNewSessionResponse",
  "session/prompt": "zPromptResponse",
  "session/set_mode": "zSetSessionModeResponse",
};

/**
 * The SDK's zod accepts unknown enum values (ACP is forward-compatible), so
 * the enums this server writes are checked against the JSON Schema's
 * constants — and only the STABLE session updates are allowed.
 */
const jsonSchema = JSON.parse(
  readFileSync(join(SERVICE_ROOT, "node_modules/@agentclientprotocol/sdk/schema/schema.json"), "utf8"),
) as { $defs: Record<string, { oneOf?: Array<{ const?: string; description?: string; properties?: Json }> }> };
const constants = (name: string, stableOnly = false) =>
  new Set(
    (jsonSchema.$defs[name]?.oneOf ?? [])
      .filter((option) => !stableOnly || !option.description?.includes("UNSTABLE"))
      .map((option) => option.const ?? ((option.properties?.sessionUpdate as { const?: string } | undefined)?.const ?? "")),
  );
const ENUMS = {
  sessionUpdate: constants("SessionUpdate", true),
  status: constants("ToolCallStatus"),
  kind: constants("ToolKind"),
  optionKind: constants("PermissionOptionKind"),
  stopReason: constants("StopReason"),
  entryStatus: constants("PlanEntryStatus"),
  entryPriority: constants("PlanEntryPriority"),
};

/** Enum violations in one message the server wrote. */
function enumViolations(method: string, value: Json): string[] {
  const problems: string[] = [];
  const expectIn = (set: Set<string>, field: string, actual: unknown) => {
    if (actual !== undefined && actual !== null && !set.has(String(actual))) problems.push(`${method}: ${field}=${String(actual)}`);
  };
  const toolFields = (toolCall: Json) => {
    expectIn(ENUMS.status, "status", toolCall.status);
    expectIn(ENUMS.kind, "kind", toolCall.kind);
  };
  if (method === "session/update") {
    const update = value.update as Json;
    expectIn(ENUMS.sessionUpdate, "sessionUpdate", update.sessionUpdate);
    toolFields(update);
    for (const entry of (update.entries as Json[] | undefined) ?? []) {
      expectIn(ENUMS.entryStatus, "entry.status", entry.status);
      expectIn(ENUMS.entryPriority, "entry.priority", entry.priority);
    }
  } else if (method === "session/request_permission") {
    toolFields(value.toolCall as Json);
    for (const option of value.options as Json[]) expectIn(ENUMS.optionKind, "option.kind", option.kind);
  } else if (method === "session/prompt result") {
    expectIn(ENUMS.stopReason, "stopReason", value.stopReason);
  }
  return problems;
}

function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), milliseconds)),
  ]);
}

/** A scripted ACP client on the server's stdin/stdout. */
class StdioClient {
  readonly received: Message[] = [];
  readonly violations: Array<{ what: string; issues: unknown }> = [];
  stderr = "";
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<string | number, { method: string; resolve: (message: Message) => void }>();
  private readonly watchers: Array<{ test: (message: Message) => boolean; resolve: (message: Message) => void }> = [];
  /** Answers to the server's requests, by method. */
  readonly handlers = new Map<string, (params: Json, id: string | number) => Promise<Json> | Json>();

  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk: Buffer) => (this.stderr += chunk.toString()));
    let buffered = "";
    this.child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim()) this.receive(JSON.parse(line) as Message);
        newline = buffered.indexOf("\n");
      }
    });
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  private check(what: string, schemaName: string | undefined, value: unknown): void {
    if (!schemaName) return;
    const result = acpSchemas[schemaName]!.safeParse(value);
    if (!result.success) this.violations.push({ what, issues: result.error?.issues });
    const problems = enumViolations(what, value as Json);
    if (problems.length > 0) this.violations.push({ what, issues: problems });
  }

  private receive(message: Message): void {
    this.received.push(message);
    if (message.jsonrpc !== "2.0") this.violations.push({ what: "jsonrpc version", issues: message });
    if (message.method) {
      this.check(message.method, PARAMS_SCHEMA[message.method], message.params);
      if (message.id !== undefined && message.id !== null) void this.answer(message);
    } else if (message.id !== undefined && message.id !== null && this.pending.has(message.id)) {
      const { method, resolve } = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      if (message.result !== undefined) this.check(`${method} result`, RESULT_SCHEMA[method], message.result);
      resolve(message);
    }
    for (const watcher of [...this.watchers]) {
      if (watcher.test(message)) {
        this.watchers.splice(this.watchers.indexOf(watcher), 1);
        watcher.resolve(message);
      }
    }
  }

  private async answer(message: Message): Promise<void> {
    const handler = this.handlers.get(message.method!);
    if (!handler) {
      this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not handled" } });
      return;
    }
    const result = await handler(message.params ?? {}, message.id!);
    this.write({ jsonrpc: "2.0", id: message.id, result });
  }

  write(message: unknown): void {
    this.writeLine(JSON.stringify(message));
  }

  writeLine(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  request(method: string, params: Json, timeout = 10_000): Promise<Message> {
    const id = this.nextId++;
    const response = new Promise<Message>((resolve) => this.pending.set(id, { method, resolve }));
    this.write({ jsonrpc: "2.0", id, method, params });
    return within(response, timeout, `${method} response`);
  }

  notify(method: string, params: Json): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  /** The next received message matching `test` (one already received counts). */
  waitFor(test: (message: Message) => boolean, label: string, timeout = 10_000): Promise<Message> {
    const seen = this.received.find(test);
    if (seen) return Promise.resolve(seen);
    return within(new Promise((resolve) => this.watchers.push({ test, resolve })), timeout, label);
  }

  updates(sessionId: string): Json[] {
    return this.received
      .filter((message) => message.method === "session/update" && message.params?.sessionId === sessionId)
      .map((message) => message.params!.update as Json);
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

const RECORDED = readFileSync(join(SERVICE_ROOT, "tests/fixtures/sse-transcripts/live-agent-tool-call.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as TurnEvent & Json);

/** The recorded live turn, re-addressed to the conversation being driven and paused at its approval. */
async function replayRecordedTurn(turn: ScriptedTurn): Promise<void> {
  const conversationId = String(turn.body.conversationId);
  for (const recorded of RECORDED.slice(1)) {
    const event = { ...recorded } as TurnEvent & Json;
    if ("conversationId" in event) event.conversationId = conversationId;
    if (event.type === "approval_decided") {
      const decision = await turn.next("/agent/approve");
      expect(decision.body).toMatchObject({ toolCallId: event.toolCallId, batchId: event.batchId });
      event.decision = decision.body.decision as "allow" | "deny";
    }
    turn.send(event);
  }
  turn.reply("The International Space Station is over the North Pacific.");
}

const TOOL_ID = "google-toolCall-44c324a0-d22c-4459-ac91-53ec59c17063";
const text = (content: string) => [{ type: "text", text: content }];

/** The tool call id a permission request (or update) is about. */
const toolCallIdOf = (message: Message) => (message.params?.toolCall as Json | undefined)?.toolCallId;

/** Index of the last received message matching `test`, or -1. */
function lastIndexWhere(messages: Message[], test: (message: Message) => boolean): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (test(messages[index]!)) return index;
  return -1;
}

describe("ACP server — malformed JSON-RPC is answered, not fatal", () => {
  const mock = new MockPrism();
  let client: StdioClient;

  beforeAll(async () => {
    await mock.start();
    client = new StdioClient({ PRISM_URL: mock.url });
  });
  afterAll(async () => {
    client.close();
    await mock.close();
  });

  it("answers parse errors, invalid requests, unknown methods and bad params with JSON-RPC errors", async () => {
    client.writeLine("{ this is not json");
    const parseError = await client.waitFor((message) => message.error?.code === -32700, "parse error");
    expect(parseError).toMatchObject({ id: null, error: { code: -32700 } });

    client.writeLine("42");
    await client.waitFor((message) => message.error?.code === -32600, "invalid request");

    const unknown = await client.request("session/teleport", {});
    expect(unknown.error?.code).toBe(-32601);

    const badParams = await client.request("session/new", { cwd: 5 });
    expect(badParams.error?.code).toBe(-32602);

    const noSession = await client.request("session/prompt", { sessionId: "nope", prompt: text("hi") });
    expect(noSession.error?.code).toBe(-32002);

    const unavailable = await client.request("session/set_mode", { sessionId: "nope", modeId: "plan" });
    expect(unavailable.error?.code).toBe(-32002);
  });

  it("keeps serving afterwards", async () => {
    const initialized = await client.request("initialize", { protocolVersion: 1 });
    expect(initialized.result).toMatchObject({ protocolVersion: 1 });
    expect(client.alive).toBe(true);
    expect(client.violations).toEqual([]);
  });
});

describe("ACP server — a session, end to end", () => {
  const mock = new MockPrism();
  let client: StdioClient;
  let sessionId = "";
  const cwd = "/tmp/acp-project";

  beforeAll(async () => {
    await mock.start();
    client = new StdioClient({
      PRISM_URL: mock.url,
      PRISM_PROJECT: "prism-test",
      PRISM_USERNAME: "acp-test",
      PRISM_PROVIDER: "google",
      PRISM_MODEL: "gemini-test",
    });
  });
  afterAll(async () => {
    client.close();
    await mock.close();
  });

  it("initializes: protocol v1, prompt capabilities, no auth", async () => {
    const response = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "scripted-client", version: "1.0.0" },
    });
    expect(response.result).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true } },
      authMethods: [],
      agentInfo: { name: "prism" },
    });
  });

  it("session/new mints a conversation and reports the permission modes the user may pick", async () => {
    const response = await client.request("session/new", { cwd, mcpServers: [] });
    sessionId = String(response.result?.sessionId);
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.result?.modes).toEqual({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Ask", description: "Read-only tools run; writes ask." },
        { id: "plan", name: "Plan", description: "Read-only tools only." },
        { id: "acceptEdits", name: "Accept edits", description: "Edits run." },
      ],
    });
    const [modeRequest] = mock.requestsTo("/permissions/mode");
    expect(modeRequest?.headers).toMatchObject({ "x-project": "prism-test", "x-username": "acp-test" });
  });

  it("session/prompt streams the turn, asks permission for the tool, and relays the answer", async () => {
    mock.scripts.push(replayRecordedTurn);
    let permissionRequest: Json | null = null;
    client.handlers.set("session/request_permission", (params) => {
      permissionRequest = params;
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });

    const response = await client.request("session/prompt", { sessionId, prompt: text("Where is the ISS?") });
    expect(response.result).toEqual({ stopReason: "end_turn", _meta: { prism: { conversationId: sessionId, sessionCostUsd: 0.01647052 } } });

    const [turn] = mock.requestsTo("/agent");
    expect(turn?.body).toMatchObject({
      provider: "google",
      model: "gemini-test",
      conversationId: sessionId,
      workspaceRoot: cwd,
      messages: [{ role: "user", content: "Where is the ISS?" }],
      conversationMeta: { title: "Where is the ISS?" },
    });
    expect(turn?.body).not.toHaveProperty("permissionMode");

    expect(permissionRequest).toMatchObject({
      sessionId,
      toolCall: { toolCallId: TOOL_ID, status: "pending", kind: "read" },
    });
    expect((permissionRequest!.options as Json[]).map((option) => option.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
      "reject_always",
    ]);
    const [approval] = mock.requestsTo("/agent/approve");
    expect(approval?.body).toEqual({
      conversationId: sessionId,
      toolCallId: TOOL_ID,
      batchId: "c6ce1858-d92b-440d-9c2c-74c6147b27f0",
      decision: "allow",
      scope: "call",
    });

    const updates = client.updates(sessionId);
    const answer = updates
      .filter((update) => update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.content as { text: string }).text)
      .join("");
    expect(answer).toContain("North Pacific Ocean");
    const toolStatuses = updates
      .filter((update) => update.toolCallId === TOOL_ID)
      .map((update) => `${String(update.sessionUpdate)}:${String(update.status)}`);
    expect(toolStatuses[0]).toBe("tool_call:pending");
    expect(toolStatuses.at(-1)).toBe("tool_call_update:completed");
    expect(updates.some((update) => update.sessionUpdate === "agent_thought_chunk")).toBe(true);
    expect(updates.some((update) => update.sessionUpdate === "usage_update")).toBe(true);

    // ACP: every update of a turn precedes its prompt response.
    const responseIndex = client.received.indexOf(response);
    const lastUpdateIndex = lastIndexWhere(client.received, (message) => message.method === "session/update");
    expect(lastUpdateIndex).toBeLessThan(responseIndex);
    expect(mock.invalidEvents).toEqual([]);
  });

  it("session/set_mode switches the conversation's permission mode; an unavailable mode is refused", async () => {
    const response = await client.request("session/set_mode", { sessionId, modeId: "acceptEdits" });
    expect(response.result).toEqual({});
    expect(mock.requestsTo("/permissions/mode").at(-1)).toMatchObject({
      method: "PUT",
      body: { conversationId: sessionId, mode: "acceptEdits" },
    });
    const refused = await client.request("session/set_mode", { sessionId, modeId: "bypass" });
    expect(refused.error?.code).toBe(-32602);
  });

  it("sends the served history with the next prompt; 'always deny' saves a rule; session/cancel stops the turn", async () => {
    mock.scripts.push(async (turn) => {
      const conversationId = String(turn.body.conversationId);
      turn.send({ type: "user_message", role: "user", content: "Write a file", conversationId, timestamp: 1 });
      const tool = { id: "w1", name: "write_file", args: { path: "notes.md", content: "hi" } };
      turn.send({ type: "tool_execution", status: "calling", tool });
      turn.send({
        type: "approval_required",
        toolCallId: "w1",
        batchId: "b2",
        batchSize: 1,
        toolCall: tool,
        preview: { kind: "diff", path: "notes.md", diff: "--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+hi", isNewFile: true },
        tier: 2,
        tierLabel: "write",
      });
      const decision = await turn.next("/agent/approve");
      turn.send({ type: "approval_decided", toolCallId: "w1", batchId: "b2", decision: decision.body.decision as "deny", scope: "call", source: "user" });
      turn.send({ type: "chunk", content: "Understood, I will not write it." });
      await turn.stopped;
    });
    client.handlers.set("session/request_permission", () => ({ outcome: { outcome: "selected", optionId: "deny-always" } }));

    const prompt = client.request("session/prompt", { sessionId, prompt: text("Write a file") });
    await client.waitFor(
      (message) =>
        message.method === "session/update" &&
        (message.params?.update as Json | undefined)?.sessionUpdate === "agent_message_chunk" &&
        JSON.stringify(message.params).includes("I will not write it"),
      "the reply after the denial",
    );
    client.notify("session/cancel", { sessionId });
    const response = await prompt;
    expect(response.result).toMatchObject({ stopReason: "cancelled" });

    const second = mock.requestsTo("/agent")[1]!;
    expect(second.body.permissionMode).toBe("acceptEdits");
    expect(second.body).not.toHaveProperty("conversationMeta");
    expect((second.body.messages as Json[]).map((message) => [message.role, message.content])).toEqual([
      ["user", "Where is the ISS?"],
      ["assistant", "The International Space Station is over the North Pacific."],
      ["user", "Write a file"],
    ]);
    expect(mock.requestsTo("/permissions/rules").at(-1)?.body).toEqual({
      rule: "write_file(*)",
      decision: "deny",
      scope: "conversation",
      conversationId: sessionId,
      origin: "approval",
    });
    expect(mock.requestsTo("/agent/approve").at(-1)?.body).toMatchObject({ toolCallId: "w1", decision: "deny" });
    expect(mock.requestsTo("/agent/stop").at(-1)?.body).toEqual({ conversationId: sessionId });

    const newFile = client.received.find(
      (message) => message.method === "session/request_permission" && toolCallIdOf(message) === "w1",
    );
    expect((newFile?.params?.toolCall as Json | undefined)?.content).toEqual([
      { type: "diff", path: "/tmp/acp-project/notes.md", oldText: null, newText: "hi" },
    ]);
  });

  it("cancelling while a permission request is open: the client answers cancelled, nothing is approved", async () => {
    let answerCancelled: () => void = () => {};
    client.handlers.set(
      "session/request_permission",
      () => new Promise<Json>((resolve) => (answerCancelled = () => resolve({ outcome: { outcome: "cancelled" } }))),
    );
    mock.scripts.push(async (turn) => {
      const tool = { id: "x1", name: "execute_shell", args: { command: "rm -rf build" } };
      turn.send({ type: "tool_execution", status: "calling", tool });
      turn.send({ type: "approval_required", toolCallId: "x1", batchId: "b3", batchSize: 1, toolCall: tool });
      await turn.stopped;
    });
    const approvalsBefore = mock.requestsTo("/agent/approve").length;

    const prompt = client.request("session/prompt", { sessionId, prompt: text("Clean the build") });
    await client.waitFor(
      (message) => message.method === "session/request_permission" && toolCallIdOf(message) === "x1",
      "the permission request",
    );
    client.notify("session/cancel", { sessionId });
    answerCancelled();
    const response = await prompt;

    expect(response.result).toMatchObject({ stopReason: "cancelled" });
    expect(mock.requestsTo("/agent/approve")).toHaveLength(approvalsBefore);
    const cancelled = client.updates(sessionId).filter((update) => update.toolCallId === "x1").at(-1);
    expect(cancelled).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
    expect(client.received.indexOf(response)).toBeGreaterThan(
      lastIndexWhere(client.received, (message) => message.method === "session/update"),
    );
  });

  it("withdraws its request when the call is decided elsewhere (the Prism web UI)", async () => {
    client.handlers.set("session/request_permission", () => new Promise<Json>(() => {}));
    mock.scripts.push(async (turn) => {
      const tool = { id: "y1", name: "read_file", args: { path: "README.md" } };
      turn.send({ type: "tool_execution", status: "calling", tool });
      turn.send({ type: "approval_required", toolCallId: "y1", batchId: "b4", batchSize: 1, toolCall: tool });
      // Decided in the web UI while the editor is still showing the request.
      await client.waitFor(
        (message) => message.method === "session/request_permission" && toolCallIdOf(message) === "y1",
        "the permission request",
      );
      turn.send({ type: "approval_decided", toolCallId: "y1", batchId: "b4", decision: "allow", scope: "call", source: "user" });
      turn.send({ type: "tool_execution", status: "done", tool: { ...tool, result: "# Readme" } });
      turn.send({ type: "chunk", content: "It is a readme." });
      turn.send({ type: "done", provider: "google", model: "gemini-test", usage: null, estimatedCost: null, totalTime: 1 });
    });
    const approvalsBefore = mock.requestsTo("/agent/approve").length;

    const response = await client.request("session/prompt", { sessionId, prompt: text("Read the readme") });
    expect(response.result).toMatchObject({ stopReason: "end_turn" });
    const permission = client.received.find(
      (message) => message.method === "session/request_permission" && toolCallIdOf(message) === "y1",
    );
    const withdrawn = client.received.find(
      (message) => message.method === "$/cancel_request" && message.params?.requestId === permission?.id,
    );
    expect(withdrawn).toBeDefined();
    expect(mock.requestsTo("/agent/approve")).toHaveLength(approvalsBefore);
  });

  it("asks a question through permission options when the client has no forms, and approves a plan", async () => {
    client.handlers.set("session/request_permission", (params) => {
      const toolCall = params.toolCall as Json;
      if (String(toolCall.toolCallId).startsWith("question/")) return { outcome: { outcome: "selected", optionId: "option-1" } };
      return { outcome: { outcome: "selected", optionId: "allow" } };
    });
    mock.scripts.push(async (turn) => {
      turn.send({
        type: "user_question",
        questionId: "q-1",
        blocking: true,
        context: null,
        questions: [
          {
            question: "Deploy now?",
            header: "Deploy",
            options: [
              { label: "Yes", preview: null },
              { label: "No", preview: null },
            ],
            multiSelect: false,
          },
        ],
      });
      await turn.next("/agent/answer");
      turn.send({ type: "plan_proposal", plan: "1. Build\n2. Ship", steps: ["Build", "Ship"], autoApproved: false, toolCallId: "plan-1", batchId: "bp" });
      await turn.next("/agent/approve");
      turn.send({ type: "approval_decided", toolCallId: "plan-1", batchId: "bp", decision: "allow", scope: "call", source: "user" });
      turn.send({ type: "done", provider: "google", model: "gemini-test", usage: null, estimatedCost: null, totalTime: 1 });
    });

    const response = await client.request("session/prompt", { sessionId, prompt: text("Ship it") });
    expect(response.result).toMatchObject({ stopReason: "end_turn" });
    expect(mock.requestsTo("/agent/answer").at(-1)?.body).toEqual({
      conversationId: sessionId,
      questionId: "q-1",
      answers: [{ answer: "No" }],
    });
    const question = client.received.find(
      (message) => message.method === "session/request_permission" && toolCallIdOf(message) === "question/q-1/1",
    );
    expect((question?.params?.options as Json[] | undefined)?.map((option) => option.name)).toEqual(["Yes", "No", "Skip"]);
    expect(mock.requestsTo("/agent/approve").at(-1)?.body).toMatchObject({ toolCallId: "plan-1", decision: "allow" });
    expect(client.updates(sessionId).some((update) => update.sessionUpdate === "plan")).toBe(true);
  });

  it("answers a failed turn with a JSON-RPC error carrying Prism's typed error", async () => {
    mock.scripts.push(async (turn) => {
      turn.send({ type: "chunk", content: "Error: 429 rate limited" });
      turn.send({ type: "done", provider: "anthropic", model: "claude-sonnet-5", usage: null, estimatedCost: null, totalTime: 1 });
      turn.send({ type: "error", code: "rate_limited", message: "429 too many requests", retryable: true, provider: "anthropic", status: 429 });
    });
    const response = await client.request("session/prompt", { sessionId, prompt: text("again") });
    expect(response.error).toMatchObject({
      code: -32603,
      message: "429 too many requests",
      data: { prism: { code: "rate_limited", retryable: true, provider: "anthropic", status: 429 } },
    });
  });

  it("answers a turn prism-service refuses (one already running) with an error, not a hang", async () => {
    mock.scripts.push(async (turn) => {
      turn.send({
        type: "error",
        code: "invalid_request",
        message: "A generation is already running for this conversation.",
        retryable: false,
        status: 409,
      });
    });
    const response = await client.request("session/prompt", { sessionId, prompt: text("once more") });
    expect(response.error?.data).toMatchObject({ prism: { code: "invalid_request", status: 409 } });
  });

  it("wrote nothing outside the ACP schemas, and logged only to stderr", () => {
    expect(client.violations).toEqual([]);
    expect(mock.invalidEvents).toEqual([]);
    expect(client.stderr).toContain("Prism ACP server ready");
    expect(client.alive).toBe(true);
  });
});

describe("ACP server — a client that renders forms", () => {
  const mock = new MockPrism();
  let client: StdioClient;

  beforeAll(async () => {
    await mock.start();
    client = new StdioClient({ PRISM_URL: mock.url, PRISM_WORKSPACE_ROOT: "none" });
  });
  afterAll(async () => {
    client.close();
    await mock.close();
  });

  it("puts a question card to the user as one elicitation form and relays the answers", async () => {
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } });
    const session = await client.request("session/new", { cwd: "/tmp/other", mcpServers: [] });
    const sessionId = String(session.result?.sessionId);
    client.handlers.set("elicitation/create", () => ({ action: "accept", content: { q1: "Blue", q2: "It is calm" } }));
    mock.scripts.push(async (turn) => {
      turn.send({
        type: "user_question",
        questionId: "q-2",
        blocking: true,
        context: "Picking a theme",
        questions: [
          { question: "Which colour?", header: "Colour", options: [{ label: "Red", preview: null }, { label: "Blue", preview: null }], multiSelect: false },
          { question: "Why?", header: null, options: [], multiSelect: false },
        ],
      });
      await turn.next("/agent/answer");
      turn.send({ type: "done", provider: "google", model: "m", usage: null, estimatedCost: null, totalTime: 1 });
    });

    const response = await client.request("session/prompt", { sessionId, prompt: text("Pick a theme") });
    expect(response.result).toMatchObject({ stopReason: "end_turn" });
    const form = client.received.find((message) => message.method === "elicitation/create");
    expect(form?.params).toMatchObject({
      sessionId,
      mode: "form",
      message: "Picking a theme",
      requestedSchema: {
        type: "object",
        properties: {
          q1: { type: "string", title: "Colour", enum: ["Red", "Blue"] },
          q2: { type: "string", title: "Why?" },
        },
        required: ["q1", "q2"],
      },
    });
    expect(mock.requestsTo("/agent/answer").at(-1)?.body).toEqual({
      conversationId: sessionId,
      questionId: "q-2",
      answers: [{ answer: "Blue" }, { answer: "It is calm" }],
    });
    expect(mock.requestsTo("/agent")[0]?.body).not.toHaveProperty("workspaceRoot");
    expect(client.violations).toEqual([]);
  });
});

describe("ACP server — a turn that hands work to the background", () => {
  const mock = new MockPrism();
  let client: StdioClient;
  let sessionId = "";

  beforeAll(async () => {
    await mock.start();
    client = new StdioClient({ PRISM_URL: mock.url, PRISM_PROJECT: "prism-test", PRISM_USERNAME: "acp-test", PRISM_WORKSPACE_ROOT: "none" });
    await client.request("initialize", { protocolVersion: 1 });
    sessionId = String((await client.request("session/new", { cwd: "/tmp/bg", mcpServers: [] })).result?.sessionId);
  });
  afterAll(async () => {
    client.close();
    await mock.close();
  });

  /** A turn that dispatches a non-blocking sub-agent: its stream ends without `done`, the conversation stays busy. */
  const dispatchingTurn = (subAgentId: string) => async (turn: ScriptedTurn) => {
    const conversationId = String(turn.body.conversationId);
    turn.send({ type: "user_message", role: "user", content: "Survey the repo", conversationId, timestamp: 1, seq: 101 });
    turn.send({ type: "sub_agent_status", subAgentId, message: "spawned", description: "Survey the repo", seq: 102 });
    turn.send({ type: "chunk", content: "A sub-agent is surveying the repo.", seq: 103 });
    mock.statuses.set(conversationId, { isGenerating: true, pendingBackgroundTasks: 1 });
  };

  it("follows /ws/chat from the stream's last seq until the background answer is in, then ends the prompt", async () => {
    mock.scripts.push(dispatchingTurn("s1"));
    const prompt = client.request("session/prompt", { sessionId, prompt: text("Survey the repo") }, 20_000);

    const subscription = await within(mock.nextSubscription(), 10_000, "the /ws/chat subscription");
    expect(subscription.subscribe).toEqual({ type: "subscribe", conversationId: sessionId, afterSeq: 103 });
    expect(Object.fromEntries(subscription.query)).toEqual({ project: "prism-test", username: "acp-test" });
    let answered = false;
    void prompt.then(() => (answered = true));

    subscription.send({ type: "sub_agent_status", subAgentId: "s1", message: "complete", durationMilliseconds: 2000, toolCount: 3, seq: 104 });
    subscription.send({ type: "task_notification", content: "Sub-agent report: 3 files.", timestamp: "2026-09-22T00:00:00.000Z", _notificationSource: "orchestrator", _notificationId: "n1" });
    subscription.send({ type: "user_message", role: "user", content: "Sub-agent report: 3 files.", conversationId: sessionId, timestamp: 2, seq: 105 });
    subscription.send({ type: "chunk", content: "The survey found 3 files.", seq: 106 });
    subscription.send({ type: "done", provider: "google", model: "m", usage: null, estimatedCost: 0.01, totalTime: 1, conversationId: sessionId, seq: 107 });
    await client.waitFor((message) => JSON.stringify(message.params ?? {}).includes("The survey found 3 files."), "the background answer");
    expect(answered).toBe(false); // the background work is not over until the conversation says so
    mock.statuses.set(sessionId, { isGenerating: false, pendingBackgroundTasks: 0 });
    subscription.send({ type: "conversation_state_update", pendingBackgroundTasks: 0, isActive: false });

    const response = await prompt;
    expect(response.result).toMatchObject({ stopReason: "end_turn" });
    const updates = client.updates(sessionId);
    expect(updates.find((update) => update.toolCallId === "sub-agent/s1" && update.status === "completed")).toBeDefined();
    const answer = updates
      .filter((update) => update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.content as { text: string }).text)
      .join("");
    expect(answer).toBe("A sub-agent is surveying the repo.The survey found 3 files.");
  });

  it("follows a turn that finished (done) while its detached work answers later in an auto-response", async () => {
    mock.scripts.push(async (turn) => {
      const conversationId = String(turn.body.conversationId);
      turn.send({ type: "user_message", role: "user", content: "Dispatch it", conversationId, timestamp: 1, seq: 201 });
      turn.send({ type: "sub_agent_status", subAgentId: "d1", message: "spawned", description: "List files", seq: 202 });
      turn.send({ type: "chunk", content: "Dispatched.", seq: 203 });
      turn.send({ type: "usage_update", usage: {}, estimatedCost: 0.02, seq: 204 });
      mock.statuses.set(conversationId, { isGenerating: false, pendingBackgroundTasks: 1 });
      turn.send({ type: "done", provider: "google", model: "m", usage: null, estimatedCost: 0.02, totalTime: 1, conversationId, seq: 205 });
    });
    const prompt = client.request("session/prompt", { sessionId, prompt: text("Dispatch it") }, 20_000);

    const subscription = await within(mock.nextSubscription(), 10_000, "the /ws/chat subscription");
    expect(subscription.subscribe).toMatchObject({ afterSeq: 205 });
    subscription.send({ type: "sub_agent_status", subAgentId: "d1", message: "complete", durationMilliseconds: 900, toolCount: 1, seq: 206 });
    subscription.send({ type: "user_message", role: "user", content: "[SUB-AGENT TEAM COMPLETED] README.md", conversationId: sessionId, timestamp: 2, seq: 207 });
    subscription.send({ type: "chunk", content: " It found README.md.", seq: 208 });
    subscription.send({ type: "done", provider: "google", model: "m", usage: null, estimatedCost: 0.03, totalTime: 1, conversationId: sessionId, seq: 209 });
    mock.statuses.set(sessionId, { isGenerating: false, pendingBackgroundTasks: 0 });
    subscription.send({ type: "conversation_state_update", pendingBackgroundTasks: 0, isActive: false });

    const response = await prompt;
    expect(response.result).toMatchObject({ stopReason: "end_turn" });
    // The prompt's cost is both turns': the dispatching one and the auto-response.
    const meta = (response.result?._meta as { prism: { sessionCostUsd: number } }).prism;
    expect(meta.sessionCostUsd).toBeCloseTo(0.01 + 0.02 + 0.03, 10);
    expect(JSON.stringify(client.updates(sessionId))).toContain("It found README.md.");
  });

  it("catches up from the persisted conversation when the socket delivered nothing", async () => {
    mock.scripts.push(dispatchingTurn("s2"));
    const prompt = client.request("session/prompt", { sessionId, prompt: text("Survey it again") }, 20_000);
    await within(mock.nextSubscription(), 10_000, "the /ws/chat subscription");
    // The auto-response ran and finished without this socket seeing it.
    mock.conversations.get(sessionId)!.push(
      { role: "assistant", content: "A sub-agent is surveying the repo." },
      { role: "user", content: "Sub-agent report: 2 files." },
      { role: "assistant", content: "This time it found 2 files." },
    );
    mock.statuses.set(sessionId, { isGenerating: false, pendingBackgroundTasks: 0 });

    const response = await prompt;
    expect(response.result).toMatchObject({ stopReason: "end_turn" });
    const last = client.updates(sessionId).filter((update) => update.sessionUpdate === "agent_message_chunk").at(-1);
    expect(last).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n\nThis time it found 2 files." } });
  });

  it("session/cancel while following stops the background sub-agents", async () => {
    mock.scripts.push(dispatchingTurn("s3"));
    const prompt = client.request("session/prompt", { sessionId, prompt: text("One more survey") }, 20_000);
    await within(mock.nextSubscription(), 10_000, "the /ws/chat subscription");
    client.notify("session/cancel", { sessionId });

    const response = await prompt;
    expect(response.result).toMatchObject({ stopReason: "cancelled" });
    expect(mock.requestsTo("/orchestrator/sub-agents/stop").at(-1)?.body).toEqual({ conversationId: sessionId });
    expect(client.updates(sessionId).filter((update) => update.toolCallId === "sub-agent/s3").at(-1)).toMatchObject({ status: "failed" });
    expect(client.violations).toEqual([]);
    expect(mock.invalidEvents).toEqual([]);
  });
});
