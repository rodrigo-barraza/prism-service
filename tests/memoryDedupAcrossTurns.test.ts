/**
 * Memory de-duplication across turns — integration.
 *
 * Runs the real SystemPromptAssembler hook, SkillMemoryScorer,
 * MemoryService.search and ConversationService.appendMessages over the shared
 * in-memory Mongo mock. Every read goes through a BSON round trip, as it does
 * against a real server: a reloaded ObjectId is a new instance, so identity
 * comparisons that happen to pass on shared objects fail here the way they do
 * in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BSON, ObjectId } from "mongodb";
import { HARNESS_IDENTIFIERS } from "#src/constants";
import { createMockCollection } from "./mongoMock.ts";

vi.mock("#config", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  MONGO_DB_NAME: "prism-test",
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const roundTrip = <T>(document: T): T =>
  document ? (BSON.deserialize(BSON.serialize(document as BSON.Document)) as T) : document;

function roundTrippingCollection(initialData: Array<Record<string, unknown>> = []) {
  const collection = createMockCollection(initialData);
  return {
    ...collection,
    find: (...arguments_: Parameters<typeof collection.find>) => {
      const cursor = collection.find(...arguments_);
      const toArray = cursor.toArray;
      cursor.toArray = async () => (await toArray()).map(roundTrip);
      return cursor;
    },
    findOne: async (query: unknown) => roundTrip(await collection.findOne(query)),
  };
}

const collections = new Map<string, ReturnType<typeof roundTrippingCollection>>();
function collectionNamed(name: string) {
  if (!collections.has(name)) collections.set(name, roundTrippingCollection());
  return collections.get(name)!;
}

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getCollection: (_database: string, name: string) => collectionNamed(name),
    getDb: () => ({ collection: (name: string) => collectionNamed(name) }),
  },
}));

vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]) },
}));

vi.mock("#src/services/FileService", () => ({
  default: { isExternalStorage: () => false, isMinioRef: () => false, uploadFile: vi.fn() },
}));

vi.mock("#src/services/AgentPersonaRegistry", () => ({
  default: {
    get: () => ({
      id: "CODING",
      name: "Coding Agent",
      type: "coding",
      description: "A coding assistant",
      project: "coding",
      identity: () => "You are a coding assistant.",
      guidelines: "",
      interactionRules: "",
      toolPolicy: () => "",
      availableTools: ["*"],
      enabledByDefaultTools: ["*"],
      capabilities: "",
      usesDirectoryTree: false,
      usesCodingGuidelines: false,
    }),
    list: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
    getWorkspaceRoot: () => "/test",
    listToolNames: () => [],
    listToolsForAgent: () => [],
    getToolsGlobalConfig: () => ({}),
    getToolApiName: () => null,
    getTagsForTool: () => new Set<string>(),
    getToolSchemas: () => [],
    getClientToolSchemas: () => [],
  },
}));

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      topology: HARNESS_IDENTIFIERS.STANDARD,
      dynamicToolActivation: false,
    }),
    get: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("#src/services/OrchestratorPrompt", () => ({
  getOrchestratorPromptAddendum: () => "",
  ORCHESTRATOR_ONLY_TOOLS: new Set<string>(),
}));

vi.mock("#src/utils/resolveToolEntriesToSet", () => ({
  resolveToolEntriesToSet: () => new Set<string>(),
}));

vi.mock("#src/utils/resolveLockedOffToolNames", () => ({
  resolveLockedOffToolNames: () => new Set<string>(),
}));

vi.mock("#src/services/system-prompt/DirectoryTreeFormatter", () => ({
  DirectoryTreeFormatter: class {
    fetchDirectoryTree() { return Promise.resolve(""); }
  },
}));

vi.mock("#src/services/system-prompt/ToolDocFormatter", () => ({
  ToolDocFormatter: class {
    buildToolDescriptions() { return ""; }
  },
}));

vi.mock("#src/services/WorkflowMemoryService", () => ({
  default: {
    retrieveRelevantWorkflows: vi.fn().mockResolvedValue(null),
    createHook: () => vi.fn(),
  },
}));

vi.mock("#src/services/ConversationGoalService", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  default: { get: vi.fn().mockResolvedValue(null) },
}));

vi.mock("#src/utils/ConversationDiscovery", () => ({
  discoverDescendantConversationIds: vi.fn().mockResolvedValue(new Set()),
}));

const { default: SystemPromptAssembler } = await import("#src/services/system-prompt/index");
const { default: ConversationService } = await import(
  "#src/services/conversation/ConversationService"
);
const { COLLECTIONS } = await import("#src/constants");
import type { AssemblerContext } from "#src/services/system-prompt/types";

// ── Fixtures ───────────────────────────────────────────────────

const PROJECT = "prism-test";
const USERNAME = "rodrigo";
const CONVERSATION_ID = "conversation-memory-dedup";

function memoryDocument(title: string, content: string) {
  return {
    _id: new ObjectId(),
    id: crypto.randomUUID(),
    agent: "CODING",
    project: PROJECT,
    type: "user",
    title,
    content,
    embedding: [0.1, 0.2, 0.3],
    createdAt: new Date().toISOString(),
    validTo: null,
  };
}

const DEPLOY = memoryDocument("Deploy preference", "Rodrigo deploys to staging with the task runner.");
const BRANCHES = memoryDocument("Branch naming", "Rodrigo names staging branches after the task.");

function turnContext(messages: AssemblerContext["messages"]): AssemblerContext {
  return {
    agent: "CODING",
    project: PROJECT,
    username: USERNAME,
    conversationId: CONVERSATION_ID,
    workspaceEnabled: false,
    messages,
  };
}

/** The per-turn system-context message the assembler spliced in this turn. */
function injectedContextOf(context: AssemblerContext): string {
  const injected = (context.messages || []).find((message) => message._isInjectedContext === true);
  return (injected?.content as string) || "";
}

