import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ────────────────────────────────────────────────────────────
// PromptLocaleService Integration Tests
// ────────────────────────────────────────────────────────────
// Verifies that:
//   1. All locale JSON files are valid JSON and load without errors
//   2. Nested directory namespacing works (personas/omni.json → personas.omni.*)
//   3. Every key referenced in system prompt assembly actually exists
//   4. The dist/ output contains locale files after build (production readiness)

const LOCALES_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "locales",
);

const DIST_LOCALES_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "src",
  "locales",
);

function deepFlattenObject(
  source: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    const flatKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(
        result,
        deepFlattenObject(value as Record<string, unknown>, flatKey),
      );
    } else {
      result[flatKey] = value;
    }
  }
  return result;
}

function loadAllLocaleKeys(localeDirectory: string): Map<string, string> {
  const allKeys = new Map<string, string>();

  function processDirectory(directory: string, namespacePrefix: string) {
    if (!fs.existsSync(directory)) return;
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        processDirectory(fullPath, `${namespacePrefix}${entry.name}.`);
      } else if (entry.name.endsWith(".json")) {
        const fileNameWithoutExtension = entry.name.replace(/\.json$/, "");
        const filePrefix = `${namespacePrefix}${fileNameWithoutExtension}`;
        const rawContent = fs.readFileSync(fullPath, "utf-8");
        const parsedContent = JSON.parse(rawContent) as Record<string, unknown>;
        const flattened = deepFlattenObject(parsedContent, filePrefix);
        for (const [flatKey, flatValue] of Object.entries(flattened)) {
          allKeys.set(flatKey, String(flatValue));
        }
      }
    }
  }

  processDirectory(localeDirectory, "");
  return allKeys;
}

describe("PromptLocaleService — Locale Loading", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  it("should find the source locales directory", () => {
    expect(fs.existsSync(LOCALES_DIRECTORY)).toBe(true);
  });

  it("should find the 'en' locale subdirectory", () => {
    expect(fs.existsSync(path.join(LOCALES_DIRECTORY, "en"))).toBe(true);
  });

  it("should load a non-zero number of locale keys", () => {
    expect(englishLocaleKeys.size).toBeGreaterThan(0);
  });

  it("should parse all locale JSON files without errors", () => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    const allJsonFiles: string[] = [];

    function collectJsonFiles(directory: string) {
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          collectJsonFiles(fullPath);
        } else if (entry.name.endsWith(".json")) {
          allJsonFiles.push(fullPath);
        }
      }
    }

    collectJsonFiles(englishLocaleDirectory);

    for (const jsonFile of allJsonFiles) {
      const rawContent = fs.readFileSync(jsonFile, "utf-8");
      expect(() => JSON.parse(rawContent)).not.toThrow();
    }
  });
});

describe("PromptLocaleService — Subdirectory Namespacing", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  it("should namespace persona files under 'personas.' prefix", () => {
    const personaKeys = [...englishLocaleKeys.keys()].filter((key) =>
      key.startsWith("personas."),
    );
    expect(personaKeys.length).toBeGreaterThan(0);
  });

  it("should resolve personas.omni.coreIdentity from personas/omni.json", () => {
    expect(englishLocaleKeys.has("personas.omni.coreIdentity")).toBe(true);
    const coreIdentity = englishLocaleKeys.get("personas.omni.coreIdentity");
    expect(coreIdentity).toBeDefined();
    expect(coreIdentity).not.toContain("[MISSING:");
    expect(coreIdentity!.length).toBeGreaterThan(10);
  });

  it("should resolve personas.omni.responseGuidelines from personas/omni.json", () => {
    expect(englishLocaleKeys.has("personas.omni.responseGuidelines")).toBe(true);
  });

  it("should resolve personas.omni.guidelines from personas/omni.json", () => {
    expect(englishLocaleKeys.has("personas.omni.guidelines")).toBe(true);
  });

  it("should resolve personas.omni.description from personas/omni.json", () => {
    expect(englishLocaleKeys.has("personas.omni.description")).toBe(true);
  });
});

describe("PromptLocaleService — System Prompt Critical Keys", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  const SYSTEM_PROMPT_CRITICAL_KEYS = [
    "system-prompt.directModeIdentity",
    "system-prompt.codingFallbackIdentity",
    "system-prompt.codingGuidelines",
    "system-prompt.commandExecutionGuidelines",
    "system-prompt.environmentHeader",
    "system-prompt.environmentOsLine",
    "system-prompt.environmentWorkspaceLine",
  ];

  for (const key of SYSTEM_PROMPT_CRITICAL_KEYS) {
    it(`should resolve system prompt key: "${key}"`, () => {
      expect(englishLocaleKeys.has(key)).toBe(true);
      const value = englishLocaleKeys.get(key)!;
      expect(value.length).toBeGreaterThan(0);
    });
  }
});

