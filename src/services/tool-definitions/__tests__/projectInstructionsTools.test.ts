import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "mongodb";
import type { ProjectInstructionsDocument } from "#src/services/ProjectInstructionsService";

// ────────────────────────────────────────────────────────────
// The tools resolve their own Db handle (there is no request in
// an internal tool call), so the only thing stubbed is
// getDatabase() — the storage logic under test stays real.
// ────────────────────────────────────────────────────────────

const databaseHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("#src/services/ProjectInstructionsService", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("#src/services/ProjectInstructionsService")
    >();
  return {
    ...actual,
    default: {
      ...actual.default,
      getDatabase: () => databaseHolder.current,
    },
  };
});

const { default: projectInstructionsTools } =
  await import("#src/services/tool-definitions/ProjectInstructionsTools");
const { default: InternalToolRegistry } =
  await import("#src/services/tool-definitions/InternalToolRegistry");
const { PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS } =
  await import("#src/services/ProjectInstructionsService");

const [readTool, updateTool, editTool] = projectInstructionsTools;

// ─── Minimal in-memory Mongo double ─────────────────────────

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
        if (!(typeof actual === "number" && actual < operators.$lt))
          return false;
        continue;
      }
      return false;
    }
    if ((expected ?? null) !== actual) return false;
  }
  return true;
}

