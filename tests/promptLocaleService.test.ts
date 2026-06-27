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

  it("should NOT have personas.omni.guidelines (deduplicated into system-prompt.codingGuidelines)", () => {
    expect(englishLocaleKeys.has("personas.omni.guidelines")).toBe(false);
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

describe("PromptLocaleService — Planning Mode Merge (planning.json → harness.json)", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  it("should NOT have a planning.json file (merged into harness.json)", () => {
    const planningFile = path.join(LOCALES_DIRECTORY, "en", "planning.json");
    expect(fs.existsSync(planningFile)).toBe(false);
  });

  it("should NOT resolve the old planning.planningInstruction key", () => {
    expect(englishLocaleKeys.has("planning.planningInstruction")).toBe(false);
  });

  it("should resolve planningInstruction under harness.planningMode namespace", () => {
    expect(englishLocaleKeys.has("harness.planningMode.planningInstruction")).toBe(true);
    const value = englishLocaleKeys.get("harness.planningMode.planningInstruction")!;
    expect(value).toContain("PLANNING MODE ACTIVE");
    expect(value).toContain("exit_plan_mode");
  });

  it("should have all original harness.planningMode keys intact after merge", () => {
    const expectedKeys = [
      "harness.planningMode.blocked",
      "harness.planningMode.approvalResult",
      "harness.planningMode.rejectionStatus",
      "harness.planningMode.planningInstruction",
    ];
    for (const key of expectedKeys) {
      expect(englishLocaleKeys.has(key)).toBe(true);
      expect(englishLocaleKeys.get(key)!.length).toBeGreaterThan(0);
    }
  });
});

describe("PromptLocaleService — Somatic Mood Nesting (moods.*)", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  const MOOD_KEYS = [
    "joy", "trust", "fear", "surprise", "sadness", "disgust",
    "anger", "anticipation", "neutral", "love", "submission",
    "awe", "disapproval", "remorse", "contempt", "aggressiveness",
    "optimism", "hope", "anxiety", "envy", "pride", "despair",
    "shame", "guilt", "cynicism", "delight", "outrage",
    "pessimism", "morbidness", "sentimentality", "curiosity",
    "unbelief", "dominance",
  ];

  it("should NOT have mood keys at somatic root level (e.g. somatic.joy)", () => {
    for (const mood of MOOD_KEYS) {
      expect(englishLocaleKeys.has(`somatic.${mood}`)).toBe(false);
    }
  });

  for (const mood of MOOD_KEYS) {
    it(`should resolve nested mood key: somatic.moods.${mood}`, () => {
      expect(englishLocaleKeys.has(`somatic.moods.${mood}`)).toBe(true);
      const value = englishLocaleKeys.get(`somatic.moods.${mood}`)!;
      expect(value.length).toBeGreaterThan(20);
      expect(value).toContain("MOOD OVERRIDE");
    });
  }

  it("should still have infrastructure keys at somatic root level", () => {
    expect(englishLocaleKeys.has("somatic.classificationPrompt")).toBe(true);
    expect(englishLocaleKeys.has("somatic.moodTemplate.header")).toBe(true);
    expect(englishLocaleKeys.has("somatic.alcohol.suffix")).toBe(true);
  });

  it("should have all 33 mood keys under somatic.moods.*", () => {
    const moodKeys = [...englishLocaleKeys.keys()].filter((key) =>
      key.startsWith("somatic.moods."),
    );
    expect(moodKeys.length).toBe(33);
  });
});

describe("PromptLocaleService — Voice Catalog Cleanup", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  it("should NOT have dead voiceDescriptions keys", () => {
    const deadKeys = [...englishLocaleKeys.keys()].filter((key) =>
      key.startsWith("voice-catalog.voiceDescriptions."),
    );
    expect(deadKeys).toEqual([]);
  });

  it("should still have catalog format keys", () => {
    const formatKeys = [
      "voice-catalog.catalogFormat.inworld",
      "voice-catalog.catalogFormat.openai",
      "voice-catalog.catalogFormat.google",
      "voice-catalog.catalogFormat.elevenlabs",
    ];
    for (const key of formatKeys) {
      expect(englishLocaleKeys.has(key)).toBe(true);
    }
  });

  it("should still have inworldTts2Steering key", () => {
    expect(englishLocaleKeys.has("voice-catalog.inworldTts2Steering")).toBe(true);
    const value = englishLocaleKeys.get("voice-catalog.inworldTts2Steering")!;
    expect(value).toContain("inworld-tts-2");
  });
});

describe("PromptLocaleService — Persona Deduplication", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  it("should NOT have personas.coding.identity (deduplicated to system-prompt.codingFallbackIdentity)", () => {
    expect(englishLocaleKeys.has("personas.coding.identity")).toBe(false);
  });

  it("should NOT have personas.coding.guidelines (deduplicated to system-prompt.codingGuidelines)", () => {
    expect(englishLocaleKeys.has("personas.coding.guidelines")).toBe(false);
  });

  it("should still have personas.coding.description", () => {
    expect(englishLocaleKeys.has("personas.coding.description")).toBe(true);
  });

  it("should have enriched system-prompt.codingGuidelines with tool-specific bullets", () => {
    const guidelines = englishLocaleKeys.get("system-prompt.codingGuidelines")!;
    expect(guidelines).toContain("replace_in_file");
    expect(guidelines).toContain("patch_file");
    expect(guidelines).toContain("write_file");
  });

  it("should have system-prompt.codingFallbackIdentity as the canonical identity", () => {
    const identity = englishLocaleKeys.get("system-prompt.codingFallbackIdentity")!;
    expect(identity).toContain("You are a coding agent with access to");
  });
});

describe("PromptLocaleService — No Duplicate Values Across Personas", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  it("should not have any persona key whose value exactly matches system-prompt.codingFallbackIdentity", () => {
    const canonicalIdentity = englishLocaleKeys.get("system-prompt.codingFallbackIdentity")!;
    const duplicateKeys: string[] = [];
    for (const [key, value] of englishLocaleKeys) {
      if (key.startsWith("personas.") && key.endsWith(".identity") && value === canonicalIdentity) {
        duplicateKeys.push(key);
      }
    }
    expect(duplicateKeys).toEqual([]);
  });

  it("should not have any persona key whose value exactly matches system-prompt.codingGuidelines", () => {
    const canonicalGuidelines = englishLocaleKeys.get("system-prompt.codingGuidelines")!;
    const duplicateKeys: string[] = [];
    for (const [key, value] of englishLocaleKeys) {
      if (key.startsWith("personas.") && key.endsWith(".guidelines") && value === canonicalGuidelines) {
        duplicateKeys.push(key);
      }
    }
    expect(duplicateKeys).toEqual([]);
  });
});

describe("PromptLocaleService — Harness Lifecycle Key Integrity", () => {
  let englishLocaleKeys: Map<string, string>;

  beforeAll(() => {
    const englishLocaleDirectory = path.join(LOCALES_DIRECTORY, "en");
    englishLocaleKeys = loadAllLocaleKeys(englishLocaleDirectory);
  });

  it("should NOT have any routers.planning.* keys (dead code removed)", () => {
    const deadKeys = [...englishLocaleKeys.keys()].filter((key) =>
      key.startsWith("routers.planning."),
    );
    expect(deadKeys).toEqual([]);
  });

  it("should have harness.planningMode.blocked with {{blockedNames}} interpolation", () => {
    const value = englishLocaleKeys.get("harness.planningMode.blocked")!;
    expect(value).toContain("{{blockedNames}}");
    expect(value).toContain("PLANNING MODE");
  });
});