describe("PromptLocaleService — Tool Policy Critical Keys", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  const TOOL_POLICY_CRITICAL_KEYS = [
    "tool-policy.generalPrinciples",
    "tool-policy.toolDiscovery.header",
    "tool-policy.toolDiscovery.intro",
    "tool-policy.toolDiscovery.domainsHeader",
    "tool-policy.toolDiscovery.searchRule",
    "tool-policy.toolDiscovery.searchSteps",
    "tool-policy.toolDiscovery.noFallback",
    "tool-policy.toolDiscovery.intentMatchingHeader",
    "tool-policy.toolDiscovery.intentMatchingRules",
    "tool-policy.toolDiscovery.triggerHeader",
  ];

  for (const key of TOOL_POLICY_CRITICAL_KEYS) {
    it(`should resolve tool policy key: "${key}"`, () => {
      expect(englishLocaleKeys.has(key)).toBe(true);
      const value = englishLocaleKeys.get(key)!;
      expect(value.length).toBeGreaterThan(0);
    });
  }
});

describe("PromptLocaleService — Orchestrator Critical Keys", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  const ORCHESTRATOR_CRITICAL_KEYS = [
    "orchestrator.header",
    "orchestrator.yourRole",
    "orchestrator.yourTools",
    "orchestrator.createTeamGuidance",
    "orchestrator.subAgentResults",
    "orchestrator.subAgentCapabilities",
    "orchestrator.taskWorkflow",
    "orchestrator.concurrency",
    "orchestrator.verification",
    "orchestrator.handlingFailures",
    "orchestrator.stoppingAgents",
    "orchestrator.synthesize",
    "orchestrator.purposeStatement",
    "orchestrator.goodExamples",
    "orchestrator.badExamples",
    "orchestrator.continueVsSpawn",
    "orchestrator.promptTips",
    "orchestrator.tools.create_team.description",
    "orchestrator.tools.send_message.description",
    "orchestrator.tools.stop_agent.description",
    "orchestrator.tools.get_task_output.description",
    "orchestrator.tools.delete_team.description",
    "orchestrator.tools.create_team.parameters.name",
    "orchestrator.tools.send_message.parameters.to",
    "orchestrator.tools.send_message.parameters.message",
    "orchestrator.tools.stop_agent.parameters.agent_id",
    "orchestrator.tools.get_task_output.parameters.agent_id",
    "orchestrator.tools.delete_team.parameters.teamName",
  ];

  for (const key of ORCHESTRATOR_CRITICAL_KEYS) {
    it(`should resolve orchestrator key: "${key}"`, () => {
      expect(englishLocaleKeys.has(key)).toBe(true);
      const value = englishLocaleKeys.get(key)!;
      expect(value.length).toBeGreaterThan(0);
    });
  }
});

describe("PromptLocaleService — All Persona Locale Files", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  const PERSONA_FILES = [
    "coding",
    "digest",
    "image",
    "lights",
    "lupos",
    "meepo",
    "meta",
    "omni",
    "oog",
    "stickers",
  ];

  for (const personaName of PERSONA_FILES) {
    it(`should load at least one key from personas/${personaName}.json`, () => {
      const matchingKeys = [...englishLocaleKeys.keys()].filter((key) =>
        key.startsWith(`personas.${personaName}.`),
      );
      expect(matchingKeys.length).toBeGreaterThan(0);
    });
  }
});

describe("PromptLocaleService — No Value Contains [MISSING:]", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  it("should not have any values containing [MISSING:] placeholder text", () => {
    const missingValueKeys: string[] = [];
    for (const [key, value] of englishLocaleKeys) {
      if (value.includes("[MISSING:")) {
        missingValueKeys.push(key);
      }
    }
    expect(missingValueKeys).toEqual([]);
  });
});

describe("PromptLocaleService — dist/ Production Build", () => {
  it("should have locale files copied to dist/src/locales/en/ after build", () => {
    if (!fs.existsSync(DIST_LOCALES_DIRECTORY)) {
      // Build hasn't been run — skip (non-critical in dev mode)
      return;
    }
    const distEnglishLocaleDirectory = path.join(DIST_LOCALES_DIRECTORY, "en");
    expect(fs.existsSync(distEnglishLocaleDirectory)).toBe(true);

    const distLocaleKeys = loadAllLocaleKeys(distEnglishLocaleDirectory);
    expect(distLocaleKeys.size).toBeGreaterThan(0);

    // Verify critical keys exist in the dist build
    expect(distLocaleKeys.has("system-prompt.directModeIdentity")).toBe(true);
    expect(distLocaleKeys.has("personas.omni.coreIdentity")).toBe(true);
    expect(distLocaleKeys.has("orchestrator.header")).toBe(true);
    expect(distLocaleKeys.has("tool-policy.generalPrinciples")).toBe(true);
  });

  it("should have the personas/ subdirectory in dist locales", () => {
    if (!fs.existsSync(DIST_LOCALES_DIRECTORY)) return;
    const distPersonasDirectory = path.join(DIST_LOCALES_DIRECTORY, "en", "personas");
    expect(fs.existsSync(distPersonasDirectory)).toBe(true);
  });
});
