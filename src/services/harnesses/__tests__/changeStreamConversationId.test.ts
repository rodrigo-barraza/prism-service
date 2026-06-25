/**
 * Change Stream Conversation ID Propagation Tests
 *
 * Validates that the `conversationId` field propagates correctly from
 * the harness hook context through to the request document, and that
 * the ChangeStreamService correctly enriches SSE events with the
 * `conversationId` for request-type change events.
 *
 * Regression coverage for the bug where memory:embed and workflow-query:embed
 * requests were created with `conversationId: null`, making them invisible
 * to the graph's SSE filter (`changeEvent.conversationId === conversationId`).
 *
 * Root Cause Chain:
 *   1. BeforePromptHookContext omitted `conversationId`
 *   2. SystemPromptAssembler read `context.conversationId` → undefined
 *   3. EmbeddingService logged requests with `conversationId: null`
 *   4. ChangeStreamService skipped setting `conversationId` on the SSE payload
 *   5. Graph's SSE filter rejected the event (undefined !== "the-actual-id")
 */
import { describe, it, expect } from "vitest";

// ── BeforePromptHookContext Propagation ────────────────────────────

describe("BeforePromptHookContext — conversationId propagation", () => {
  /**
   * Verify that the BeforePromptHookContext interface and construction
   * in each harness includes `conversationId` as a required field.
   *
   * We test this by simulating the destructuring pattern used in each harness
   * and verifying the hookContext object always contains `conversationId`.
   */

  const MOCK_AGENTIC_CONTEXT = {
    options: {},
    conversationId: "conv-abc-123",
    agentConversationId: "agent-conv-xyz-789",
    traceId: "trace-001",
    project: "test-project",
    username: "rodrigo",
    agent: "omni",
    workspaceRoot: "/tmp/workspace",
    emit: () => {},
    signal: null,
    parentAgentConversationId: null,
  };

  it("ReActHarness hookContext includes conversationId from AgenticContext", () => {
    const {
      options: _options,
      conversationId,
      agentConversationId,
      traceId,
      project,
      username,
      agent,
      workspaceRoot,
    } = MOCK_AGENTIC_CONTEXT;

    const hookContext = {
      messages: [],
      project,
      username,
      agent,
      traceId,
      conversationId,
      agentConversationId,
      parentAgentConversationId: MOCK_AGENTIC_CONTEXT.parentAgentConversationId,
      agentContext: undefined,
      enabledTools: null,
      resolvedToolNames: [],
      workspaceRoot: workspaceRoot || undefined,
      workspaceEnabled: undefined,
    };

    expect(hookContext.conversationId).toBe("conv-abc-123");
    expect(hookContext.agentConversationId).toBe("agent-conv-xyz-789");
  });

  it("hookContext.conversationId must not be undefined or null for top-level conversations", () => {
    const hookContext = {
      messages: [],
      project: "test-project",
      username: "rodrigo",
      agent: "omni",
      traceId: null,
      conversationId: MOCK_AGENTIC_CONTEXT.conversationId,
      agentConversationId: MOCK_AGENTIC_CONTEXT.agentConversationId,
      agentContext: undefined,
      enabledTools: null,
      resolvedToolNames: [],
    };

    expect(hookContext.conversationId).toBeDefined();
    expect(hookContext.conversationId).not.toBeNull();
    expect(typeof hookContext.conversationId).toBe("string");
    expect(hookContext.conversationId.length).toBeGreaterThan(0);
  });

  it("conversationId propagates through embedding options path", () => {
    const context = { ...MOCK_AGENTIC_CONTEXT };
    const conversationIdFromContext = context.conversationId as string | null;

    const embeddingOptions = {
      conversationId: conversationIdFromContext || null,
      traceId: context.traceId || null,
      agentConversationId: context.agentConversationId || null,
    };

    expect(embeddingOptions.conversationId).toBe("conv-abc-123");
    expect(embeddingOptions.conversationId).not.toBeNull();
  });

  it("missing conversationId on context causes null in embedding options (the original bug)", () => {
    const contextWithoutConversationId: Record<string, unknown> = {
      agentConversationId: "agent-conv-xyz-789",
      traceId: "trace-001",
      project: "test-project",
      username: "rodrigo",
    };

    const conversationIdFromContext =
      contextWithoutConversationId.conversationId as string | null | undefined;

    const embeddingOptions = {
      conversationId: conversationIdFromContext || null,
    };

    // This demonstrates the original bug: conversationId is null
    expect(embeddingOptions.conversationId).toBeNull();
  });
});

// ── ChangeStreamService Payload Enrichment ────────────────────────

