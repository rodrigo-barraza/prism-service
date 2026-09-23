/**
 * ProviderFaultServer — a real HTTP server that answers provider requests
 * from a script, so tests/providerFaults.test.ts drives every adapter over
 * the network, below its SDK, the way AgentChaos (arXiv 2608.06790) injects
 * faults: at the HTTP layer.
 *
 * Each streaming request takes the next scripted reply (the fallback once
 * the script is empty). A reply is either
 *   - `json`: a status, headers and a JSON body (an error, a model list), or
 *   - `stream`: a 200 whose frames are written one by one, then an ending:
 *       "end"     — the body closes cleanly (a truncated stream when the
 *                   frames stop before the provider's terminal event),
 *       "destroy" — the socket is destroyed mid-body (the connection drops),
 *       "hang"    — nothing more is written and the socket stays open.
 * Side requests an adapter makes before it streams (vLLM's `/v1/models`,
 * Ollama's `/api/ps`) are answered from fixed routes, never from the script.
 * Every request is recorded with its arrival time and, when the client
 * closes the connection, its close time.
 */
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  receivedAt: number;
  /** When the connection carrying this request closed (null while open). */
  closedAt: number | null;
}

export type FaultReply =
  | {
      kind: "json";
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    }
  | {
      kind: "stream";
      frames: string[];
      ending: "end" | "destroy" | "hang";
      contentType?: string;
    };

export class ProviderFaultServer {
  readonly requests: RecordedRequest[] = [];
  private readonly script: FaultReply[] = [];
  private readonly fixedRoutes = new Map<string, FaultReply>();
  private fallback: FaultReply | null = null;
  private server: http.Server | null = null;
  private readonly sockets = new Set<Socket>();
  baseUrl = "";

  async start(): Promise<string> {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  /** Forget the requests, the script and the fallback (fixed routes stay). */
  reset(): void {
    this.requests.length = 0;
    this.script.length = 0;
    this.fallback = null;
    for (const socket of this.sockets) socket.destroy();
  }

  /** Replies for the next streaming requests, in order. */
  enqueue(...replies: FaultReply[]): void {
    this.script.push(...replies);
  }

  /** The reply every streaming request gets once the script is empty. */
  setFallback(reply: FaultReply): void {
    this.fallback = reply;
  }

  /** A side request answered the same way every time, e.g. `GET /v1/models`. */
  route(method: string, path: string, reply: FaultReply): void {
    this.fixedRoutes.set(`${method} ${path}`, reply);
  }

  /** The recorded requests that went to scripted (streaming) paths. */
  get scriptedRequests(): RecordedRequest[] {
    return this.requests.filter(
      (request) =>
        !this.fixedRoutes.has(`${request.method} ${request.path.split("?")[0]}`),
    );
  }

  /** Resolves true once `request`'s connection closed, false after `timeoutMilliseconds`. */
  async waitForClose(
    request: RecordedRequest,
    timeoutMilliseconds: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMilliseconds;
    while (request.closedAt === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return request.closedAt !== null;
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf-8");
    let body: unknown = raw;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* not JSON — keep the text */
    }
    const recorded: RecordedRequest = {
      method: request.method || "GET",
      path: request.url || "/",
      headers: request.headers,
      body,
      receivedAt: Date.now(),
      closedAt: null,
    };
    this.requests.push(recorded);
    request.socket.once("close", () => {
      recorded.closedAt = Date.now();
    });

    const routeKey = `${recorded.method} ${recorded.path.split("?")[0]}`;
    const reply =
      this.fixedRoutes.get(routeKey) ?? this.script.shift() ?? this.fallback;
    if (!reply) {
      response.writeHead(599, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `unscripted request ${routeKey}` }));
      return;
    }
    if (reply.kind === "json") {
      response.writeHead(reply.status, {
        "content-type": "application/json",
        ...reply.headers,
      });
      response.end(JSON.stringify(reply.body));
      return;
    }

    response.writeHead(200, {
      "content-type": reply.contentType ?? "text/event-stream",
      "cache-control": "no-cache",
    });
    for (const frame of reply.frames) {
      // Each frame in its own write, flushed before the next, so the
      // client parses them as they would arrive from a real provider.
      await new Promise<void>((resolve) => response.write(frame, () => resolve()));
    }
    if (reply.ending === "end") {
      response.end();
    } else if (reply.ending === "destroy") {
      response.socket?.destroy();
    }
    // "hang": leave the response open; stop() or the client closes it.
  }
}
