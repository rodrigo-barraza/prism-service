// ────────────────────────────────────────────────────────────
// ToolDiscoveryScope — innate tool discovery scope logic
// ────────────────────────────────────────────────────────────
// Validates the shared universe/headroom/partition helpers used by
// AgenticToolResolver (discovery tool presence), enable_tools /
// discover_and_enable_tools (activation scoping), pre-flight discovery,
// and search result filtering.
// ────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";
import {
  DISCOVERY_TOOL_NAMES,
  isDiscoveryTool,
  resolveBlockedToolNames,
  hasDiscoveryHeadroom,
  partitionByDiscoverableUniverse,
} from "#src/services/ToolDiscoveryScope";

const SCHEMAS = [
  { name: "get_weather", domain: "Weather & Environment", domainKey: "weather" },
  { name: "get_weather_forecast", domain: "Weather & Environment", domainKey: "weather" },
  { name: "generate_image", domain: "Creative", domainKey: "creative" },
  { name: "get_stock_price", domain: "Finance & Markets", domainKey: "finance" },
  { name: "search_tools", domain: "Core Discover Tools", domainKey: "core_discover" },
  { name: "enable_tools", domain: "Core Discover Tools", domainKey: "core_discover" },
];

describe("ToolDiscoveryScope", () => {
  describe("DISCOVERY_TOOL_NAMES / isDiscoveryTool", () => {
    it("covers the search/enable/discover trio but not disable_tools", () => {
      expect(DISCOVERY_TOOL_NAMES).toContain("search_tools");
      expect(DISCOVERY_TOOL_NAMES).toContain("enable_tools");
      expect(DISCOVERY_TOOL_NAMES).toContain("discover_and_enable_tools");
      expect(isDiscoveryTool("disable_tools")).toBe(false);
      expect(isDiscoveryTool("search_tools")).toBe(true);
    });
  });

  describe("resolveBlockedToolNames", () => {
    it("returns empty set for personas without blockedTools", () => {
      expect(resolveBlockedToolNames(null, SCHEMAS).size).toBe(0);
      expect(resolveBlockedToolNames({}, SCHEMAS).size).toBe(0);
      expect(
        resolveBlockedToolNames({ blockedTools: [] }, SCHEMAS).size,
      ).toBe(0);
    });

    it("expands domainKey: entries and exact names", () => {
      const blocked = resolveBlockedToolNames(
        { blockedTools: ["domainKey:creative", "get_stock_price"] },
        SCHEMAS,
      );
      expect(blocked.has("generate_image")).toBe(true);
      expect(blocked.has("get_stock_price")).toBe(true);
      expect(blocked.has("get_weather")).toBe(false);
    });
  });

  describe("hasDiscoveryHeadroom", () => {
    it("is true when catalog tools exist outside the current set", () => {
      expect(
        hasDiscoveryHeadroom(null, SCHEMAS, new Set(["get_weather"])),
      ).toBe(true);
    });

    it("is false when every catalog tool is already in the current set", () => {
      const all = new Set(SCHEMAS.map((schema) => schema.name));
      expect(hasDiscoveryHeadroom(null, SCHEMAS, all)).toBe(false);
    });

    it("does not count persona-blocked tools as headroom", () => {
      // Everything is enabled except finance — but finance is blocked,
      // so there is nothing discoverable left.
      const current = new Set(
        SCHEMAS.map((schema) => schema.name).filter(
          (name) => name !== "get_stock_price",
        ),
      );
      expect(
        hasDiscoveryHeadroom(
          { blockedTools: ["domainKey:finance"] },
          SCHEMAS,
          current,
        ),
      ).toBe(false);
    });

    it("does not count context-unreachable tools as headroom", () => {
      const current = new Set(
        SCHEMAS.map((schema) => schema.name).filter(
          (name) => name !== "generate_image",
        ),
      );
      // generate_image is the only missing tool, but it is unreachable
      // (e.g. native image model collision) — no headroom.
      expect(
        hasDiscoveryHeadroom(null, SCHEMAS, current, new Set(["generate_image"])),
      ).toBe(false);
      expect(hasDiscoveryHeadroom(null, SCHEMAS, current)).toBe(true);
    });
  });

  describe("partitionByDiscoverableUniverse", () => {
    it("passes everything through for unscoped personas", () => {
      const { allowed, blocked } = partitionByDiscoverableUniverse(
        null,
        SCHEMAS,
        ["get_weather", "generate_image"],
      );
      expect(allowed).toEqual(["get_weather", "generate_image"]);
      expect(blocked).toEqual([]);
    });

    it("splits candidates on the persona denylist", () => {
      const { allowed, blocked } = partitionByDiscoverableUniverse(
        { blockedTools: ["domainKey:creative"] },
        SCHEMAS,
        ["get_weather", "generate_image", "get_stock_price"],
      );
      expect(allowed).toEqual(["get_weather", "get_stock_price"]);
      expect(blocked).toEqual(["generate_image"]);
    });

    it("allows names absent from the catalog (e.g. MCP tools) unless named directly", () => {
      const { allowed, blocked } = partitionByDiscoverableUniverse(
        { blockedTools: ["domainKey:creative", "mcp__github__list_repos"] },
        SCHEMAS,
        ["mcp__github__list_repos", "mcp__github__create_issue"],
      );
      expect(allowed).toEqual(["mcp__github__create_issue"]);
      expect(blocked).toEqual(["mcp__github__list_repos"]);
    });
  });
});