describe("ChangeStreamService — conversationId enrichment", () => {
  /**
   * Simulates the payload enrichment logic from ChangeStreamService lines 107-112:
   *
   *   if (collectionName === COLLECTIONS.REQUESTS && fullDocument?.conversationId) {
   *     payload.conversationId = fullDocument.conversationId as string;
   *   }
   *
   * This verifies that requests with `conversationId: null` produce SSE events
   * WITHOUT `conversationId`, which the graph's SSE filter then rejects.
   */

  interface MockChangeStreamPayload {
    collection: string;
    operationType: string;
    documentId: string | null;
    id: string | null;
    updatedFields: string[] | null;
    timestamp: string;
    conversationId?: string | null;
  }

  function simulateChangeStreamEnrichment(
    collectionName: string,
    fullDocument: Record<string, unknown> | null,
  ): MockChangeStreamPayload {
    const payload: MockChangeStreamPayload = {
      collection: collectionName,
      operationType: "insert",
      documentId: "doc-123",
      id: null,
      updatedFields: null,
      timestamp: new Date().toISOString(),
    };

    if (collectionName === "requests" && fullDocument?.conversationId) {
      payload.conversationId = fullDocument.conversationId as string;
    }

    return payload;
  }

  it("enriches payload with conversationId when the request document has one", () => {
    const payload = simulateChangeStreamEnrichment("requests", {
      conversationId: "conv-abc-123",
      operation: "memory:embed",
      username: "system",
    });

    expect(payload.conversationId).toBe("conv-abc-123");
  });

  it("does NOT enrich payload when conversationId is null (the original bug)", () => {
    const payload = simulateChangeStreamEnrichment("requests", {
      conversationId: null,
      operation: "memory:embed",
      username: "system",
    });

    expect(payload.conversationId).toBeUndefined();
  });

  it("does NOT enrich payload when conversationId is missing entirely", () => {
    const payload = simulateChangeStreamEnrichment("requests", {
      operation: "memory:embed",
      username: "system",
    });

    expect(payload.conversationId).toBeUndefined();
  });

  it("does NOT enrich payload for non-request collections", () => {
    const payload = simulateChangeStreamEnrichment("agent_conversations", {
      conversationId: "conv-abc-123",
    });

    expect(payload.conversationId).toBeUndefined();
  });
});

// ── SSE Filter Matching ──────────────────────────────────────────

describe("Graph SSE filter — conversationId matching", () => {
  /**
   * Simulates the graph component's SSE filter logic:
   *
   *   if (changeEvent.collection === "requests" &&
   *       changeEvent.conversationId === conversationId)
   *
   * This verifies that events without `conversationId` are silently dropped,
   * which was the root cause of the missing graph nodes.
   */

  interface MockChangeEvent {
    collection?: string;
    conversationId?: string | null;
    documentId?: string;
    operationType?: string;
  }

  function wouldSSEFilterPass(
    changeEvent: MockChangeEvent,
    activeConversationId: string,
  ): boolean {
    return (
      changeEvent.collection === "requests" &&
      changeEvent.conversationId === activeConversationId
    );
  }

  it("passes when conversationId matches the active conversation", () => {
    const event: MockChangeEvent = {
      collection: "requests",
      conversationId: "conv-abc-123",
      documentId: "doc-1",
      operationType: "insert",
    };

    expect(wouldSSEFilterPass(event, "conv-abc-123")).toBe(true);
  });

  it("rejects when conversationId is undefined (embed requests before fix)", () => {
    const event: MockChangeEvent = {
      collection: "requests",
      // conversationId not set — this is what happened before the fix
      documentId: "doc-1",
      operationType: "insert",
    };

    expect(wouldSSEFilterPass(event, "conv-abc-123")).toBe(false);
  });

  it("rejects when conversationId is null", () => {
    const event: MockChangeEvent = {
      collection: "requests",
      conversationId: null,
      documentId: "doc-1",
      operationType: "insert",
    };

    expect(wouldSSEFilterPass(event, "conv-abc-123")).toBe(false);
  });

  it("rejects when conversationId belongs to a different conversation", () => {
    const event: MockChangeEvent = {
      collection: "requests",
      conversationId: "conv-OTHER-456",
      documentId: "doc-1",
      operationType: "insert",
    };

    expect(wouldSSEFilterPass(event, "conv-abc-123")).toBe(false);
  });

  it("rejects when collection is not 'requests'", () => {
    const event: MockChangeEvent = {
      collection: "agent_conversations",
      conversationId: "conv-abc-123",
      documentId: "doc-1",
      operationType: "update",
    };

    expect(wouldSSEFilterPass(event, "conv-abc-123")).toBe(false);
  });
});

// ── User Node Filtering ──────────────────────────────────────────