function createFakeDatabase() {
  const rows: Row[] = [];
  const collection = {
    createIndex: vi.fn(async () => "index"),
    insertOne: vi.fn(async (document: Row) => {
      rows.push(document);
      return { insertedId: document.id };
    }),
    updateMany: vi.fn(
      async (
        filter: Record<string, unknown>,
        update: { $set: Record<string, unknown> },
      ) => {
        for (const row of rows) {
          if (matchesFilter(row, filter)) Object.assign(row, update.$set);
        }
        return { modifiedCount: 0 };
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
  return {
    db: { collection: vi.fn(() => collection) } as unknown as Db,
    rows,
  };
}

const CONTEXT = {
  project: "prism",
  username: "rodrigo",
  agent: "CODING",
  conversationId: "conversation-1",
  agentConversationId: "agent-conversation-1",
};

function asRecord(value: unknown) {
  return value as Record<string, unknown>;
}

beforeEach(() => {
  databaseHolder.current = null;
});

// ─── Registration + shape ───────────────────────────────────

describe("project instruction tools — registration", () => {
  it("exports the read/update/edit trio", () => {
    expect(projectInstructionsTools.map((tool) => tool.name)).toEqual([
      "read_project_instructions",
      "update_project_instructions",
      "edit_project_instructions",
    ]);
  });

  it("is registered in the InternalToolRegistry", () => {
    const names = InternalToolRegistry.getNames();
    expect(names.has("read_project_instructions")).toBe(true);
    expect(names.has("update_project_instructions")).toBe(true);
    expect(names.has("edit_project_instructions")).toBe(true);
  });

  it("carries emoji, display metadata and a domain for the client UI", () => {
    for (const tool of projectInstructionsTools) {
      expect(tool.emoji.length).toBeGreaterThan(0);
      expect(tool.display.activeVerb).toBeTruthy();
      expect(tool.display.completedVerb).toBeTruthy();
      expect(tool.domain).toBe("Core Harness Tools");
    }
  });

  it("tells the model the document is durable, user-visible policy", () => {
    expect(updateTool?.description).toContain(
      "persists across all future conversations",
    );
    expect(updateTool?.description).toContain("user");
    expect(updateTool?.description).toMatch(/never record transient facts/i);

    expect(editTool?.description).toContain(
      "persists across all future conversations",
    );
    expect(editTool?.description).toMatch(/never store transient task state/i);
  });

  it("steers the model to the section edit over the full rewrite", () => {
    expect(editTool?.description).toMatch(
      /Prefer this over update_project_instructions/,
    );
    expect(updateTool?.description).toMatch(/Prefer edit_project_instructions/);
  });
});

describe("project instruction tools — localization", () => {
  it("localizes descriptions through buildSchema", () => {
    const english = editTool?.buildSchema("en");
    const caveman = editTool?.buildSchema("caveman");

    expect(english?.description).toContain("Add or replace ONE");
    expect(caveman?.description).toContain("rule stone");
    expect(caveman?.description).not.toEqual(english?.description);
  });

  it("localizes parameter descriptions too", () => {
    const caveman = editTool?.buildSchema("caveman");
    expect(caveman?.parameters?.properties?.heading?.description).toContain(
      "no leading",
    );
    expect(editTool?.parameters.properties.heading?.description).toContain(
      "without the leading",
    );
  });

  it("localizes through the registry for the caveman locale", () => {
    const schemas = InternalToolRegistry.getSchemas("caveman");
    const schema = schemas.find(
      (candidate) => candidate.name === "edit_project_instructions",
    );
    expect(schema?.description).toContain("rule stone");
  });
});

// ─── Argument validation (no database required) ─────────────

describe("project instruction tools — argument validation", () => {
  it("rejects an empty content rewrite before touching the database", async () => {
    const result = asRecord(await updateTool?.execute({}, CONTEXT));
    expect(String(result.error)).toContain("content is required");
  });

  it("rejects content over the cap", async () => {
    const result = asRecord(
      await updateTool?.execute(
        { content: "x".repeat(PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS + 1) },
        CONTEXT,
      ),
    );
    expect(String(result.error)).toContain("character limit");
  });

  it("rejects a section edit with no heading", async () => {
    const result = asRecord(
      await editTool?.execute({ heading: "  ", body: "x" }, CONTEXT),
    );
    expect(String(result.error)).toContain("heading is required");
  });

  it("reports the store as unavailable when Mongo is down", async () => {
    const result = asRecord(await readTool?.execute({}, CONTEXT));
    expect(String(result.error)).toContain("unavailable");
  });
});

// ─── End-to-end against the in-memory store ─────────────────

describe("project instruction tools — reading and writing", () => {
  let fake: ReturnType<typeof createFakeDatabase>;

  beforeEach(() => {
    fake = createFakeDatabase();
    databaseHolder.current = fake.db;
  });

  it("reports an empty document before anything is written", async () => {
    const result = asRecord(await readTool?.execute({}, CONTEXT));
    expect(result.exists).toBe(false);
    expect(result.content).toBe("");
    expect(result.version).toBe(0);
    expect(String(result.message)).toContain("No project instructions");
  });

  it("adds a section, then replaces it, reporting which happened", async () => {
    const added = asRecord(
      await editTool?.execute(
        { heading: "Build", body: "Run `pnpm build`." },
        CONTEXT,
      ),
    );
    expect(added.status).toBe("added");
    expect(added.version).toBe(1);

    const replaced = asRecord(
      await editTool?.execute(
        { heading: "Build", body: "Run `pnpm run build`." },
        CONTEXT,
      ),
    );
    expect(replaced.status).toBe("replaced");
    expect(replaced.version).toBe(2);

    const read = asRecord(await readTool?.execute({}, CONTEXT));
    expect(read.content).toBe("## Build\n\nRun `pnpm run build`.");
    expect(read.exists).toBe(true);
  });

  it("reports an unchanged edit without creating a version", async () => {
    await editTool?.execute({ heading: "Build", body: "Same." }, CONTEXT);
    const repeat = asRecord(
      await editTool?.execute({ heading: "Build", body: "Same." }, CONTEXT),
    );

    expect(repeat.status).toBe("unchanged");
    expect(repeat.version).toBe(1);
    expect(fake.rows).toHaveLength(1);
  });

  it("leaves other sections alone when editing one", async () => {
    await editTool?.execute({ heading: "Build", body: "Build it." }, CONTEXT);
    await editTool?.execute({ heading: "Testing", body: "Test it." }, CONTEXT);
    await editTool?.execute(
      { heading: "Build", body: "Build it well." },
      CONTEXT,
    );

    const read = asRecord(await readTool?.execute({}, CONTEXT));
    expect(read.content).toBe(
      "## Build\n\nBuild it well.\n\n## Testing\n\nTest it.",
    );
  });

  it("writes to the project-wide document, not a private agent fork", async () => {
    await editTool?.execute({ heading: "Build", body: "Build it." }, CONTEXT);
    expect(fake.rows).toHaveLength(1);
    expect(fake.rows[0]?.agent).toBeNull();
    expect(fake.rows[0]?.updatedBy).toBe("agent");
    expect(fake.rows[0]?.project).toBe("prism");
  });

  it("keeps editing the agent-scoped document once the user creates one", async () => {
    const service = await import("#src/services/ProjectInstructionsService");
    await service.default.setContent(
      fake.db,
      CONTEXT,
      "## Build\n\nUser text.",
      "user",
    );

    await editTool?.execute({ heading: "Testing", body: "Test it." }, CONTEXT);

    const agentScoped = fake.rows.filter((row) => row.agent === "CODING");
    expect(agentScoped).toHaveLength(2);
    expect(fake.rows.some((row) => row.agent === null)).toBe(false);
  });

  it("rewrites the whole document with update_project_instructions", async () => {
    await editTool?.execute({ heading: "Build", body: "Build it." }, CONTEXT);

    const rewritten = asRecord(
      await updateTool?.execute({ content: "# PRISM\n\nAll new." }, CONTEXT),
    );
    expect(rewritten.status).toBe("updated");
    expect(rewritten.version).toBe(2);

    const read = asRecord(await readTool?.execute({}, CONTEXT));
    expect(read.content).toBe("# PRISM\n\nAll new.");
    expect(read.updatedBy).toBe("agent");
  });

  it("refuses a section edit that would push the document over the cap", async () => {
    await updateTool?.execute(
      { content: "x".repeat(PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS - 100) },
      CONTEXT,
    );

    const result = asRecord(
      await editTool?.execute(
        { heading: "Build", body: "y".repeat(500) },
        CONTEXT,
      ),
    );
    expect(String(result.error)).toContain("character limit");
  });
});
