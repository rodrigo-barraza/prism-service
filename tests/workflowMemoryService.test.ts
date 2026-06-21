import { describe, it, expect, vi, beforeEach } from "vitest";
import WorkflowMemoryService from "../src/services/WorkflowMemoryService.ts";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import EmbeddingService from "../src/services/EmbeddingService.ts";
import type { AgenticContext, ConversationMessage } from "../src/services/harnesses/types.ts";

vi.mock("../src/wrappers/MongoWrapper.ts", () => {
  const mockGetDb = vi.fn();
  return {
    default: {
      getDb: mockGetDb,
    },
  };
});

vi.mock("../src/services/EmbeddingService.ts", () => {
  return {
    default: {
      embed: vi.fn().mockImplementation(async (text: string) => {
        if (text.includes("compile error") || text.includes("build failing")) {
          return [1.0, 0.0, 0.0];
        }
        if (text.includes("lint error") || text.includes("formatting")) {
          return [0.0, 1.0, 0.0];
        }
        return [0.0, 0.0, 1.0];
      }),
    },
  };
});

describe("WorkflowMemoryService", () => {
  let mockWorkflowCollection: any;
  let storedDocuments: any[];

  beforeEach(() => {
    vi.clearAllMocks();
    storedDocuments = [];

    mockWorkflowCollection = {
      countDocuments: vi.fn().mockImplementation(async () => {
        return storedDocuments.length;
      }),
      findOne: vi.fn().mockImplementation(async (query: any) => {
        return storedDocuments.find((document) => {
          return (
            document.conversationId === query.conversationId &&
            document.agentConversationId === query.agentConversationId
          );
        }) || null;
      }),
      updateOne: vi.fn().mockImplementation(async (query: any, update: any, options: any = {}) => {
        const setFields = update.$set || {};
        const index = storedDocuments.findIndex((document) => {
          return (
            document.conversationId === query.conversationId &&
            document.agentConversationId === query.agentConversationId
          );
        });

        if (index >= 0) {
          storedDocuments[index] = { ...storedDocuments[index], ...setFields };
        } else if (options.upsert) {
          storedDocuments.push({ ...query, ...setFields });
        }

        return { matchedCount: index >= 0 ? 1 : 0, modifiedCount: 1, upsertedCount: index >= 0 ? 0 : 1 };
      }),
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockImplementation(async () => {
              return storedDocuments;
            }),
          }),
        }),
      }),
    };

    (MongoWrapper.getDb as any).mockReturnValue({
      collection: () => mockWorkflowCollection,
    });
  });

  describe("extractAndPersist", () => {
    const defaultAgenticContext: AgenticContext = {
      conversationId: "main-convo-123",
      agentConversationId: "sub-convo-456",
      project: "prism-chat",
      username: "testuser",
      agent: "CODING",
      messages: [],
      traceId: "trace-xyz",
      options: {},
      provider: {
        generateTextStream: vi.fn(),
      },
      providerName: "google",
      resolvedModel: "gemini-3.5-flash",
      emit: vi.fn(),
    };

    function generateMessagesWithToolCalls(toolCallCount: number): ConversationMessage[] {
      const messages: ConversationMessage[] = [
        { role: "user", content: "Fix the build failing with compile error" },
      ];

      for (let index = 0; index < toolCallCount; index++) {
        messages.push({
          role: "assistant",
          content: `Running step ${index}`,
          toolCalls: [
            {
              id: `call-${index}`,
              name: `tool_${index}`,
              args: { parameter: `value_${index}` },
              result: { success: true },
            },
          ],
        });
        messages.push({
          role: "tool",
          content: JSON.stringify({ success: true }),
          toolCallId: `call-${index}`,
        });
      }
      return messages;
    }

    it("should extract trajectory, create embeddings, and persist a successful trajectory", async () => {
      const messages = generateMessagesWithToolCalls(3);
      const outcome = { messages, sessionOutcome: "completed" };

      await WorkflowMemoryService.extractAndPersist(defaultAgenticContext, outcome);

      expect(storedDocuments).toHaveLength(1);
      const savedWorkflow = storedDocuments[0];
      expect(savedWorkflow.conversationId).toBe("main-convo-123");
      expect(savedWorkflow.agentConversationId).toBe("sub-convo-456");
      expect(savedWorkflow.project).toBe("prism-chat");
      expect(savedWorkflow.userRequest).toBe("Fix the build failing with compile error");
      expect(savedWorkflow.stepCount).toBe(3);
      expect(savedWorkflow.steps).toHaveLength(3);
      expect(savedWorkflow.steps[0].toolName).toBe("tool_0");
      expect(savedWorkflow.steps[0].isSuccess).toBe(true);
      expect(savedWorkflow.embedding).toEqual([1.0, 0.0, 0.0]);
    });

    it("should abort and not persist if conversationId or agentConversationId is missing", async () => {
      const messages = generateMessagesWithToolCalls(3);
      const outcome = { messages, sessionOutcome: "completed" };

      const invalidContext = { ...defaultAgenticContext, conversationId: "" };
      await WorkflowMemoryService.extractAndPersist(invalidContext, outcome);
      expect(storedDocuments).toHaveLength(0);
    });

    it("should abort and not persist if project is not a recognized agent project", async () => {
      const messages = generateMessagesWithToolCalls(3);
      const outcome = { messages, sessionOutcome: "completed" };

      const invalidContext = { ...defaultAgenticContext, project: "non-existent-project" };
      await WorkflowMemoryService.extractAndPersist(invalidContext, outcome);
      expect(storedDocuments).toHaveLength(0);
    });

    it("should abort and not persist if the session outcome is not completed", async () => {
      const messages = generateMessagesWithToolCalls(3);
      const outcome = { messages, sessionOutcome: "failed" };

      await WorkflowMemoryService.extractAndPersist(defaultAgenticContext, outcome);
      expect(storedDocuments).toHaveLength(0);
    });

    it("should abort and not persist if messages array is too short", async () => {
      const messages = generateMessagesWithToolCalls(1).slice(0, 2);
      const outcome = { messages, sessionOutcome: "completed" };

      await WorkflowMemoryService.extractAndPersist(defaultAgenticContext, outcome);
      expect(storedDocuments).toHaveLength(0);
    });

    it("should abort and not persist if tool calls are fewer than the minimum limit of 3", async () => {
      const messages = generateMessagesWithToolCalls(2);
      const outcome = { messages, sessionOutcome: "completed" };

      await WorkflowMemoryService.extractAndPersist(defaultAgenticContext, outcome);
      expect(storedDocuments).toHaveLength(0);
    });

    it("should respect cooldown and not update if another workflow was saved recently under same ID", async () => {
      const messages = generateMessagesWithToolCalls(3);
      const outcome = { messages, sessionOutcome: "completed" };

      storedDocuments.push({
        conversationId: "main-convo-123",
        agentConversationId: "sub-convo-456",
        project: "prism-chat",
        createdAt: new Date().toISOString(),
      });

      await WorkflowMemoryService.extractAndPersist(defaultAgenticContext, outcome);
      // It should return early without updating because of cooldown
      expect(EmbeddingService.embed).not.toHaveBeenCalled();
    });

    it("should proceed and overwrite existing workflow if cooldown time has expired", async () => {
      const messages = generateMessagesWithToolCalls(3);
      const outcome = { messages, sessionOutcome: "completed" };

      storedDocuments.push({
        conversationId: "main-convo-123",
        agentConversationId: "sub-convo-456",
        project: "prism-chat",
        createdAt: new Date(Date.now() - 70 * 1000).toISOString(), // older than 60s
      });

      await WorkflowMemoryService.extractAndPersist(defaultAgenticContext, outcome);
      expect(EmbeddingService.embed).toHaveBeenCalled();
      expect(storedDocuments[0].stepCount).toBe(3);
    });
  });

  describe("retrieveRelevantWorkflows", () => {
    beforeEach(() => {
      // Seed two workflows: one close to "build failing" (compile error theme)
      // and another close to "lint error" (formatting theme)
      storedDocuments.push({
        conversationId: "convo-build-fix",
        agentConversationId: "sub-build-fix",
        project: "prism-chat",
        agent: "CODING",
        userRequest: "Resolve compilation failures",
        summary: "Task: Resolve compilation failures\n1. ✓ compile_code()",
        embedding: [1.0, 0.0, 0.0],
        createdAt: new Date().toISOString(),
      });

      storedDocuments.push({
        conversationId: "convo-lint-fix",
        agentConversationId: "sub-lint-fix",
        project: "prism-chat",
        agent: "CODING",
        userRequest: "Format code styling",
        summary: "Task: Format code styling\n1. ✓ eslint_fix()",
        embedding: [0.0, 1.0, 0.0],
        createdAt: new Date().toISOString(),
      });
    });

    it("should return formatted workflow block for close matches", async () => {
      const result = await WorkflowMemoryService.retrieveRelevantWorkflows(
        "CODING",
        "prism-chat",
        "Fix the build failing with compile error",
      );

      expect(result).not.toBeNull();
      if (result) {
        expect(result).toContain("## Past Successful Workflows");
        expect(result).toContain("Resolve compilation failures");
        // Cosine similarity between [1,0,0] (query) and [1,0,0] is 100%
        expect(result).toContain("similarity: 100%");
        // Should not contain the lint workflow (similarity with [0,1,0] is 0%)
        expect(result).not.toContain("Format code styling");
      }
    });

    it("should return null if project or queryText is missing", async () => {
      const projectResult = await WorkflowMemoryService.retrieveRelevantWorkflows("CODING", "", "compile error");
      expect(projectResult).toBeNull();

      const queryResult = await WorkflowMemoryService.retrieveRelevantWorkflows("CODING", "prism-chat", "");
      expect(queryResult).toBeNull();
    });

    it("should return null if there are no workflow logs in database for the given agent project", async () => {
      storedDocuments = [];
      const result = await WorkflowMemoryService.retrieveRelevantWorkflows("CODING", "prism-chat", "compile error");
      expect(result).toBeNull();
    });

    it("should return null if no workflow exceeds the threshold similarity score of 40%", async () => {
      const result = await WorkflowMemoryService.retrieveRelevantWorkflows(
        "CODING",
        "prism-chat",
        "Some unrelated query that maps to standard vector",
      );
      // Query "Some unrelated query..." will return [0.0, 0.0, 1.0], similarity with [1,0,0] is 0% (< 40%)
      expect(result).toBeNull();
    });
  });
});
