/**
 * Skill catalog — progressive disclosure (prompt 19, Landing 1).
 *
 * The system prompt carries one line per skill (name + description) in a
 * stable order; bodies reach the model only through `load_skill`. Relevance
 * scoring may highlight catalog entries for a turn but never injects bodies.
 *
 * Storage here is the real SkillService (and, before Landing 1, the real
 * SkillMemoryScorer query) over the in-memory Mongo mock, so the assertions
 * cover the schema adapter and the scope filter, not a stub of them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockCollection } from "../../../../tests/mongoMock.ts";
import type { AssemblerContext } from "#src/services/system-prompt/types";

vi.mock("#src/services/SettingsService", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({ topology: "hierarchical", locale: "en" }),
  },
}));

const MOCK_CLIENT_TOOL_SCHEMAS = [
  {
    name: "write_todo",
    description: "Write or update a persistent TODO checklist.",
    domain: "Core Harness Tools",
    parameters: { type: "object", properties: {}, required: [] },
  },
];

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getWorkspaceRoot: vi.fn().mockReturnValue("/home/test"),
    getClientToolSchemas: vi.fn().mockReturnValue(MOCK_CLIENT_TOOL_SCHEMAS),
    getToolSchemas: vi.fn().mockReturnValue(MOCK_CLIENT_TOOL_SCHEMAS),
    getAvailableTopologies: vi.fn().mockReturnValue([]),
    isWorkspaceAgentConnected: vi.fn().mockResolvedValue(true),
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("#src/services/system-prompt/DirectoryTreeFormatter", () => ({
  DirectoryTreeFormatter: class {
    fetchDirectoryTree() {
      return Promise.resolve("");
    }
  },
}));

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("#src/services/RequestLogger", () => ({
  default: { logRequest: vi.fn() },
}));

vi.mock("#src/services/MemoryService", () => ({
  default: { search: vi.fn().mockResolvedValue([]), formatForPrompt: vi.fn(() => "") },
}));

vi.mock("#src/services/WorkflowMemoryService", () => ({
  default: { retrieveRelevantWorkflows: vi.fn().mockResolvedValue(null) },
}));

const embed = vi.fn();
vi.mock("#src/services/EmbeddingService", () => ({
  default: { embed: (...args: unknown[]) => embed(...args) },
}));

let skillsCollection = createMockCollection([]);

vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getCollection: vi.fn((_database: string, name: string) =>
      name === "agent_skills" ? skillsCollection : null,
    ),
    getDb: vi.fn(() => ({
      collection: (name: string) =>
        name === "agent_skills" ? skillsCollection : null,
    })),
  },
}));

const PROJECT = "prism-chat";
const USERNAME = "test-user";

/** A skill as the Skills panel (SkillsRoutes) writes it. */
function panelSkill(overrides: Record<string, unknown> = {}) {
  return {
    _id: `panel-${String(overrides.name)}`,
    project: PROJECT,
    username: USERNAME,
    profileId: "default",
    name: "deploy-service",
    description: "Deploy a service to the NAS",
    content: "PANEL_BODY_MARKER: run deploy.sh then check the health route.",
    enabled: true,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  };
}

