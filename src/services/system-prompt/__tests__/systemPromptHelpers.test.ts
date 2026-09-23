import { describe, it, expect, vi, beforeEach } from "vitest";
import { DirectoryTreeFormatter } from "#src/services/system-prompt/DirectoryTreeFormatter";
import { SkillMemoryScorer } from "#src/services/system-prompt/SkillMemoryScorer";
import { ToolDocFormatter } from "#src/services/system-prompt/ToolDocFormatter";
import MemoryService from "#src/services/MemoryService";
import EmbeddingService from "#src/services/EmbeddingService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import { createMockCollection } from "../../../../tests/mongoMock.ts";

// ── Mocks ──────────────────────────────────────────────────────
vi.mock("#src/services/MemoryService", () => ({
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

vi.mock("#src/services/EmbeddingService", () => ({
  default: {
    embed: vi.fn(),
  },
}));

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn(),
    getCollection: vi.fn(),
  },
}));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getClientToolSchemas: vi.fn(),
  },
}));

vi.mock("#src/services/AgentPersonaRegistry", () => ({
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

  describe("fetchSkillCatalog", () => {
    const panelSkill = (name: string, embedding?: number[]) => ({
      _id: `id-${name}`,
      project: "test-project",
      username: "rodrigo",
      profileId: "default",
      name,
      description: `${name} description`,
      content: `${name} content`,
      enabled: true,
      ...(embedding ? { embedding } : {}),
    });
    const useSkills = (skills: Array<Record<string, unknown>>) =>
      vi.mocked(MongoWrapper.getCollection).mockReturnValue(
        createMockCollection(skills) as any,
      );

    it("returns the catalog without highlights when queryText is empty", async () => {
      useSkills([panelSkill("deploy", [1, 0, 0])]);

      const scorer = new SkillMemoryScorer();
      const result = await scorer.fetchSkillCatalog("test-project", "rodrigo", "");

      expect(result).toEqual({
        entries: [{ name: "deploy", description: "deploy description" }],
        highlighted: [],
      });
      expect(EmbeddingService.embed).not.toHaveBeenCalled();
    });

    it("highlights skills by similarity, keeping every skill in the catalog", async () => {
      useSkills([panelSkill("deploy", [1, 0, 0]), panelSkill("build", [0, 1, 0])]);
      vi.mocked(EmbeddingService.embed).mockResolvedValueOnce([1, 0, 0]); // matches deploy

      const scorer = new SkillMemoryScorer();
      const result = await scorer.fetchSkillCatalog("test-project", "rodrigo", "deploy");

      // build is 0.0 similarity — below the 0.3 threshold, still in the catalog
      expect(result.entries.map((entry) => entry.name)).toEqual(["build", "deploy"]);
      expect(result.highlighted).toEqual(["deploy"]);
      expect(JSON.stringify(result)).not.toContain("content");
    });

    it("keeps the catalog and drops highlights if embedding generation throws", async () => {
      useSkills([panelSkill("deploy", [1, 0, 0])]);
      vi.mocked(EmbeddingService.embed).mockRejectedValueOnce(new Error("Embedding API rate limit"));

      const scorer = new SkillMemoryScorer();
      const result = await scorer.fetchSkillCatalog("test-project", "rodrigo", "deploy");

      expect(result).toEqual({
        entries: [{ name: "deploy", description: "deploy description" }],
        highlighted: [],
      });
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
