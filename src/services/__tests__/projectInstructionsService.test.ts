import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "mongodb";
import type { ProjectInstructionsDocument } from "#src/services/ProjectInstructionsService";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const {
  default: ProjectInstructionsService,
  upsertMarkdownSection,
  parseHeadingSpec,
  hasMarkdownSection,
  PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS,
} = await import("#src/services/ProjectInstructionsService");

// ────────────────────────────────────────────────────────────
// In-memory Mongo double
// ────────────────────────────────────────────────────────────
// Supports exactly the surface the service uses: find().sort().limit()
// .toArray(), insertOne, updateMany, createIndex. `simulateVersionRace`
// reproduces the unique {scope, version} index rejecting a concurrent
// writer's claim, which is the only reason setContent retries.
// ────────────────────────────────────────────────────────────

type Row = ProjectInstructionsDocument;

function matchesFilter(row: Row, filter: Record<string, unknown>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    const actual = (row as unknown as Record<string, unknown>)[key] ?? null;

    if (expected !== null && typeof expected === "object") {
      const operators = expected as Record<string, unknown>;
      if (Array.isArray(operators.$in)) {
        if (
          !operators.$in.some((candidate) => (candidate ?? null) === actual)
        ) {
          return false;
        }
        continue;
      }
      if (typeof operators.$lt === "number") {
        if (!(typeof actual === "number" && actual < operators.$lt)) {
          return false;
        }
        continue;
      }
      return false;
    }

    if ((expected ?? null) !== actual) return false;
  }
  return true;
}