/** A skill as ClaudeConfigImportService (SkillService.upsertImported) writes it on master. */
function importedSkill(overrides: Record<string, unknown> = {}) {
  return {
    _id: "imported-1",
    skillId: "release_notes",
    name: "release-notes",
    description: "Write release notes from the git log",
    prompt: "IMPORTED_BODY_MARKER: read git log since the last tag, group by type.",
    steps: [],
    tools: null,
    maxIterations: 25,
    model: null,
    project: PROJECT,
    agent: null,
    usageCount: 0,
    source: "claude-config:/workspace/app",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function context(overrides: Partial<AssemblerContext> = {}): AssemblerContext {
  return {
    agent: "CODING",
    project: PROJECT,
    username: USERNAME,
    messages: [
      { role: "system", content: "" },
      { role: "user", content: "please deploy the service" },
    ],
    enabledTools: ["write_todo"],
    resolvedToolNames: ["write_todo", "load_skill", "list_skills"],
    workspaceEnabled: true,
    locale: "en",
    ...overrides,
  };
}

async function assemble(overrides: Partial<AssemblerContext> = {}) {
  const { default: SystemPromptAssembler } = await import(
    "#src/services/system-prompt/index"
  );
  return new SystemPromptAssembler().assemble(context(overrides));
}

describe("skill catalog in the system prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embed.mockReset();
    embed.mockRejectedValue(new Error("no embeddings in this test"));
    skillsCollection = createMockCollection([]);
  });

  it("carries one catalog line per skill and no skill body", async () => {
    skillsCollection = createMockCollection([
      panelSkill(),
      panelSkill({
        name: "api-conventions",
        description: "REST naming and error shapes",
        content: "SECOND_BODY_MARKER: plural nouns, RFC 9457 errors.",
      }),
    ]);

    const result = await assemble();
    const everything = `${result.prompt}\n${result.skillsText}`;

    expect(result.prompt).toContain("- deploy-service: Deploy a service to the NAS");
    expect(result.prompt).toContain("- api-conventions: REST naming and error shapes");
    expect(result.prompt).toContain("load_skill");
    expect(everything).not.toContain("PANEL_BODY_MARKER");
    expect(everything).not.toContain("SECOND_BODY_MARKER");
  });

  it("lists a skill imported through the legacy SkillService schema", async () => {
    skillsCollection = createMockCollection([importedSkill()]);

    const result = await assemble();

    expect(result.prompt).toContain(
      "- release-notes: Write release notes from the git log",
    );
    expect(`${result.prompt}\n${result.skillsText}`).not.toContain(
      "IMPORTED_BODY_MARKER",
    );
  });

  it("orders the catalog by name, whatever the relevance scores say", async () => {
    skillsCollection = createMockCollection([
      panelSkill({ name: "zeta-deploy", description: "Z", embedding: [1, 0] }),
      panelSkill({ name: "alpha-lint", description: "A", embedding: [0, 1] }),
      panelSkill({ name: "mid-review", description: "M", embedding: [0, 1] }),
    ]);
    embed.mockReset();
    embed.mockResolvedValue([1, 0]);

    const result = await assemble();
    const alpha = result.prompt.indexOf("- alpha-lint: A");
    const mid = result.prompt.indexOf("- mid-review: M");
    const zeta = result.prompt.indexOf("- zeta-deploy: Z");

    expect(alpha).toBeGreaterThan(-1);
    expect(alpha).toBeLessThan(mid);
    expect(mid).toBeLessThan(zeta);
  });

  it("uses relevance only to highlight a catalog entry for the turn", async () => {
    skillsCollection = createMockCollection([
      panelSkill({ name: "zeta-deploy", description: "Z", embedding: [1, 0] }),
      panelSkill({
        name: "alpha-lint",
        description: "A",
        content: "LINT_BODY_MARKER",
        embedding: [0, 1],
      }),
    ]);
    embed.mockReset();
    embed.mockResolvedValue([1, 0]);

    const result = await assemble();

    expect(result.skillsText).toContain("zeta-deploy");
    expect(result.skillsText).not.toContain("alpha-lint");
    expect(result.skillsText).not.toContain("PANEL_BODY_MARKER");
    expect(result.skillsText).not.toContain("LINT_BODY_MARKER");
  });

  it("keeps the catalog byte-identical when only the user's message changes", async () => {
    skillsCollection = createMockCollection([
      panelSkill({ name: "zeta-deploy", description: "Z", embedding: [1, 0] }),
      panelSkill({ name: "alpha-lint", description: "A", embedding: [0, 1] }),
    ]);
    embed.mockReset();
    embed.mockResolvedValueOnce([1, 0]).mockResolvedValueOnce([0, 1]);

    const first = await assemble();
    const second = await assemble({
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "lint the repo" },
      ],
    });

    expect(second.prompt).toBe(first.prompt);
  });

  it("leaves out disabled skills and skills bound to another persona", async () => {
    skillsCollection = createMockCollection([
      panelSkill({ name: "off-skill", description: "disabled", enabled: false }),
      importedSkill({ _id: "lupos-only", name: "howl", description: "Lupos only", agent: "LUPOS" }),
      importedSkill({ _id: "coding-only", name: "refactor", description: "Coding only", agent: "CODING" }),
    ]);

    const result = await assemble();

    expect(result.prompt).not.toContain("off-skill");
    expect(result.prompt).not.toContain("- howl:");
    expect(result.prompt).toContain("- refactor: Coding only");
  });

  it("leaves out another user's and another profile's skills", async () => {
    skillsCollection = createMockCollection([
      panelSkill({ _id: "mine", name: "mine", description: "mine" }),
      panelSkill({ _id: "theirs", name: "theirs", description: "theirs", username: "someone-else" }),
      panelSkill({ _id: "work", name: "work-profile", description: "work", profileId: "work" }),
      panelSkill({ _id: "other-project", name: "elsewhere", description: "elsewhere", project: "other" }),
    ]);

    const result = await assemble();

    expect(result.prompt).toContain("- mine: mine");
    expect(result.prompt).not.toContain("theirs");
    expect(result.prompt).not.toContain("work-profile");
    expect(result.prompt).not.toContain("elsewhere");
  });

  it("has no catalog when the workspace is disabled", async () => {
    skillsCollection = createMockCollection([panelSkill()]);

    const result = await assemble({ workspaceEnabled: false });

    expect(result.prompt).not.toContain("deploy-service");
    expect(result.skillsText).toBe("");
  });

  it("has no catalog when load_skill is not in the resolved tool set", async () => {
    skillsCollection = createMockCollection([panelSkill()]);

    const result = await assemble({ resolvedToolNames: ["write_todo"] });

    expect(result.prompt).not.toContain("deploy-service");
  });
});

