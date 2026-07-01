import { describe, it, expect, vi, beforeEach } from "vitest";
import { DirectoryTreeFormatter } from "../src/services/system-prompt/DirectoryTreeFormatter.ts";
import { SkillMemoryScorer } from "../src/services/system-prompt/SkillMemoryScorer.ts";
import { ToolDocFormatter } from "../src/services/system-prompt/ToolDocFormatter.ts";
import MemoryService from "../src/services/MemoryService.ts";
import EmbeddingService from "../src/services/EmbeddingService.ts";
import MongoWrapper from "../src/wrappers/MongoWrapper.ts";
import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";
import AgentPersonaRegistry from "../src/services/AgentPersonaRegistry.ts";

// ── Mocks ──────────────────────────────────────────────────────
vi.mock("../src/services/MemoryService.ts", () => ({
  default: {
    search: vi.fn(),
    formatForPrompt: vi.fn().mockImplementation((memories) =>
      memories
        .map((memory: any) => {
          const badge = `[${memory.type || "other"}]`;
          const title = memory.title || (memory.content ? memory.content.substring(0, 60) : "untitled");
          return `- ${badge} **${title}**: ${memory.content}`;
        })
        .join("\n")
    ),
  },
}));

vi.mock("../src/services/EmbeddingService.ts", () => ({
  default: {
    embed: vi.fn(),
  },
}));

vi.mock("../src/wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: vi.fn(),
  },
}));

vi.mock("../src/services/ToolOrchestratorService.ts", () => ({
  default: {
    getClientToolSchemas: vi.fn(),
  },
}));

vi.mock("../src/services/AgentPersonaRegistry.ts", () => ({
  default: {
    get: vi.fn(),
  },
}));

describe("DirectoryTreeFormatter", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = originalFetch;
  });

  it("should fetch, format, and cache directory tree correctly", async () => {
    const mockDirectoryData = {
      entries: [
        {
          name: "src",
          type: "directory",
          children: [
            { name: "index.ts", type: "file" },
            { name: "utils.ts", type: "file" }
          ]
        },
        {
          name: "package.json",
          type: "file"
        }
      ]
    };

    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => mockDirectoryData,
    };

    global.fetch = vi.fn().mockResolvedValue(mockResponse as any);

    const formatter = new DirectoryTreeFormatter("/home/rodrigo/development");
    const firstFetchResult = await formatter.fetchDirectoryTree();

    expect(firstFetchResult).toContain("📁 src");
    expect(firstFetchResult).toContain("  📄 index.ts");
    expect(firstFetchResult).toContain("  📄 utils.ts");
    expect(firstFetchResult).toContain("📄 package.json");

    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Fetch again immediately, should return cache and not call fetch
    const secondFetchResult = await formatter.fetchDirectoryTree();
    expect(secondFetchResult).toBe(firstFetchResult);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("should handle error gracefully and return empty or last cached content", async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("Network failure"));

    const formatter = new DirectoryTreeFormatter("/home/rodrigo/development");
    const result = await formatter.fetchDirectoryTree();
    expect(result).toBe("");
  });
});

