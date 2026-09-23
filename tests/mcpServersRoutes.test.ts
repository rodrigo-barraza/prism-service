import { describe, it, expect, vi, beforeEach } from "vitest";
import supertest from "supertest";
import { ObjectId } from "mongodb";
import { app } from "./setup.ts";
import MongoWrapper from "#src/wrappers/MongoWrapper";

vi.mock("#src/services/MCPClientService", () => {
  class McpServerNameConflictError extends Error {}
  return {
    McpServerNameConflictError,
    default: {
      getConnectedServers: vi.fn().mockReturnValue([]),
      connect: vi.fn(),
      disconnectServer: vi.fn().mockResolvedValue(undefined),
      updateServerSettings: vi.fn().mockReturnValue(false),
      approveTools: vi.fn().mockResolvedValue(null),
      isServerConnected: vi.fn().mockReturnValue(false),
    },
  };
});

const { default: mcpServersRouter } = await import("#src/routes/McpServersRoutes");
const { McpAuthorizationRequiredError } = await import("#src/services/mcp/McpOAuth");
const { default: MCPClientService, McpServerNameConflictError } = await import(
  "#src/services/MCPClientService"
);

app.use("/mcp-servers-routes-test", mcpServersRouter);

const BASE = "/mcp-servers-routes-test";
const OWNER = { "x-username": "rodrigo", "x-project": "prism-client" };
const OTHER_PROFILE = { ...OWNER, "x-profile-id": "work" };

/** Enough of Mongo for this router: equality (ObjectId by value), $in, $ne, $or. */
function matches(doc: Record<string, any>, query: Record<string, any>): boolean {
  return Object.entries(query).every(([key, value]) => {
    if (key === "$or") return (value as any[]).some((branch) => matches(doc, branch));
    if (value instanceof ObjectId) return String(doc[key]) === String(value);
    if (value && typeof value === "object" && "$in" in value) {
      return (value.$in as unknown[]).includes(doc[key] ?? null);
    }
    if (value && typeof value === "object" && "$ne" in value) {
      return String(doc[key]) !== String(value.$ne);
    }
    return doc[key] === value;
  });
}

let documents: Array<Record<string, any>> = [];

const collection = {
  find: (query: Record<string, any>) => {
    const cursor = {
      sort: () => cursor,
      toArray: async () => documents.filter((doc) => matches(doc, query)),
    };
    return cursor;
  },
  findOne: async (query: Record<string, any>) =>
    documents.find((doc) => matches(doc, query)) ?? null,
  insertOne: async (doc: Record<string, any>) => {
    const _id = new ObjectId();
    documents.push({ ...doc, _id });
    return { insertedId: _id };
  },
  updateOne: async (query: Record<string, any>, update: { $set: Record<string, any> }) => {
    const doc = documents.find((candidate) => matches(candidate, query));
    if (doc) Object.assign(doc, update.$set);
    return { matchedCount: doc ? 1 : 0 };
  },
  findOneAndUpdate: async (query: Record<string, any>, update: { $set: Record<string, any> }) => {
    const doc = documents.find((candidate) => matches(candidate, query));
    if (!doc) return null;
    Object.assign(doc, update.$set);
    return doc;
  },
  findOneAndDelete: async (query: Record<string, any>) => {
    const doc = documents.find((candidate) => matches(candidate, query));
    documents = documents.filter((candidate) => candidate !== doc);
    return doc ?? null;
  },
};

function server(fields: Record<string, any>) {
  const doc = {
    _id: new ObjectId(),
    project: "prism-client",
    username: "rodrigo",
    profileId: "default",
    displayName: fields.name,
    transport: "stdio",
    command: "node",
    enabled: true,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    ...fields,
  };
  documents.push(doc);
  return doc;
}