async function persistTurn(context: AssemblerContext, userText: string) {
  // What ReActHarness hands the Finalizer: the hook's ids as conversationMeta.
  const injectedMemoryIds = context._injectedMemoryIds as string[] | undefined;
  await ConversationService.appendMessages(
    CONVERSATION_ID,
    PROJECT,
    USERNAME,
    [
      { role: "user", content: userText, timestamp: new Date().toISOString() },
      { role: "assistant", content: "Noted.", timestamp: new Date().toISOString() },
    ],
    injectedMemoryIds ? { _newInjectedMemoryIds: injectedMemoryIds } : null,
    { collection: COLLECTIONS.AGENT_CONVERSATIONS },
  );
}

async function storedInjectedMemoryIds(): Promise<unknown[]> {
  const document = await collectionNamed(COLLECTIONS.AGENT_CONVERSATIONS).findOne({ id: CONVERSATION_ID });
  return (document?.injectedMemoryIds as unknown[]) || [];
}

describe("memory de-duplication across turns", () => {
  beforeEach(() => {
    collections.clear();
    collectionNamed(COLLECTIONS.MEMORIES)._setData([DEPLOY, BRANCHES]);
  });

  it("injects a memory on turn 1 only, and stores its id as a string", async () => {
    const hook = new SystemPromptAssembler("/test").createHook();

    const firstTurn = turnContext([
      { role: "system", content: "" },
      { role: "user", content: "How do I deploy to staging?" },
    ]);
    await hook(firstTurn);
    expect(injectedContextOf(firstTurn)).toContain(DEPLOY.content);
    expect(injectedContextOf(firstTurn)).toContain(BRANCHES.content);
    await persistTurn(firstTurn, "How do I deploy to staging?");

    const storedIds = await storedInjectedMemoryIds();
    expect(storedIds).toHaveLength(2);
    for (const storedId of storedIds) expect(typeof storedId).toBe("string");
    expect([...storedIds].sort()).toEqual(
      [DEPLOY._id.toHexString(), BRANCHES._id.toHexString()].sort(),
    );

    // A memory learned between the turns is still news on turn 2.
    const LATER = memoryDocument("Staging window", "Staging deploys happen after 18:00.");
    await collectionNamed(COLLECTIONS.MEMORIES).insertOne(LATER);

    const secondTurn = turnContext([
      { role: "system", content: "" },
      { role: "user", content: "How do I deploy to staging?" },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "And the staging deploy tomorrow?" },
    ]);
    await hook(secondTurn);
    const secondInjection = injectedContextOf(secondTurn);
    expect(secondInjection).not.toContain(DEPLOY.content);
    expect(secondInjection).not.toContain(BRANCHES.content);
    expect(secondInjection).toContain(LATER.content);
    expect(secondTurn._injectedMemoryIds).toEqual([LATER._id.toHexString()]);
  });

  it("honours legacy ObjectId entries already stored on the conversation", async () => {
    // Production conversations carry ObjectIds from before the fix.
    collectionNamed(COLLECTIONS.AGENT_CONVERSATIONS)._setData([
      {
        id: CONVERSATION_ID,
        project: PROJECT,
        username: USERNAME,
        messages: [],
        injectedMemoryIds: [new ObjectId(DEPLOY._id.toHexString())],
      },
    ]);
    const hook = new SystemPromptAssembler("/test").createHook();

    const turn = turnContext([
      { role: "system", content: "" },
      { role: "user", content: "How do I deploy to staging?" },
    ]);
    await hook(turn);

    expect(injectedContextOf(turn)).not.toContain(DEPLOY.content);
    expect(injectedContextOf(turn)).toContain(BRANCHES.content);
    expect(turn._injectedMemoryIds).toEqual([BRANCHES._id.toHexString()]);
  });
});
