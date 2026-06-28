/**
 * InternalToolRegistry Locale Tests
 *
 * Validates that InternalToolRegistry correctly localizes tool schemas
 * through both the standard `localizeSchema` path and the `buildSchema`
 * delegation path (used by tools with dynamic schemas like
 * discover_and_enable_tools).
 *
 * Root cause of the original bug: `localizeSchema` had a hardcoded
 * `if (toolName === "discover_and_enable_tools") return schema;` that
 * skipped localization entirely, and the `get schema()` getter read
 * locale from global SettingsService instead of the per-request locale.
 *
 * The fix introduced `buildSchema(locale)` on the InternalTool interface,
 * which `localizeSchema` now calls when present, bypassing the getter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import PromptLocaleService from "../../PromptLocaleService.ts";

// ── Mock heavy services that require DB / network ──────────

vi.mock("../../SettingsService.ts", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      topology: "hierarchical",
      locale: "en",
    }),
    getCached: vi.fn().mockReturnValue({
      agents: { locale: "en", topology: "hierarchical" },
      creative: {},
    }),
  },
}));

vi.mock("../../../utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../RequestLogger.ts", () => ({
  default: {
    logRequest: vi.fn(),
  },
}));

// ── Locale markers for assertions ──────────────────────────

// discover_and_enable_tools
const CAVEMAN_DISCOVER_MARKER = "search all tool";
const ENGLISH_DISCOVER_MARKER = "Search the FULL tool catalog";

// write_todo (standard localizeSchema path)
const CAVEMAN_WRITE_TODO_MARKER = "write/update todo list";
const ENGLISH_WRITE_TODO_MARKER = "Write or update a persistent TODO checklist";

// disable_tools (standard localizeSchema path)
const CAVEMAN_DISABLE_MARKER = "deactivate tool to free context";
const ENGLISH_DISABLE_MARKER = "Dynamically disable tools from this conversation";

// ── Tests ──────────────────────────────────────────────────

describe("InternalToolRegistry Locale Handling", () => {
  let InternalToolRegistry: typeof import("../InternalToolRegistry.ts").default;

  beforeEach(async () => {
    vi.clearAllMocks();
    const registryModule = await import("../InternalToolRegistry.ts");
    InternalToolRegistry = registryModule.default;
  });

  // ────────────────────────────────────────────────────────
  // 1. getSchemas() locale forwarding
  // ────────────────────────────────────────────────────────

  describe("getSchemas() locale forwarding", () => {
    it("should produce caveman descriptions for standard tools when locale is 'caveman'", () => {
      const schemas = InternalToolRegistry.getSchemas("caveman");
      const writeTodoSchema = schemas.find(
        (schema) => schema.name === "write_todo",
      );

      expect(writeTodoSchema).toBeDefined();
      expect(writeTodoSchema!.description!.toLowerCase()).toContain(
        CAVEMAN_WRITE_TODO_MARKER,
      );
      expect(writeTodoSchema!.description).not.toContain(
        ENGLISH_WRITE_TODO_MARKER,
      );
    });

    it("should produce english descriptions for standard tools when locale is 'en'", () => {
      const schemas = InternalToolRegistry.getSchemas("en");
      const writeTodoSchema = schemas.find(
        (schema) => schema.name === "write_todo",
      );

      expect(writeTodoSchema).toBeDefined();
      expect(writeTodoSchema!.description).toContain(
        ENGLISH_WRITE_TODO_MARKER,
      );
    });

    it("should produce caveman description for discover_and_enable_tools via buildSchema delegation", () => {
      const schemas = InternalToolRegistry.getSchemas("caveman");
      const discoverSchema = schemas.find(
        (schema) => schema.name === "discover_and_enable_tools",
      );

      expect(discoverSchema).toBeDefined();
      expect(discoverSchema!.description!.toLowerCase()).toContain(
        CAVEMAN_DISCOVER_MARKER,
      );
      expect(discoverSchema!.description).not.toContain(
        ENGLISH_DISCOVER_MARKER,
      );
    });

    it("should produce english description for discover_and_enable_tools when locale is 'en'", () => {
      const schemas = InternalToolRegistry.getSchemas("en");
      const discoverSchema = schemas.find(
        (schema) => schema.name === "discover_and_enable_tools",
      );

      expect(discoverSchema).toBeDefined();
      expect(discoverSchema!.description).toContain(
        ENGLISH_DISCOVER_MARKER,
      );
    });

    it("should produce distinct caveman vs english for discover_and_enable_tools", () => {
      const cavemanSchemas = InternalToolRegistry.getSchemas("caveman");
      const englishSchemas = InternalToolRegistry.getSchemas("en");

      const cavemanDiscover = cavemanSchemas.find(
        (schema) => schema.name === "discover_and_enable_tools",
      );
      const englishDiscover = englishSchemas.find(
        (schema) => schema.name === "discover_and_enable_tools",
      );

      expect(cavemanDiscover).toBeDefined();
      expect(englishDiscover).toBeDefined();
      expect(cavemanDiscover!.description).not.toEqual(
        englishDiscover!.description,
      );
    });

    it("should produce caveman description for disable_tools when locale is 'caveman'", () => {
      const schemas = InternalToolRegistry.getSchemas("caveman");
      const disableSchema = schemas.find(
        (schema) => schema.name === "disable_tools",
      );

      expect(disableSchema).toBeDefined();
      expect(disableSchema!.description!.toLowerCase()).toContain(
        CAVEMAN_DISABLE_MARKER,
      );
    });

    it("should produce english description for disable_tools when locale is 'en'", () => {
      const schemas = InternalToolRegistry.getSchemas("en");
      const disableSchema = schemas.find(
        (schema) => schema.name === "disable_tools",
      );

      expect(disableSchema).toBeDefined();
      expect(disableSchema!.description).toContain(ENGLISH_DISABLE_MARKER);
    });
  });

  // ────────────────────────────────────────────────────────
  // 2. getClientSchemas() locale forwarding
  //    Same as getSchemas but with domain/labels attached
  // ────────────────────────────────────────────────────────

  describe("getClientSchemas() locale forwarding", () => {
    it("should produce caveman descriptions in client schemas when locale is 'caveman'", () => {
      const schemas = InternalToolRegistry.getClientSchemas("caveman");
      const writeTodoSchema = schemas.find(
        (schema) => schema.name === "write_todo",
      );

      expect(writeTodoSchema).toBeDefined();
      expect(writeTodoSchema!.description!.toLowerCase()).toContain(
        CAVEMAN_WRITE_TODO_MARKER,
      );
      expect(writeTodoSchema!.description).not.toContain(
        ENGLISH_WRITE_TODO_MARKER,
      );
    });

    it("should produce caveman discover_and_enable_tools in client schemas via buildSchema", () => {
      const schemas = InternalToolRegistry.getClientSchemas("caveman");
      const discoverSchema = schemas.find(
        (schema) => schema.name === "discover_and_enable_tools",
      );

      expect(discoverSchema).toBeDefined();
      expect(discoverSchema!.description!.toLowerCase()).toContain(
        CAVEMAN_DISCOVER_MARKER,
      );
      expect(discoverSchema!.description).not.toContain(
        ENGLISH_DISCOVER_MARKER,
      );
    });
  });

  // ────────────────────────────────────────────────────────
  // 3. Adversarial: no locale mixing
  // ────────────────────────────────────────────────────────

  describe("adversarial locale isolation", () => {
    it("should never mix caveman and english descriptions in the same getSchemas call", () => {
      const schemas = InternalToolRegistry.getSchemas("caveman");

      for (const schema of schemas) {
        if (!schema.description) continue;

        // No schema should contain recognizable English markers
        // when the locale is caveman
        expect(
          schema.description,
          `Tool "${schema.name}" has English text leaking into caveman locale`,
        ).not.toContain(ENGLISH_WRITE_TODO_MARKER);
        expect(
          schema.description,
          `Tool "${schema.name}" has English text leaking into caveman locale`,
        ).not.toContain(ENGLISH_DISCOVER_MARKER);
        expect(
          schema.description,
          `Tool "${schema.name}" has English text leaking into caveman locale`,
        ).not.toContain(ENGLISH_DISABLE_MARKER);
      }
    });

    it("should default to english when locale is undefined", () => {
      const schemas = InternalToolRegistry.getSchemas(undefined);
      const writeTodoSchema = schemas.find(
        (schema) => schema.name === "write_todo",
      );

      expect(writeTodoSchema).toBeDefined();
      expect(writeTodoSchema!.description).toContain(
        ENGLISH_WRITE_TODO_MARKER,
      );
    });

    it("should localize discover_and_enable_tools parameter descriptions for caveman", () => {
      const schemas = InternalToolRegistry.getSchemas("caveman");
      const discoverSchema = schemas.find(
        (schema) => schema.name === "discover_and_enable_tools",
      );

      expect(discoverSchema).toBeDefined();
      expect(discoverSchema!.parameters).toBeDefined();

      const queryParameter = discoverSchema!.parameters!.properties?.query;
      expect(queryParameter).toBeDefined();
      // Caveman query param has "search term" vs English "Search keyword(s)"
      expect(queryParameter!.description!.toLowerCase()).toContain(
        "search term",
      );
    });

    it("should localize discover_and_enable_tools parameter descriptions for english", () => {
      const schemas = InternalToolRegistry.getSchemas("en");
      const discoverSchema = schemas.find(
        (schema) => schema.name === "discover_and_enable_tools",
      );

      expect(discoverSchema).toBeDefined();
      expect(discoverSchema!.parameters).toBeDefined();

      const queryParameter = discoverSchema!.parameters!.properties?.query;
      expect(queryParameter).toBeDefined();
      expect(queryParameter!.description).toContain("Search keyword(s)");
    });
  });

  // ────────────────────────────────────────────────────────
  // 4. buildSchema interface contract
  // ────────────────────────────────────────────────────────

  describe("buildSchema interface contract", () => {
    it("should use buildSchema when present instead of the getter schema", () => {
      const cavemanSchemas = InternalToolRegistry.getSchemas("caveman");
      const discoverSchema = cavemanSchemas.find(
        (schema) => schema.name === "discover_and_enable_tools",
      );

      // The getter reads from SettingsService which is mocked to "en",
      // but buildSchema should override with the per-request "caveman" locale
      expect(discoverSchema).toBeDefined();
      expect(discoverSchema!.description!.toLowerCase()).toContain(
        CAVEMAN_DISCOVER_MARKER,
      );
    });

    it("should return consistent results between getSchemas and getClientSchemas for same locale", () => {
      const agentSchemas = InternalToolRegistry.getSchemas("caveman");
      const clientSchemas = InternalToolRegistry.getClientSchemas("caveman");

      const agentDiscover = agentSchemas.find(
        (schema) => schema.name === "discover_and_enable_tools",
      );
      const clientDiscover = clientSchemas.find(
        (schema) => schema.name === "discover_and_enable_tools",
      );

      expect(agentDiscover).toBeDefined();
      expect(clientDiscover).toBeDefined();
      expect(agentDiscover!.description).toEqual(clientDiscover!.description);
    });
  });
});
