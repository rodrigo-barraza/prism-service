/**
 * A stand-in prism-service for the ACP server's tests: the routes the ACP
 * server calls, with `/agent` answered by scripts that replay protocol
 * events (validated against `events.ts`, so a fixture cannot drift) and can
 * wait for the decisions the ACP client makes.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { validateTurnEvent, type TurnEvent } from "#src/protocol/events";

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

export interface ScriptedTurn {
  /** The POST /agent body. */
  body: Record<string, unknown>;
  /** Write one event as an SSE frame. */
  send(event: TurnEvent): void;
  /** The next request to `path` (one already received and not yet taken, or the next to arrive). */
  next(path: string): Promise<RecordedRequest>;
  /** Resolves when POST /agent/stop names this turn's conversation. */
  stopped: Promise<void>;
  /** Store the assistant's reply in the served conversation. */
  reply(text: string): void;
}

export type AgentScript = (turn: ScriptedTurn) => Promise<void>;

/** One `/ws/chat` client: its identity query and its `subscribe` message. */
export interface Subscription {
  query: URLSearchParams;
  subscribe: Record<string, unknown>;
  send(event: TurnEvent): void;
}

export interface ConversationStatus {
  isGenerating: boolean;
  pendingBackgroundTasks: number;
}

export const MODES = [
  { id: "default", label: "Ask", description: "Read-only tools run; writes ask.", available: true },
  { id: "plan", label: "Plan", description: "Read-only tools only.", available: true },
  { id: "acceptEdits", label: "Accept edits", description: "Edits run.", available: true },
  { id: "bypass", label: "Bypass", description: "Everything runs.", available: false },
];

export class MockPrism {
  readonly requests: RecordedRequest[] = [];
  readonly invalidEvents: Array<{ event: unknown; issues: unknown }> = [];
  readonly scripts: AgentScript[] = [];
  /** Served conversations: id → displayMessages. */
  readonly conversations = new Map<string, Array<Record<string, unknown>>>();
  private readonly taken = new Set<RecordedRequest>();
  private readonly waiters: Array<{ path: string; resolve: (request: RecordedRequest) => void }> = [];
  private readonly activeStops = new Map<string, () => void>();
  /** `GET /conversations/:id/status`; a conversation not listed is idle. */
  readonly statuses = new Map<string, ConversationStatus>();
  private readonly subscriptions: Subscription[] = [];
  private readonly subscriptionWaiters: Array<(subscription: Subscription) => void> = [];
  private server: http.Server | null = null;
  private sockets: WebSocketServer | null = null;
  url = "";

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.sockets = new WebSocketServer({ server: this.server, path: "/ws/chat" });
    this.sockets.on("connection", (socket: WebSocket, request) => this.acceptSocket(socket, request));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  /** The next `/ws/chat` subscription (one already made and not yet taken, or the next). */
  nextSubscription(): Promise<Subscription> {
    const waiting = this.subscriptions.shift();
    if (waiting) return Promise.resolve(waiting);
    return new Promise((resolve) => this.subscriptionWaiters.push(resolve));
  }

  private acceptSocket(socket: WebSocket, request: http.IncomingMessage): void {
    const query = new URL(request.url ?? "/", "http://mock").searchParams;
    const send = (event: TurnEvent) => {
      const result = validateTurnEvent(event);
      if (!result.success) this.invalidEvents.push({ event, issues: result.error.issues });
      socket.send(JSON.stringify(event));
    };
    send({ type: "hello", protocolVersion: 1 });
    socket.on("message", (data) => {
      const subscribe = JSON.parse(String(data)) as Record<string, unknown>;
      if (subscribe.type !== "subscribe") return;
      send({ type: "subscribed", conversationId: String(subscribe.conversationId), lastSeq: 0, replayedCount: 0, droppedCount: 0 });
      const subscription: Subscription = { query, subscribe, send };
      const waiter = this.subscriptionWaiters.shift();
      if (waiter) waiter(subscription);
      else this.subscriptions.push(subscription);
    });
  }

