import "./setup.ts";
import { describe, it, expect, beforeAll } from "vitest";
import ToolOrchestratorService from "../src/services/ToolOrchestratorService.ts";
import InternalToolRegistry from "../src/services/local-tools/InternalToolRegistry.ts";
import {
  extractDiscoverableDomains,
  extractDomainKeywords,
  buildToolPolicy,
} from "../src/services/personas/utils.ts";
import { ToolDocFormatter } from "../src/services/system-prompt/ToolDocFormatter.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

describe("Dynamic Tool Discovery & Prompt Injection", () => {
  // 1. Catalog & Recursion Tests
  describe("Catalog Introspection & Recursion Guard", () => {
    it("should not trigger infinite recursion when retrieving client schemas", () => {
      expect(() => {
        const clientToolSchemas = ToolOrchestratorService.getClientToolSchemas();
        expect(clientToolSchemas).toBeDefined();
        expect(Array.isArray(clientToolSchemas)).toBe(true);
        expect(clientToolSchemas.length).toBeGreaterThan(0);
      }).not.toThrow();
    });

    it("should generate dynamic descriptions and examples for discover_and_enable_tools", () => {
      const clientToolSchemas = ToolOrchestratorService.getClientToolSchemas();
      const discoverAndEnableToolSchema = clientToolSchemas.find((tool) => tool.name === "discover_and_enable_tools");

      expect(discoverAndEnableToolSchema).toBeDefined();
      if (!discoverAndEnableToolSchema) {
        throw new Error("discover_and_enable_tools schema not found");
      }
      expect(discoverAndEnableToolSchema.description).toContain("Search the FULL tool catalog");
      expect(discoverAndEnableToolSchema.description).toContain("Covers all domains: weather");

      const parameters = discoverAndEnableToolSchema.parameters as Record<string, any> | undefined;
      const queryParameterDescription = parameters?.properties?.query?.description;
      expect(queryParameterDescription).toBeDefined();
      expect(queryParameterDescription).toContain("Examples: 'get weather'");

      const domainParameterDescription = parameters?.properties?.domain?.description;
      expect(domainParameterDescription).toBeDefined();
      expect(domainParameterDescription).toContain("Known domains: 'Weather'");
    });

    it("should filter out core harness/workspace domains from discoverable list", () => {
      const discoverableDomainsList = extractDiscoverableDomains();
      expect(discoverableDomainsList).toContain("Weather");
      expect(discoverableDomainsList).not.toContain("Core Workspace Tools");
      expect(discoverableDomainsList).not.toContain("Core Harness Tools");
      expect(discoverableDomainsList).not.toContain("Core Orchestrator Tools");
    });

    it("should humanize and extract keywords per domain dynamically", () => {
      const keywordsByDomainMap = extractDomainKeywords(2);
      expect(keywordsByDomainMap.has("Weather")).toBe(true);
      expect(keywordsByDomainMap.get("Weather")).toEqual(["get weather"]);
    });
  });

  // 2. Prompt Policy Tests (buildToolPolicy)
  describe("buildToolPolicy Dynamic Prompt Logic", () => {
    it("should include dynamic Tool Discovery prompt section when search_tools is enabled", () => {
      const systemPromptContent = buildToolPolicy([], {
        enabledTools: [TOOL_NAMES.SEARCH_TOOLS],
      });

      expect(systemPromptContent).toContain("## Tool Discovery (CRITICAL)");
      expect(systemPromptContent).toContain("Available Tool Domains:");
      expect(systemPromptContent).toContain("Weather");
      expect(systemPromptContent).toContain("- \"get weather\" → search for Weather tools");
    });

    it("should exclude dynamic Tool Discovery prompt section when search_tools is NOT enabled", () => {
      const systemPromptContent = buildToolPolicy([], {
        enabledTools: ["get_weather"],
      });

      expect(systemPromptContent).not.toContain("## Tool Discovery (CRITICAL)");
    });
  });

  // 3. Prompt Tool Formatting Tests (ToolDocFormatter)
  describe("ToolDocFormatter Prompt Injection & Visibility", () => {
    it("should dynamically add, hide, or remove enabled tools in prompt description", () => {
      const toolDocFormatter = new ToolDocFormatter();

      // Case A: With get_weather not enabled, it should be hidden
      const promptWithoutWeather = toolDocFormatter.buildToolDescriptions([]);
      expect(promptWithoutWeather).not.toContain("### get_weather");

      // Case B: Adding get_weather to enabledTools should make it visible
      const promptWithWeather = toolDocFormatter.buildToolDescriptions(["get_weather"]);
      expect(promptWithWeather).toContain("### get_weather");

      // Case C: Removing get_weather from enabledTools should hide it again
      const promptAfterRemovingWeather = toolDocFormatter.buildToolDescriptions([]);
      expect(promptAfterRemovingWeather).not.toContain("### get_weather");
    });
  });
});