// ── Token cost ────────────────────────────────────────────────────────
// Thirty skills of realistic SKILL.md size (2–4 KB bodies), no embeddings:
// the case where master injected every body into every turn. Prints the
// measurement (grep `[skill-token-report]`) so the numbers can be reported;
// the assertion is the property that matters — what the skills add to a
// turn is a small fraction of what their bodies weigh.
const TOPICS = [
  ["deploy-service", "Deploy a service to the NAS with deploy-kit"],
  ["release-notes", "Write release notes from the git log since the last tag"],
  ["api-conventions", "REST naming, pagination and RFC 9457 error shapes"],
  ["db-migration", "Write and dry-run an idempotent Mongo migration"],
  ["incident-review", "Draft a blameless incident review from logs and chat"],
  ["perf-profile", "Profile a slow endpoint and report the hot path"],
];

function skillFixture(index: number) {
  const [topic, description] = TOPICS[index % TOPICS.length];
  const paragraph =
    `When the task involves ${topic}, first read the relevant files, then ` +
    `state the plan in two sentences. Prefer the repo's existing helpers over ` +
    `new code, keep diffs minimal, and run the narrowest check that proves ` +
    `the change. Report what ran and what it printed. `;
  const steps = Array.from(
    { length: 6 + (index % 5) },
    (_, step) => `${step + 1}. ${paragraph}`,
  ).join("\n");
  return panelSkill({
    _id: `fixture-${index}`,
    name: `${topic}-${String(index).padStart(2, "0")}`,
    description,
    content: `# ${topic}\n\n## Steps\n\n${steps}\n\n## Done when\n\n${paragraph}`,
  });
}

describe("token cost of a 30-skill scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embed.mockReset();
    embed.mockRejectedValue(new Error("no embeddings in this test"));
  });

  it("adds a small fraction of the bodies' weight to the assembled prompt", async () => {
    const { estimateTokens } = await import("#src/utils/CostCalculator");
    const fixture = Array.from({ length: 30 }, (_, index) => skillFixture(index));
    const bodyTokens = fixture.reduce(
      (sum, skill) => sum + estimateTokens(String(skill.content)),
      0,
    );
    const measure = (result: { prompt: string; skillsText: string }) => ({
      systemPrompt: estimateTokens(result.prompt),
      perTurnContext: estimateTokens(result.skillsText || ""),
      total: estimateTokens(result.prompt) + estimateTokens(result.skillsText || ""),
    });

    skillsCollection = createMockCollection([]);
    const withoutSkills = measure(await assemble());
    skillsCollection = createMockCollection(fixture);
    const withSkills = measure(await assemble());

    const report = {
      skills: fixture.length,
      bodyTokens,
      withoutSkills,
      withSkills,
      addedBySkills: withSkills.total - withoutSkills.total,
    };
    console.log(`[skill-token-report] ${JSON.stringify(report)}`);

    expect(report.addedBySkills).toBeGreaterThan(0);
    expect(report.addedBySkills).toBeLessThan(bodyTokens * 0.15);
  });
});