describe("SkillMemoryScorer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("fetchMemories", () => {
    it("should search and format relevant memories correctly", async () => {
      const mockMemories = [
        { id: "memory-id-1", type: "user", title: "Deployment preference", content: "User likes to deploy to staging using task runners." }
      ];
      vi.mocked(MemoryService.search).mockResolvedValueOnce(mockMemories as any);

      const scorer = new SkillMemoryScorer();
      const result = await scorer.fetchMemories("CODING", "test-project", "staging deploy");

      expect(MemoryService.search).toHaveBeenCalledWith(expect.objectContaining({
        agent: "CODING",
        project: "test-project",
        queryText: "staging deploy",
      }));
      expect(result.memoriesText).toBe("- [user] **Deployment preference**: User likes to deploy to staging using task runners.");
      expect(result.injectedMemoryIds).toEqual(["memory-id-1"]);
    });

    it("should return empty string if search returns no results", async () => {
      vi.mocked(MemoryService.search).mockResolvedValueOnce([]);
      const scorer = new SkillMemoryScorer();
      const result = await scorer.fetchMemories("CODING", "test-project", "query");
      expect(result).toEqual({ memoriesText: "", injectedMemoryIds: [] });
    });
  });

  describe("fetchSkills", () => {
    it("should fallback to all skills with score=1 if queryText is empty", async () => {
      const mockSkills = [
        { name: "deploy", content: "deploy content", description: "deploy description" }
      ];
      const mockDatabase = {
        collection: () => ({
          find: () => ({
            project: () => ({
              toArray: async () => mockSkills
            })
          })
        })
      };
      vi.mocked(MongoWrapper.getDb).mockReturnValueOnce(mockDatabase as any);

      const scorer = new SkillMemoryScorer();
      const result = await scorer.fetchSkills("test-project", "rodrigo", "");

      expect(result).toEqual([
        { name: "deploy", content: "deploy content", description: "deploy description", score: 1 }
      ]);
    });

    it("should score skills by similarity if embeddings are present", async () => {
      const mockSkills = [
        { name: "deploy", content: "deploy content", description: "deploy description", embedding: [1, 0, 0] },
        { name: "build", content: "build content", description: "build description", embedding: [0, 1, 0] }
      ];
      const mockDatabase = {
        collection: () => ({
          find: () => ({
            project: () => ({
              toArray: async () => mockSkills
            })
          })
        })
      };
      vi.mocked(MongoWrapper.getDb).mockReturnValueOnce(mockDatabase as any);
      vi.mocked(EmbeddingService.embed).mockResolvedValueOnce([1, 0, 0]); // matches deploy

      const scorer = new SkillMemoryScorer();
      const result = await scorer.fetchSkills("test-project", "rodrigo", "deploy");

      expect(result).toHaveLength(1); // deploy is 1.0 similarity, build is 0.0 (below 0.3 threshold)
      expect(result[0]).toEqual({
        name: "deploy",
        content: "deploy content",
        description: "deploy description",
        score: 1,
      });
    });

    it("should return all skills with score=1 if embedding generation throws", async () => {
      const mockSkills = [
        { name: "deploy", content: "deploy content", description: "deploy description", embedding: [1, 0, 0] }
      ];
      const mockDatabase = {
        collection: () => ({
          find: () => ({
            project: () => ({
              toArray: async () => mockSkills
            })
          })
        })
      };
      vi.mocked(MongoWrapper.getDb).mockReturnValueOnce(mockDatabase as any);
      vi.mocked(EmbeddingService.embed).mockRejectedValueOnce(new Error("Embedding API rate limit"));

      const scorer = new SkillMemoryScorer();
      const result = await scorer.fetchSkills("test-project", "rodrigo", "deploy");

      expect(result).toEqual([
        { name: "deploy", content: "deploy content", description: "deploy description", score: 1 }
      ]);
    });
  });
});

describe("ToolDocFormatter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockToolSchemas = [
    {
      name: "read_file",
      description: "Read file contents. Essential for coding.",
      domain: "Filesystem",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to file." }
        },
        required: ["path"]
      }
    },
    {
      name: "run_tests",
      description: "Run vitest suite. Highly useful.",
      domain: "Testing",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Target test file." }
        },
        required: []
      }
    }
  ];

  it("should build structured tool documentation sorted by domain", () => {
    vi.mocked(ToolOrchestratorService.getClientToolSchemas).mockReturnValueOnce(mockToolSchemas as any);

    const formatter = new ToolDocFormatter();
    const resultDoc = formatter.buildToolDescriptions(undefined, null);

    expect(resultDoc).toContain("**Filesystem**");
    expect(resultDoc).toContain("### read_file");
    expect(resultDoc).toContain("Read file contents. Essential for coding.");
    expect(resultDoc).toContain("- path (required): Absolute path to file.");

    expect(resultDoc).toContain("**Testing**");
    expect(resultDoc).toContain("### run_tests");
    expect(resultDoc).toContain("- file: Target test file.");
  });

  it("should support compact mode, truncating descriptions and only returning required parameters", () => {
    vi.mocked(ToolOrchestratorService.getClientToolSchemas).mockReturnValueOnce(mockToolSchemas as any);

    const formatter = new ToolDocFormatter();
    const resultDoc = formatter.buildToolDescriptions(undefined, null, undefined, undefined, undefined, true);

    expect(resultDoc).toContain("**Filesystem**");
    expect(resultDoc).toContain("### read_file");
    expect(resultDoc).toContain("Read file contents."); // Truncated first sentence
    expect(resultDoc).toContain("- path (required): Absolute path to file.");

    expect(resultDoc).toContain("**Testing**");
    expect(resultDoc).toContain("### run_tests");
    expect(resultDoc).toContain("Run vitest suite.");
    expect(resultDoc).not.toContain("- file"); // Omitted because it's not required
  });
});