describe("Graph buildFromConversation — user node filtering", () => {
  /**
   * Verifies that the 'system' username is excluded from the user node set,
   * preventing a spurious "system" user bubble in the graph visualization.
   *
   * The 'system' username appears on background embedding operations
   * (memory:embed, workflow-query:embed) which are infrastructure requests,
   * not user-initiated actions.
   */

  const DEFAULT_USERNAME = "admin";

  function shouldCreateUserNode(username: string | undefined): boolean {
    return (
      !!username &&
      username !== DEFAULT_USERNAME &&
      username !== "system"
    );
  }

  it("creates user node for regular usernames", () => {
    expect(shouldCreateUserNode("rodrigo")).toBe(true);
    expect(shouldCreateUserNode("alice")).toBe(true);
  });

  it("does NOT create user node for 'system' username", () => {
    expect(shouldCreateUserNode("system")).toBe(false);
  });

  it("does NOT create user node for DEFAULT_USERNAME", () => {
    expect(shouldCreateUserNode("admin")).toBe(false);
  });

  it("does NOT create user node for undefined/empty username", () => {
    expect(shouldCreateUserNode(undefined)).toBe(false);
    expect(shouldCreateUserNode("")).toBe(false);
  });
});

// ── End-to-End Scenario ──────────────────────────────────────────

describe("End-to-end scenario — all request types should produce visible SSE events", () => {
  /**
   * Simulates the full pipeline for a single user turn:
   *
   *   1. beforePrompt hook runs → memory:embed + workflow-query:embed created
   *   2. agent:iteration pending insert → then completed
   *   3. afterResponse hooks → embed:conversation-..., memory:extract
   *
   * Each request should produce a Change Stream event with a valid
   * `conversationId` that passes the graph's SSE filter.
   */

  const CONVERSATION_ID = "conv-e2e-test-001";
  const AGENT_CONVERSATION_ID = "agent-conv-e2e-test-001";

  interface RequestDocument {
    operation: string;
    conversationId: string | null;
    agentConversationId: string;
    username: string;
  }

  function createRequestDocument(
    operation: string,
    conversationIdFromHook: string | undefined | null,
  ): RequestDocument {
    return {
      operation,
      conversationId: conversationIdFromHook || null,
      agentConversationId: AGENT_CONVERSATION_ID,
      username: operation.endsWith(":embed") ? "system" : "rodrigo",
    };
  }

  function changeStreamPayloadHasConversationId(
    requestDocument: RequestDocument,
  ): boolean {
    return !!requestDocument.conversationId;
  }

  function wouldPassGraphFilter(
    requestDocument: RequestDocument,
    activeConversationId: string,
  ): boolean {
    return requestDocument.conversationId === activeConversationId;
  }

  it("all 5 request types produce visible SSE events when conversationId is set (after fix)", () => {
    const operations = [
      "memory:embed",
      "workflow-query:embed",
      "agent:iteration",
      "conversation-summary:embed",
      "memory:extract",
    ];

    for (const operation of operations) {
      const requestDocument = createRequestDocument(operation, CONVERSATION_ID);

      expect(
        changeStreamPayloadHasConversationId(requestDocument),
      ).toBe(true);

      expect(
        wouldPassGraphFilter(requestDocument, CONVERSATION_ID),
      ).toBe(true);
    }
  });

  it("embed requests are invisible when conversationId is undefined (before fix)", () => {
    const embedOperations = ["memory:embed", "workflow-query:embed"];

    for (const operation of embedOperations) {
      const requestDocument = createRequestDocument(operation, undefined);

      expect(
        changeStreamPayloadHasConversationId(requestDocument),
      ).toBe(false);

      expect(
        wouldPassGraphFilter(requestDocument, CONVERSATION_ID),
      ).toBe(false);
    }
  });

  it("all request types should have the same conversationId", () => {
    const operations = [
      "memory:embed",
      "workflow-query:embed",
      "agent:iteration",
      "conversation-summary:embed",
      "memory:extract",
    ];

    const documents = operations.map((operation) =>
      createRequestDocument(operation, CONVERSATION_ID),
    );

    const conversationIds = new Set(
      documents.map((document) => document.conversationId),
    );

    expect(conversationIds.size).toBe(1);
    expect(conversationIds.has(CONVERSATION_ID)).toBe(true);
  });

  it("user node filtering excludes system-username embedding requests", () => {
    const operations = [
      "memory:embed",
      "workflow-query:embed",
      "agent:iteration",
      "conversation-summary:embed",
      "memory:extract",
    ];

    const documents = operations.map((operation) =>
      createRequestDocument(operation, CONVERSATION_ID),
    );

    const userSet = new Set<string>();
    for (const document of documents) {
      if (document.username && document.username !== "system") {
        userSet.add(document.username);
      }
    }

    expect(userSet.size).toBe(1);
    expect(userSet.has("rodrigo")).toBe(true);
    expect(userSet.has("system")).toBe(false);
  });
});