describe("MCP server routes — naming, sharing, trust and approval", () => {
  const agent = supertest(app);

  beforeEach(() => {
    documents = [];
    vi.clearAllMocks();
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue({
      collection: () => collection,
    } as never);
  });

  it("refuses a server name that would make the tool namespace ambiguous", async () => {
    const response = await agent
      .post(BASE)
      .set(OWNER)
      .send({ name: "git__hub", transport: "stdio", command: "node" });
    expect(response.status).toBe(400);
  });

  it("refuses a duplicate name in the profile or against a shared server, but not across profiles", async () => {
    server({ name: "github" });
    server({ name: "playwright", username: "admin", project: "coding", shared: true });

    const duplicate = await agent.post(BASE).set(OWNER).send({ name: "github", command: "node" });
    expect(duplicate.status).toBe(409);
    const shadowsShared = await agent.post(BASE).set(OWNER).send({ name: "playwright", command: "node" });
    expect(shadowsShared.status).toBe(409);

    const otherProfile = await agent
      .post(BASE)
      .set(OTHER_PROFILE)
      .send({ name: "github", command: "node", trusted: true, outputCapTokens: 5000 });
    expect(otherProfile.status).toBe(201);
    expect(otherProfile.body).toMatchObject({ profileId: "work", trusted: true, outputCapTokens: 5000 });
    // `shared` is never accepted from a request.
    const sneaky = await agent
      .post(BASE)
      .set(OTHER_PROFILE)
      .send({ name: "sneaky", command: "node", shared: true });
    expect(sneaky.body.shared).toBeUndefined();
  });

  it("lists the profile's servers plus shared ones, with the stored quarantine and without the pins", async () => {
    server({
      name: "github",
      toolPins: { echo: { hash: "a", approvedAt: "x" } },
      quarantinedTools: [{ name: "echo", reason: "changed", hash: "b", description: "new" }],
      protocolVersion: "2026-07-28",
    });
    server({ name: "playwright", username: "admin", project: "coding", shared: true });
    server({ name: "private-elsewhere", profileId: "work" });

    const response = await agent.get(BASE).set(OWNER).expect(200);
    const byName = Object.fromEntries(response.body.map((entry: any) => [entry.name, entry]));
    expect(Object.keys(byName).sort()).toEqual(["github", "playwright"]);
    expect(byName.github).toMatchObject({
      quarantinedTools: [expect.objectContaining({ name: "echo", reason: "changed" })],
      protocolVersion: "2026-07-28",
      shared: false,
    });
    expect(byName.github).not.toHaveProperty("toolPins");
    expect(byName.playwright.shared).toBe(true);
  });

  it("approves a stored quarantine while the server is disconnected", async () => {
    const doc = server({
      name: "github",
      toolPins: { echo: { hash: "old", approvedAt: "x" } },
      quarantinedTools: [
        { name: "echo", reason: "changed", hash: "new", description: "d" },
        { name: "dup", reason: "duplicate", hash: "h", description: "d" },
      ],
    });

    const response = await agent
      .post(`${BASE}/${doc._id}/tools/approve`)
      .set(OWNER)
      .send({})
      .expect(200);
    expect(response.body).toMatchObject({ connected: false, approved: ["echo"], skipped: ["dup"] });
    expect(doc.toolPins.echo.hash).toBe("new");
    expect(doc.quarantinedTools).toEqual([expect.objectContaining({ name: "dup" })]);
  });

  it("approves on a shared server, but not on another profile's private one", async () => {
    const shared = server({ name: "playwright", username: "admin", shared: true, quarantinedTools: [] });
    const elsewhere = server({ name: "github", profileId: "work" });

    await agent.post(`${BASE}/${shared._id}/tools/approve`).set(OWNER).send({}).expect(200);
    await agent.post(`${BASE}/${elsewhere._id}/tools/approve`).set(OWNER).send({}).expect(404);
    await agent.post(`${BASE}/not-an-id/tools/approve`).set(OWNER).send({}).expect(404);
  });

  it("uses the live connection when there is one", async () => {
    const doc = server({ name: "github" });
    vi.mocked(MCPClientService.approveTools).mockResolvedValueOnce({
      approved: ["echo"],
      skipped: [],
      quarantinedTools: [],
      toolCount: 3,
    });

    const response = await agent
      .post(`${BASE}/${doc._id}/tools/approve`)
      .set(OWNER)
      .send({ tools: ["echo"] })
      .expect(200);
    expect(MCPClientService.approveTools).toHaveBeenCalledWith(String(doc._id), "default", ["echo"]);
    expect(response.body).toMatchObject({ connected: true, approved: ["echo"] });
  });

  it("applies trust to the live connection on update", async () => {
    const doc = server({ name: "github" });
    await agent.put(`${BASE}/${doc._id}`).set(OWNER).send({ trusted: true }).expect(200);
    expect(MCPClientService.updateServerSettings).toHaveBeenCalledWith(
      String(doc._id),
      "default",
      expect.objectContaining({ trusted: true }),
    );
  });

  it("hands back the authorization URL when an OAuth server has no tokens yet", async () => {
    const doc = server({ name: "linear", transport: "streamable-http", url: "https://mcp.linear.app/mcp", auth: { type: "oauth" } });
    vi.mocked(MCPClientService.connect).mockRejectedValueOnce(
      new McpAuthorizationRequiredError("linear", "https://auth.example/authorize?client_id=x"),
    );
    const response = await agent
      .post(`${BASE}/${doc._id}/connect`)
      .set({ ...OWNER, "x-forwarded-proto": "https", "x-forwarded-host": "api.prism.test" })
      .expect(200);
    expect(response.body).toEqual({
      success: false,
      authorizationRequired: true,
      authorizationUrl: "https://auth.example/authorize?client_id=x",
    });
    // The redirect base is the origin the request arrived on.
    expect(vi.mocked(MCPClientService.connect).mock.calls[0][0]).toMatchObject({
      _requestOrigin: "https://api.prism.test",
    });
  });

  it("reports an OAuth server's authorization state without any token", async () => {
    const doc = server({ name: "linear", transport: "streamable-http", auth: { type: "oauth" } });
    const response = await agent.get(`${BASE}/${doc._id}/oauth`).set(OWNER).expect(200);
    expect(response.body).toMatchObject({ status: "none", authorized: false });
    const list = await agent.get(BASE).set(OWNER).expect(200);
    expect(list.body[0].oauth).toMatchObject({ status: "none", authorized: false });
  });

  it("answers a name conflict at connect time with 409", async () => {
    const doc = server({ name: "github" });
    vi.mocked(MCPClientService.connect).mockRejectedValueOnce(
      new McpServerNameConflictError("github"),
    );
    await agent.post(`${BASE}/${doc._id}/connect`).set(OWNER).expect(409);
  });
});