function createFakeDatabase(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const state = { duplicateKeyOnNextInsert: false };

  const collection = {
    createIndex: vi.fn(async () => "index"),
    insertOne: vi.fn(async (document: Row) => {
      if (state.duplicateKeyOnNextInsert) {
        state.duplicateKeyOnNextInsert = false;
        // A concurrent writer claimed this version first — mimic it.
        rows.push({ ...document, id: `${document.id}-rival` });
        const error = new Error("E11000 duplicate key error") as Error & {
          code: number;
        };
        error.code = 11000;
        throw error;
      }
      rows.push(document);
      return { insertedId: document.id };
    }),
    updateMany: vi.fn(
      async (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => {
        let modified = 0;
        for (const row of rows) {
          if (!matchesFilter(row, filter)) continue;
          Object.assign(row, update.$set);
          modified += 1;
        }
        return { modifiedCount: modified };
      },
    ),
    find: vi.fn((filter: Record<string, unknown> = {}) => {
      let selected = rows.filter((row) => matchesFilter(row, filter));
      const cursor = {
        sort(specification: Record<string, number>) {
          const [key, direction] = Object.entries(specification)[0] ?? [
            "version",
            -1,
          ];
          selected = [...selected].sort(
            (left, right) =>
              (Number((left as unknown as Record<string, unknown>)[key!]) -
                Number((right as unknown as Record<string, unknown>)[key!])) *
              Number(direction),
          );
          return cursor;
        },
        limit(count: number) {
          selected = selected.slice(0, count);
          return cursor;
        },
        async toArray() {
          return selected.map((row) => ({ ...row }));
        },
      };
      return cursor;
    }),
  };

  const database = { collection: vi.fn(() => collection) };

  return {
    db: database as unknown as Db,
    rows,
    collection,
    triggerVersionRace() {
      state.duplicateKeyOnNextInsert = true;
    },
  };
}

const SCOPE = { project: "prism", username: "rodrigo", agent: null };

// ────────────────────────────────────────────────────────────
// upsertMarkdownSection — the heart of the feature
// ────────────────────────────────────────────────────────────

describe("upsertMarkdownSection", () => {
  it("turns an empty document into the section", () => {
    expect(upsertMarkdownSection("", "Build", "Run `pnpm build`.")).toBe(
      "## Build\n\nRun `pnpm build`.",
    );
  });

  it("treats a whitespace-only document as empty", () => {
    expect(upsertMarkdownSection("\n\n   \n", "Build", "x")).toBe(
      "## Build\n\nx",
    );
  });

  it("appends at the end when the heading is absent", () => {
    const document = "# PRISM\n\nIntro text.\n\n## Build\n\nRun build.";
    expect(upsertMarkdownSection(document, "Testing", "Run vitest.")).toBe(
      "# PRISM\n\nIntro text.\n\n## Build\n\nRun build.\n\n## Testing\n\nRun vitest.",
    );
  });

  it("normalizes trailing whitespace before appending", () => {
    expect(upsertMarkdownSection("Intro.\n\n\n", "Build", "x")).toBe(
      "Intro.\n\n## Build\n\nx",
    );
  });

  it("replaces a section in the middle without touching its neighbours", () => {
    const document = [
      "# PRISM",
      "",
      "Intro.",
      "",
      "## Build",
      "",
      "Old build text.",
      "",
      "## Testing",
      "",
      "Run vitest.",
    ].join("\n");

    expect(upsertMarkdownSection(document, "Build", "New build text.")).toBe(
      [
        "# PRISM",
        "",
        "Intro.",
        "",
        "## Build",
        "",
        "New build text.",
        "",
        "## Testing",
        "",
        "Run vitest.",
      ].join("\n"),
    );
  });

  it("replaces a section that runs to the end of the document", () => {
    const document = "## Build\n\nOld.\n\n## Testing\n\nOld tests.";
    expect(upsertMarkdownSection(document, "Testing", "New tests.")).toBe(
      "## Build\n\nOld.\n\n## Testing\n\nNew tests.",
    );
  });

  it("carries nested ### subsections with their ## parent but never swallows the next ##", () => {
    const document = [
      "## Build",
      "",
      "Parent body.",
      "",
      "### Windows",
      "",
      "Windows notes.",
      "",
      "### Linux",
      "",
      "Linux notes.",
      "",
      "## Testing",
      "",
      "Run vitest.",
    ].join("\n");

    const result = upsertMarkdownSection(document, "Build", "Just build.");

    expect(result).toBe("## Build\n\nJust build.\n\n## Testing\n\nRun vitest.");
    expect(result).not.toContain("Windows notes.");
    expect(result).toContain("Run vitest.");
  });

  it("stops a ### replacement at the next ### sibling", () => {
    const document = [
      "## Build",
      "",
      "Parent body.",
      "",
      "### Windows",
      "",
      "Old windows notes.",
      "",
      "### Linux",
      "",
      "Linux notes.",
    ].join("\n");

    expect(upsertMarkdownSection(document, "### Windows", "New notes.")).toBe(
      [
        "## Build",
        "",
        "Parent body.",
        "",
        "### Windows",
        "",
        "New notes.",
        "",
        "### Linux",
        "",
        "Linux notes.",
      ].join("\n"),
    );
  });

  it("stops a ### replacement at a higher-level ## boundary", () => {
    const document = [
      "## Build",
      "",
      "### Windows",
      "",
      "Old.",
      "",
      "## Testing",
      "",
      "Run vitest.",
    ].join("\n");

    expect(upsertMarkdownSection(document, "### Windows", "New.")).toBe(
      [
        "## Build",
        "",
        "### Windows",
        "",
        "New.",
        "",
        "## Testing",
        "",
        "Run vitest.",
      ].join("\n"),
    );
  });

  it("matches on heading level — '## Notes' does not hit '### Notes'", () => {
    const document = "## Build\n\n### Notes\n\nSub notes.";
    const result = upsertMarkdownSection(document, "Notes", "Top-level notes.");

    expect(result).toBe(
      "## Build\n\n### Notes\n\nSub notes.\n\n## Notes\n\nTop-level notes.",
    );
    expect(result).toContain("Sub notes.");
  });

  it("ignores '##' inside a fenced code block when matching", () => {
    const document = [
      "## Build",
      "",
      "```sh",
      "## Deploy",
      "echo not-a-heading",
      "```",
      "",
      "Tail of build.",
    ].join("\n");

    const result = upsertMarkdownSection(document, "Deploy", "Run deploy.sh.");

    // The fenced "## Deploy" is code — the real section is appended instead.
    expect(result).toBe(
      [
        "## Build",
        "",
        "```sh",
        "## Deploy",
        "echo not-a-heading",
        "```",
        "",
        "Tail of build.",
        "",
        "## Deploy",
        "",
        "Run deploy.sh.",
      ].join("\n"),
    );
  });

  it("does not end a section at a '##' inside a fenced code block", () => {
    const document = [
      "## Build",
      "",
      "```",
      "## Testing",
      "```",
      "",
      "Still build.",
      "",
      "## Testing",
      "",
      "Real tests.",
    ].join("\n");

    const result = upsertMarkdownSection(document, "Build", "New build.");

    expect(result).toBe("## Build\n\nNew build.\n\n## Testing\n\nReal tests.");
    expect(result).not.toContain("Still build.");
    expect(result).toContain("Real tests.");
  });

  it("handles tilde fences", () => {
    const document = [
      "## Build",
      "",
      "~~~",
      "## Fake",
      "~~~",
      "",
      "Body.",
    ].join("\n");

    expect(upsertMarkdownSection(document, "Fake", "Real.")).toBe(
      [
        "## Build",
        "",
        "~~~",
        "## Fake",
        "~~~",
        "",
        "Body.",
        "",
        "## Fake",
        "",
        "Real.",
      ].join("\n"),
    );
  });

  it("preserves a fenced code block written into the body", () => {
    const body = "```sh\n## not a heading\npnpm test\n```";
    const result = upsertMarkdownSection("## Build\n\nOld.", "Build", body);
    expect(result).toBe(`## Build\n\n${body}`);
    // Idempotent even though the body contains a heading-shaped line.
    expect(upsertMarkdownSection(result, "Build", body)).toBe(result);
  });

  it("does not treat '#Heading' (no space) as a heading", () => {
    const document = "## Build\n\n#NotAHeading\n\nStill build.";
    const result = upsertMarkdownSection(document, "NotAHeading", "x");
    expect(result).toBe(
      "## Build\n\n#NotAHeading\n\nStill build.\n\n## NotAHeading\n\nx",
    );
  });

  it("does not treat a 4-space indented hash as a heading", () => {
    const document = "## Build\n\n    ## Indented\n\nStill build.";
    expect(upsertMarkdownSection(document, "Indented", "x")).toBe(
      "## Build\n\n    ## Indented\n\nStill build.\n\n## Indented\n\nx",
    );
  });

  it("writes the heading alone when the body is empty", () => {
    expect(upsertMarkdownSection("", "Build", "")).toBe("## Build");
    expect(upsertMarkdownSection("## Build\n\nOld.", "Build", "   ")).toBe(
      "## Build",
    );
  });

  it("is idempotent", () => {
    const once = upsertMarkdownSection("# PRISM\n\nIntro.", "Build", "Body.");
    expect(upsertMarkdownSection(once, "Build", "Body.")).toBe(once);
  });

  it("matches an existing heading case-insensitively and rewrites it canonically", () => {
    const result = upsertMarkdownSection("## build\n\nOld.", "Build", "New.");
    expect(result).toBe("## Build\n\nNew.");
  });

  it("strips a closing hash sequence when matching", () => {
    expect(upsertMarkdownSection("## Build ##\n\nOld.", "Build", "New.")).toBe(
      "## Build\n\nNew.",
    );
  });

  it("normalizes CRLF input", () => {
    expect(upsertMarkdownSection("## Build\r\n\r\nOld.", "Build", "New.")).toBe(
      "## Build\n\nNew.",
    );
  });

  it("throws when the heading is empty", () => {
    expect(() => upsertMarkdownSection("x", "   ", "body")).toThrow(
      /non-empty heading/,
    );
    expect(() => upsertMarkdownSection("x", "###", "body")).toThrow(
      /non-empty heading/,
    );
  });
});

describe("parseHeadingSpec", () => {
  it("defaults to level 2", () => {
    expect(parseHeadingSpec("Build")).toEqual({ level: 2, text: "Build" });
  });

  it("reads an explicit level and strips closing hashes", () => {
    expect(parseHeadingSpec("### Gotchas ###")).toEqual({
      level: 3,
      text: "Gotchas",
    });
  });

  it("clamps to six levels", () => {
    expect(parseHeadingSpec("###### Deep").level).toBe(6);
  });
});

describe("hasMarkdownSection", () => {
  it("finds a heading at the matching level only", () => {
    const document = "## Build\n\n### Notes\n\nx";
    expect(hasMarkdownSection(document, "Build")).toBe(true);
    expect(hasMarkdownSection(document, "### Notes")).toBe(true);
    expect(hasMarkdownSection(document, "Notes")).toBe(false);
    expect(hasMarkdownSection(document, "Missing")).toBe(false);
    expect(hasMarkdownSection("", "Build")).toBe(false);
  });

  it("ignores headings inside code fences", () => {
    expect(hasMarkdownSection("```\n## Build\n```", "Build")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// Storage — versioning, scope resolution, history
// ────────────────────────────────────────────────────────────

describe("ProjectInstructionsService.setContent", () => {
  let fake: ReturnType<typeof createFakeDatabase>;

  beforeEach(() => {
    fake = createFakeDatabase();
  });

  it("creates version 1 as the current document", async () => {
    const document = await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "## Build\n\nRun build.",
      "user",
    );

    expect(document.version).toBe(1);
    expect(document.validTo).toBeNull();
    expect(document.supersededBy).toBeNull();
    expect(document.updatedBy).toBe("user");
    expect(document.project).toBe("prism");
    expect(document.agent).toBeNull();
    expect(fake.rows).toHaveLength(1);
  });

  it("supersedes rather than overwrites the previous version", async () => {
    const first = await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "v1 text",
      "user",
    );
    const second = await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "v2 text",
      "agent",
    );

    expect(second.version).toBe(2);
    expect(fake.rows).toHaveLength(2);

    const closed = fake.rows.find((row) => row.id === first.id);
    expect(closed?.content).toBe("v1 text");
    expect(closed?.validTo).toEqual(expect.any(String));
    expect(closed?.supersededBy).toBe(second.id);
    expect(closed?.closedReason).toBe("superseded");

    const current = await ProjectInstructionsService.getCurrent(fake.db, SCOPE);
    expect(current?.content).toBe("v2 text");
    expect(current?.version).toBe(2);
  });

  it("stamps a custom closedReason on the superseded row", async () => {
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v1", "user");
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v2", "agent", {
      reason: "edited",
    });
    expect(fake.rows[0]?.closedReason).toBe("edited");
  });

  it("retries when a concurrent writer claims the same version number", async () => {
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v1", "user");
    fake.triggerVersionRace();

    const document = await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "mine",
      "user",
    );

    // The rival won v2; this write lands on v3 instead of being lost.
    expect(document.version).toBe(3);
    expect(document.content).toBe("mine");
    const current = await ProjectInstructionsService.getCurrent(fake.db, SCOPE);
    expect(current?.content).toBe("mine");
  });

  it("rejects content over the cap", async () => {
    const oversized = "x".repeat(PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS + 1);
    await expect(
      ProjectInstructionsService.setContent(fake.db, SCOPE, oversized, "user"),
    ).rejects.toThrow(/character limit/);
    expect(fake.rows).toHaveLength(0);
  });

  it("accepts content exactly at the cap", async () => {
    const atCap = "x".repeat(PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS);
    const document = await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      atCap,
      "user",
    );
    expect(document.content).toHaveLength(
      PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS,
    );
  });

  it("defaults an unscoped write to the 'any' placeholders", async () => {
    const document = await ProjectInstructionsService.setContent(
      fake.db,
      {},
      "text",
      "user",
    );
    expect(document.project).toBe("any");
    expect(document.username).toBe("any");
    expect(document.agent).toBeNull();
  });
});

