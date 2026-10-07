/**
 * websocketAuth.test.ts — a WebSocket upgrade authenticates the way a request
 * does (AuthMiddleware), on a real HTTP server: a user's token from the
 * `access_token` query parameter (browsers cannot set headers on a
 * WebSocket) or `Authorization`, a service's secret from `x-api-secret`, and
 * nothing → HTTP 401 before switching protocols.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

const handleConversation = vi.fn(async (_params: Record<string, unknown>, emit: (event: Record<string, unknown>) => void) => {
  emit({ type: "done" });
});
vi.mock("#src/routes/ChatRoutes", () => ({
  handleConversation: (params: Record<string, unknown>, emit: (event: Record<string, unknown>) => void) =>
    handleConversation(params, emit),
}));
vi.mock("#src/routes/AudioRoutes", () => ({ handleVoice: vi.fn() }));
vi.mock("#src/services/ConversationService", () => ({ default: { setGenerating: vi.fn() } }));
vi.mock("#src/services/RequestLogger", () => ({ default: { logChatGeneration: vi.fn() } }));
vi.mock("#src/wrappers/MongoWrapper", () => ({ default: {} }));

const { setupWebSocket } = await import("#src/websocket/index");
const { serviceHeaders, userToken } = await import("../../../tests/helpers/auth.ts");

let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end());
  const wss = new WebSocketServer({ noServer: true });
  setupWebSocket(wss, server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  handleConversation.mockClear();
});

/** The upgrade's outcome: a refusal (status + body), or an open socket's first frame. */
function connect(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> } | { socket: WebSocket; hello: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base}${path}`, { headers });
    socket.once("unexpected-response", (_request, response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => (text += chunk.toString()));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text || "{}") }));
    });
    socket.once("message", (data) => resolve({ socket, hello: JSON.parse(String(data)) }));
    socket.once("error", reject);
  });
}

/** Send one /ws/chat message and wait for the turn it hands handleConversation. */
async function sendTurn(socket: WebSocket, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  socket.send(JSON.stringify(message));
  await vi.waitFor(() => expect(handleConversation).toHaveBeenCalledTimes(1));
  return handleConversation.mock.calls[0][0];
}

describe("WebSocket upgrades sign in", () => {
  it("an upgrade with no credential is refused with HTTP 401 before switching protocols", async () => {
    const outcome = await connect("/ws/chat?project=prism-chat&username=rodrigo", { "x-username": "rodrigo" });
    expect(outcome).toEqual({ status: 401, body: { error: "Sign in to use Prism.", code: "UNAUTHENTICATED" } });
    expect(handleConversation).not.toHaveBeenCalled();
  });

  it("a bad token is refused with 401 INVALID_TOKEN, on every WebSocket path", async () => {
    for (const path of ["/ws/chat", "/ws/text-to-audio", "/ws/live", "/ws/elsewhere"]) {
      const outcome = await connect(`${path}?access_token=not-a-token`);
      expect(outcome).toMatchObject({ status: 401, body: { code: "INVALID_TOKEN" } });
    }
  });

  it("a token in access_token signs the user in; the username is the token's, not a claim", async () => {
    const outcome = await connect(
      `/ws/chat?project=prism-chat&username=mallory&access_token=${userToken("rodrigo")}`,
      { "x-username": "mallory" },
    );
    if (!("socket" in outcome)) throw new Error(`refused: ${JSON.stringify(outcome)}`);
    expect(outcome.hello.type).toBe("hello");
    const params = await sendTurn(outcome.socket, { messages: [{ role: "user", content: "hi" }], workspaceRoot: "/repo", autoApprove: true });
    expect(params).toMatchObject({ project: "prism-chat", username: "rodrigo", workspaceRoot: "/repo", autoApprove: true });
    outcome.socket.close();
  });

  it("a token in the Authorization header signs the user in too", async () => {
    const outcome = await connect("/ws/chat", { authorization: `Bearer ${userToken("rodrigo")}` });
    expect("socket" in outcome).toBe(true);
    if ("socket" in outcome) outcome.socket.close();
  });

  it("a service's secret signs the service in, as the user it names — with no workspace and no full auto", async () => {
    const outcome = await connect("/ws/chat?project=lupos", serviceHeaders("discord-member"));
    if (!("socket" in outcome)) throw new Error(`refused: ${JSON.stringify(outcome)}`);
    const params = await sendTurn(outcome.socket, {
      messages: [{ role: "user", content: "hi" }],
      workspaceRoot: "/home/rodrigo",
      autoApprove: true,
    });
    expect(params.username).toBe("discord-member");
    expect(params).not.toHaveProperty("workspaceRoot");
    expect(params).not.toHaveProperty("autoApprove");
    expect(params.workspaceEnabled).toBe(false);
    outcome.socket.close();
  });

  it("a wrong service secret is refused", async () => {
    const outcome = await connect("/ws/chat", { "x-api-secret": "wrong", "x-username": "rodrigo" });
    expect(outcome).toMatchObject({ status: 401, body: { code: "UNAUTHENTICATED" } });
  });
});
