/**
 * The skill usage report (prompt 19, Landing 3): per skill, invocations and
 * last use in the last 30 days, catalog and body tokens, and "never invoked
 * in 30 days" — counted from the usage rows load_skill / execute_skill write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "./setup.ts";
import { createMockCollection } from "./mongoMock.ts";
import adminRouter from "#src/routes/AdminRoutes";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import { estimateTokens } from "#src/utils/CostCalculator";
import { buildSkillUsageReport } from "#src/services/skills/SkillUsage";

app.use("/admin", adminRouter);

const NOW = new Date("2026-09-23T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

function skill(id: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: id,
    project: "prism-chat",
    username: "alice",
    profileId: "default",
    name: id,
    description: `What ${id} is for`,
    content: `BODY of ${id}. `.repeat(10),
    enabled: true,
    usageCount: 0,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

function usage(skillDocumentId: string, at: Date) {
  return {
    _id: `${skillDocumentId}-${at.toISOString()}`,
    skillDocumentId,
    skillId: skillDocumentId,
    name: skillDocumentId,
    kind: "load",
    project: "prism-chat",
    username: "alice",
    profileId: "default",
    agent: "CODING",
    conversationId: "conversation-1",
    agentConversationId: "conversation-1",
    at,
  };
}

function database(skills: unknown[], rows: unknown[]) {
  const collections: Record<string, ReturnType<typeof createMockCollection>> = {
    [COLLECTIONS.AGENT_SKILLS]: createMockCollection(skills),
    [COLLECTIONS.SKILL_USAGE]: createMockCollection(rows),
  };
  return { collection: (name: string) => collections[name] ?? createMockCollection([]) } as never;
}

function seeded() {
  return database(
    [
      skill("deploy-service", { usageCount: 7, lastUsedAt: daysAgo(2).toISOString() }),
      skill("release-notes", { usageCount: 1, lastUsedAt: daysAgo(40).toISOString() }),
      // Used 5 days ago, before usage rows were kept: counted on the skill only.
      skill("api-conventions", { usageCount: 1, lastUsedAt: daysAgo(5).toISOString() }),
      skill("old-habit", { enabled: false }),
      skill("other-project", { project: "elsewhere" }),
    ],
    [
      usage("deploy-service", daysAgo(1)),
      usage("deploy-service", daysAgo(2)),
      usage("deploy-service", daysAgo(29)),
      usage("deploy-service", daysAgo(31)), // outside the window
      usage("release-notes", daysAgo(40)), // outside the window
      usage("deleted-skill", daysAgo(3)), // its skill is gone
    ],
  );
}

describe("buildSkillUsageReport", () => {
  it("counts each skill's invocations from the usage rows in the last 30 days", async () => {
    const report = await buildSkillUsageReport(seeded(), { now: NOW });
    const byName = Object.fromEntries(report.skills.map((row) => [row.name, row]));

    expect(report.windowDays).toBe(30);
    expect(report.since).toBe(daysAgo(30).toISOString());
    expect(byName["deploy-service"]).toMatchObject({
      invocations: 3,
      totalInvocations: 7,
      lastUsedAt: daysAgo(1).toISOString(),
      neverInvokedInWindow: false,
    });
    expect(byName["release-notes"]).toMatchObject({ invocations: 0, neverInvokedInWindow: true });
    expect(byName["api-conventions"]).toMatchObject({ invocations: 0, neverInvokedInWindow: false });
    expect(byName["old-habit"]).toMatchObject({ invocations: 0, neverInvokedInWindow: true, enabled: false });
    expect(report.totals).toMatchObject({ skills: 5, invocations: 3, neverInvokedInWindow: 3 });
  });

  it("prices each skill's catalog line and body", async () => {
    const report = await buildSkillUsageReport(seeded(), { now: NOW });
    const deploy = report.skills.find((row) => row.name === "deploy-service")!;

    expect(deploy.catalogTokens).toBe(estimateTokens("- deploy-service: What deploy-service is for"));
    expect(deploy.bodyTokens).toBe(estimateTokens("BODY of deploy-service. ".repeat(10)));
    // Catalog tokens are paid by enabled skills only.
    const enabled = report.skills.filter((row) => row.enabled);
    expect(report.totals.catalogTokens).toBe(enabled.reduce((sum, row) => sum + row.catalogTokens, 0));
  });

  it("orders skills by name and narrows to one project", async () => {
    const all = await buildSkillUsageReport(seeded(), { now: NOW });
    expect(all.skills.map((row) => row.name)).toEqual([
      "api-conventions",
      "deploy-service",
      "old-habit",
      "other-project",
      "release-notes",
    ]);

    const scoped = await buildSkillUsageReport(seeded(), { now: NOW, project: "prism-chat" });
    expect(scoped.skills.map((row) => row.name)).not.toContain("other-project");
  });
});

describe("GET /admin/skills/usage", () => {
  beforeEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(seeded());
  });

  it("serves the report", async () => {
    const response = await request(app).get("/admin/skills/usage").expect(200);

    expect(response.body.windowDays).toBe(30);
    const deploy = response.body.skills.find((row: { name: string }) => row.name === "deploy-service");
    expect(deploy.totalInvocations).toBe(7);
    expect(deploy.invocations).toBeGreaterThanOrEqual(1);
    expect(response.body.skills.find((row: { name: string }) => row.name === "old-habit").neverInvokedInWindow).toBe(true);
  });

  it("narrows to a project and a user", async () => {
    const response = await request(app)
      .get("/admin/skills/usage?project=elsewhere&username=alice")
      .expect(200);
    expect(response.body.skills.map((row: { name: string }) => row.name)).toEqual(["other-project"]);
  });
});