describe("ProjectInstructionsService.getCurrent — scope resolution", () => {
  it("prefers the agent-scoped document over the project-wide one", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(
      fake.db,
      { ...SCOPE, agent: null },
      "project-wide",
      "user",
    );
    await ProjectInstructionsService.setContent(
      fake.db,
      { ...SCOPE, agent: "CODING" },
      "coding-only",
      "user",
    );

    const forCoding = await ProjectInstructionsService.getCurrent(fake.db, {
      ...SCOPE,
      agent: "CODING",
    });
    expect(forCoding?.content).toBe("coding-only");

    const forOther = await ProjectInstructionsService.getCurrent(fake.db, {
      ...SCOPE,
      agent: "LUPOS",
    });
    expect(forOther?.content).toBe("project-wide");

    const projectWide = await ProjectInstructionsService.getCurrent(
      fake.db,
      SCOPE,
    );
    expect(projectWide?.content).toBe("project-wide");
  });

  it("falls back to the project-wide document when no agent doc exists", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "shared",
      "user",
    );
    const resolved = await ProjectInstructionsService.getCurrent(fake.db, {
      ...SCOPE,
      agent: "CODING",
    });
    expect(resolved?.content).toBe("shared");
    expect(resolved?.agent).toBeNull();
  });

  it("never crosses project or username boundaries", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "mine", "user");

    expect(
      await ProjectInstructionsService.getCurrent(fake.db, {
        ...SCOPE,
        project: "other-project",
      }),
    ).toBeNull();
    expect(
      await ProjectInstructionsService.getCurrent(fake.db, {
        ...SCOPE,
        username: "someone-else",
      }),
    ).toBeNull();
  });

  it("returns null when nothing has been written", async () => {
    const fake = createFakeDatabase();
    expect(
      await ProjectInstructionsService.getCurrent(fake.db, SCOPE),
    ).toBeNull();
  });

  it("getExactCurrent does not fall back to the project-wide document", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "shared",
      "user",
    );
    expect(
      await ProjectInstructionsService.getExactCurrent(fake.db, {
        ...SCOPE,
        agent: "CODING",
      }),
    ).toBeNull();
  });
});

