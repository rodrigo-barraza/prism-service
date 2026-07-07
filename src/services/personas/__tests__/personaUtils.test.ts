import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  extractDiscoverableDomains,
  extractDomainKeywords,
  buildToolPolicy,
  getToolPolicyAddendum,
} from "../utils.ts";
import ToolOrchestratorService from "../../ToolOrchestratorService.ts";

const mockGetClientToolSchemas = vi.fn();

vi.mock("../../ToolOrchestratorService.ts", () => ({
  default: {
    getClientToolSchemas: () => mockGetClientToolSchemas(),
  },
}));

describe("Persona Utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("extractDiscoverableDomains", () => {
    it("should extract and sort unique domains, excluding Core domains", () => {
      mockGetClientToolSchemas.mockReturnValue([
        { name: "read_file", domain: "Filesystem" },
        { name: "write_file", domain: "Filesystem" },
        { name: "execute_command", domain: "Core System" },
        { name: "web_search", domain: "Search Engine" },
      ]);

      const discoverableDomains = extractDiscoverableDomains();
      expect(discoverableDomains).toEqual(["Filesystem", "Search Engine"]);
    });

    it("should return empty array if no tool schemas have domains", () => {
      mockGetClientToolSchemas.mockReturnValue([
        { name: "read_file" },
      ]);

      const discoverableDomains = extractDiscoverableDomains();
      expect(discoverableDomains).toEqual([]);
    });
  });

  describe("extractDomainKeywords", () => {
    it("should extract keywords for domains up to maxPerDomain, replacing underscores", () => {
      mockGetClientToolSchemas.mockReturnValue([
        { name: "read_file", domain: "Filesystem" },
        { name: "write_to_file", domain: "Filesystem" },
        { name: "list_dir_contents", domain: "Filesystem" },
        { name: "delete_file", domain: "Filesystem" },
        { name: "create_directory", domain: "Filesystem" }, // exceeds limit of 4
        { name: "web_search", domain: "Search Engine" },
        { name: "system_info", domain: "Core System" }, // ignored core domain
      ]);

      const keywordMap = extractDomainKeywords(4);

      expect(keywordMap.has("Filesystem")).toBe(true);
      expect(keywordMap.get("Filesystem")).toEqual([
        "read file",
        "write to file",
        "list dir contents",
        "delete file",
      ]);

      expect(keywordMap.has("Search Engine")).toBe(true);
      expect(keywordMap.get("Search Engine")).toEqual(["web search"]);

      expect(keywordMap.has("Core System")).toBe(false);
    });
  });

  describe("buildToolPolicy", () => {
    it("should assemble policy matching requirements from enabled tools context", () => {
      mockGetClientToolSchemas.mockReturnValue([
        { name: "read_file", domain: "Filesystem" },
      ]);

      const customSections = [
        {
          content: "Filesystem guidelines content.",
          requires: ["read_file"],
        },
        {
          content: "Write-only guidelines content.",
          requires: ["write_file"],
        },
      ];

      const personaContext = {
        enabledTools: ["read_file", TOOL_NAMES.SAVE_MEMORY, TOOL_NAMES.CREATE_TASK, TOOL_NAMES.LIST_TASKS, TOOL_NAMES.UPDATE_TASK],
      };

      const resultPolicy = buildToolPolicy(customSections, personaContext);

      // Should contain principles, discovery section (as it requires search_tools or discover_and_enable which are not enabled here, wait... does it?)
      // Let's check: TOOL_DISCOVERY_POLICY_SECTION requires SEARCH_TOOLS and DISCOVER_AND_ENABLE_TOOLS.
      // Neither are enabled in personaContext, so discovery should be excluded.
      // But TASK_MANAGEMENT and PROACTIVE_MEMORY are enabled (requires are met).
      expect(resultPolicy).toContain("# Tool Use Principles");
      expect(resultPolicy).toContain("Filesystem guidelines content.");
      expect(resultPolicy).toContain("## Task Management");
      expect(resultPolicy).toContain("## Proactive Memory");

      expect(resultPolicy).not.toContain("Write-only guidelines content.");
      expect(resultPolicy).not.toContain("## Tool Discovery (CRITICAL)");
    });
  });

  describe("getToolPolicyAddendum", () => {
    it("should return content of matched policy sections for newly enabled tools", () => {
      const addendumText = getToolPolicyAddendum([TOOL_NAMES.SAVE_MEMORY]);
      expect(addendumText).toContain("## Proactive Memory");
      expect(addendumText).not.toContain("## Task Management");
    });

    it("should return empty string if no newly enabled tools match policy requires", () => {
      const addendumText = getToolPolicyAddendum(["random_tool"]);
      expect(addendumText).toBe("");
    });
  });
});