  async close(): Promise<void> {
    for (const client of this.sockets?.clients ?? []) client.terminate();
    this.sockets?.close();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  next(path: string): Promise<RecordedRequest> {
    const waiting = this.requests.find((request) => request.path === path && !this.taken.has(request));
    if (waiting) {
      this.taken.add(waiting);
      return Promise.resolve(waiting);
    }
    return new Promise((resolve) => this.waiters.push({ path, resolve }));
  }

  private record(request: RecordedRequest): void {
    this.requests.push(request);
    const index = this.waiters.findIndex((waiter) => waiter.path === request.path);
    if (index !== -1) {
      const [waiter] = this.waiters.splice(index, 1);
      this.taken.add(request);
      waiter!.resolve(request);
    }
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://mock");
    const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    const recorded: RecordedRequest = { method: request.method ?? "GET", path: url.pathname, body, headers: request.headers };
    const json = (status: number, payload: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };

    if (recorded.method === "POST" && recorded.path === "/agent") {
      this.record(recorded);
      await this.runAgent(recorded, response);
      return;
    }
    if (recorded.method === "POST" && recorded.path === "/agent/stop") {
      this.record(recorded);
      const stop = this.activeStops.get(String(body.conversationId));
      if (!stop) return json(404, { error: "No active session for this conversation" });
      stop();
      return json(200, { ok: true, stopped: true });
    }
    this.record(recorded);
    if (recorded.method === "GET" && recorded.path === "/permissions/mode") {
      return json(200, { conversationId: url.searchParams.get("conversationId"), mode: "default", source: "default", defaultMode: "default", bypassAllowed: false, modes: MODES });
    }
    if (recorded.method === "PUT" && recorded.path === "/permissions/mode") {
      return this.conversations.has(String(body.conversationId))
        ? json(200, { conversationId: body.conversationId, mode: body.mode, stored: true, live: false })
        : json(404, { error: `No conversation ${String(body.conversationId)}.` });
    }
    if (recorded.method === "POST" && recorded.path === "/agent/approve") return json(200, { ok: true, delivered: true });
    if (recorded.method === "POST" && recorded.path === "/agent/answer") return json(200, { ok: true, delivered: true });
    if (recorded.method === "POST" && recorded.path === "/permissions/rules/propose") {
      return json(200, { rule: `${String(body.toolName)}(*)`, coversCall: true, capabilities: [] });
    }
    if (recorded.method === "POST" && recorded.path === "/permissions/rules") return json(201, { id: "rule-1", ...body });
    if (recorded.method === "POST" && recorded.path === "/orchestrator/sub-agents/stop") {
      return json(200, { stopped: ["s1"], alreadyStopped: [] });
    }
    const status = recorded.path.match(/^\/conversations\/([^/]+)\/status$/);
    if (recorded.method === "GET" && status) {
      const id = decodeURIComponent(status[1]!);
      if (!this.conversations.has(id)) return json(404, { error: "Conversation not found" });
      const { isGenerating, pendingBackgroundTasks } = this.statuses.get(id) ?? { isGenerating: false, pendingBackgroundTasks: 0 };
      return json(200, { id, isGenerating, pendingBackgroundTasks, isActive: pendingBackgroundTasks > 0, type: "agent" });
    }
    const conversation = recorded.path.match(/^\/conversations\/([^/]+)$/);
    if (recorded.method === "GET" && conversation) {
      const messages = this.conversations.get(decodeURIComponent(conversation[1]!));
      return messages ? json(200, { id: conversation[1], displayMessages: messages }) : json(404, { error: "Not found" });
    }
    json(404, { error: `mock has no route ${recorded.method} ${recorded.path}` });
  }

  private async runAgent(request: RecordedRequest, response: http.ServerResponse): Promise<void> {
    const conversationId = String(request.body.conversationId);
    const messages = (request.body.messages as Array<Record<string, unknown>>) ?? [];
    this.conversations.set(conversationId, [...messages]);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (event: TurnEvent) => {
      const result = validateTurnEvent(event);
      if (!result.success) this.invalidEvents.push({ event, issues: result.error.issues });
      if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    let markStopped: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      markStopped = resolve;
    });
    this.activeStops.set(conversationId, markStopped);
    send({ type: "hello", protocolVersion: 1 });
    // A heartbeat comment, as the real stream sends every 15 s.
    response.write(": ping\n\n");
    const script = this.scripts.shift();
    try {
      if (!script) {
        send({ type: "error", code: "internal", message: "mock: no script for this turn", retryable: false });
      } else {
        await script({
          body: request.body,
          send,
          next: (path) => this.next(path),
          stopped,
          reply: (text) => this.conversations.get(conversationId)?.push({ role: "assistant", content: text }),
        });
      }
    } finally {
      this.activeStops.delete(conversationId);
      response.end();
    }
  }
}