describe("ProjectInstructionsService.resolveWriteScope", () => {
  it("targets the project-wide document when nothing exists yet", async () => {
    const fake = createFakeDatabase();
    expect(
      await ProjectInstructionsService.resolveWriteScope(fake.db, {
        ...SCOPE,
        agent: "CODING",
      }),
    ).toEqual({ project: "prism", username: "rodrigo", agent: null });
  });

  it("targets the project-wide document an agent actually reads", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "shared",
      "user",
    );
    expect(
      await ProjectInstructionsService.resolveWriteScope(fake.db, {
        ...SCOPE,
        agent: "CODING",
      }),
    ).toEqual({ project: "prism", username: "rodrigo", agent: null });
  });

  it("targets the agent-scoped document once one exists", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "shared",
      "user",
    );
    await ProjectInstructionsService.setContent(
      fake.db,
      { ...SCOPE, agent: "CODING" },
      "coding",
      "user",
    );
    expect(
      await ProjectInstructionsService.resolveWriteScope(fake.db, {
        ...SCOPE,
        agent: "CODING",
      }),
    ).toEqual({ project: "prism", username: "rodrigo", agent: "CODING" });
  });
});

describe("ProjectInstructionsService.appendSection", () => {
  it("creates the document when none exists", async () => {
    const fake = createFakeDatabase();
    const document = await ProjectInstructionsService.appendSection(
      fake.db,
      SCOPE,
      "Build",
      "Run `pnpm build`.",
    );

    expect(document.version).toBe(1);
    expect(document.updatedBy).toBe("agent");
    expect(document.content).toBe("## Build\n\nRun `pnpm build`.");
  });

  it("replaces one section and leaves the rest intact", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "## Build\n\nOld.\n\n## Testing\n\nRun vitest.",
      "user",
    );

    const document = await ProjectInstructionsService.appendSection(
      fake.db,
      SCOPE,
      "Build",
      "New.",
    );

    expect(document.version).toBe(2);
    expect(document.content).toBe(
      "## Build\n\nNew.\n\n## Testing\n\nRun vitest.",
    );
  });

  it("does not manufacture a version for a no-op edit", async () => {
    const fake = createFakeDatabase();
    const first = await ProjectInstructionsService.appendSection(
      fake.db,
      SCOPE,
      "Build",
      "Same.",
    );
    const second = await ProjectInstructionsService.appendSection(
      fake.db,
      SCOPE,
      "Build",
      "Same.",
    );

    expect(second.version).toBe(first.version);
    expect(fake.rows).toHaveLength(1);
  });

  it("writes to the exact scope it is given", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "shared",
      "user",
    );
    const document = await ProjectInstructionsService.appendSection(
      fake.db,
      { ...SCOPE, agent: "CODING" },
      "Build",
      "Agent-only.",
    );

    expect(document.agent).toBe("CODING");
    expect(document.version).toBe(1);
    expect(document.content).toBe("## Build\n\nAgent-only.");
    const shared = await ProjectInstructionsService.getExactCurrent(
      fake.db,
      SCOPE,
    );
    expect(shared?.content).toBe("shared");
  });
});

describe("ProjectInstructionsService.listVersions", () => {
  it("returns history newest first, including superseded rows", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v1", "user");
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v2", "agent");
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v3", "user");

    const versions = await ProjectInstructionsService.listVersions(
      fake.db,
      SCOPE,
    );
    expect(versions.map((row) => row.version)).toEqual([3, 2, 1]);
    expect(versions.map((row) => row.content)).toEqual(["v3", "v2", "v1"]);
  });

  it("clamps the limit", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v1", "user");
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v2", "user");

    expect(
      await ProjectInstructionsService.listVersions(fake.db, SCOPE, 1),
    ).toHaveLength(1);
    expect(
      await ProjectInstructionsService.listVersions(fake.db, SCOPE, 0),
    ).toHaveLength(1);
    expect(
      await ProjectInstructionsService.listVersions(fake.db, SCOPE, 500),
    ).toHaveLength(2);
  });

  it("does not mix scopes", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(
      fake.db,
      SCOPE,
      "shared",
      "user",
    );
    await ProjectInstructionsService.setContent(
      fake.db,
      { ...SCOPE, agent: "CODING" },
      "coding",
      "user",
    );

    const shared = await ProjectInstructionsService.listVersions(
      fake.db,
      SCOPE,
    );
    expect(shared).toHaveLength(1);
    expect(shared[0]?.content).toBe("shared");
  });
});

describe("ProjectInstructionsService.rollbackTo", () => {
  it("restores old content as a NEW version", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v1", "user");
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v2", "agent");

    const rolled = await ProjectInstructionsService.rollbackTo(
      fake.db,
      SCOPE,
      1,
      "user",
    );

    expect(rolled?.version).toBe(3);
    expect(rolled?.content).toBe("v1");
    expect(rolled?.updatedBy).toBe("user");

    const current = await ProjectInstructionsService.getCurrent(fake.db, SCOPE);
    expect(current?.content).toBe("v1");
    expect(current?.version).toBe(3);

    const superseded = fake.rows.find((row) => row.version === 2);
    expect(superseded?.closedReason).toBe("rollback to v1");
  });

  it("returns null for an unknown version", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v1", "user");
    expect(
      await ProjectInstructionsService.rollbackTo(fake.db, SCOPE, 42, "user"),
    ).toBeNull();
    expect(fake.rows).toHaveLength(1);
  });
});

describe("ProjectInstructionsService.clear", () => {
  it("soft-closes the current document but keeps history", async () => {
    const fake = createFakeDatabase();
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v1", "user");
    await ProjectInstructionsService.setContent(fake.db, SCOPE, "v2", "user");

    const closed = await ProjectInstructionsService.clear(
      fake.db,
      SCOPE,
      "user",
    );
    expect(closed?.version).toBe(2);
    expect(closed?.closedReason).toBe("cleared");

    expect(
      await ProjectInstructionsService.getCurrent(fake.db, SCOPE),
    ).toBeNull();
    expect(
      await ProjectInstructionsService.listVersions(fake.db, SCOPE),
    ).toHaveLength(2);

    // Still recoverable — the temporal model never deletes.
    const restored = await ProjectInstructionsService.rollbackTo(
      fake.db,
      SCOPE,
      2,
      "user",
    );
    expect(restored?.content).toBe("v2");
    expect(restored?.version).toBe(3);
  });

  it("returns null when there is nothing to clear", async () => {
    const fake = createFakeDatabase();
    expect(
      await ProjectInstructionsService.clear(fake.db, SCOPE, "user"),
    ).toBeNull();
  });
});
