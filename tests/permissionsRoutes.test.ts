import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import supertest from "supertest";
import { app } from "./setup.ts";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { COLLECTIONS } from "#src/constants";
import PermissionRuleSet from "#src/services/permissions/PermissionRuleSet";
import { clearPermissionRuleCache } from "#src/services/permissions/PermissionRuleStore";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import SettingsService from "#src/services/SettingsService";
import {
  PermissionModeHandle,
  PermissionModeRegistry,
} from "#src/services/permissions/PermissionModeState";
import { BYPASS_OWNERS_ENV_VAR } from "#src/services/permissions/PermissionModes";

const { default: permissionsRouter } = await import("#src/routes/PermissionsRoutes");
app.use("/permissions", permissionsRouter);

const PROJECT = "prism-client";
const USERNAME = "rodrigo";

/**
 * Flat equality plus the two operators these routes and the store issue:
 * `$in` (the default profile also owns legacy docs with no profileId) and
 * `$gte` on dates (the approval-history window).
 */
function matches(document: any, query: any): boolean {
  return Object.entries(query || {}).every(([key, value]: [string, any]) => {
    if (value && typeof value === "object" && "$in" in value) {
      return value.$in.includes(document[key] ?? null);
    }
    if (value && typeof value === "object" && "$gte" in value) {
      return document[key] >= value.$gte;
    }
    return (document[key] ?? null) === (value ?? null);
  });
}

function memoryCollection(store: any[]) {
  return {
    find: (query: any = {}) => {
      let results = store.filter((document) => matches(document, query));
      const cursor: any = {
        sort: (criteria: any) => {
          const [field, order] = Object.entries(criteria)[0] as [string, number];
          results = [...results].sort((a, b) => (a[field] < b[field] ? -order : a[field] > b[field] ? order : 0));
          return cursor;
        },
        limit: (count: number) => {
          results = results.slice(0, count);
          return cursor;
        },
        toArray: async () => results.map((document) => ({ ...document })),
      };
      return cursor;
    },
    findOne: async (query: any) => {
      const found = store.find((document) => matches(document, query));
      return found ? { ...found } : null;
    },
    countDocuments: async (query: any = {}) => store.filter((document) => matches(document, query)).length,
    insertOne: async (document: any) => {
      store.push({ ...document, _id: `oid-${store.length}` });
      return { insertedId: document.id };
    },
    findOneAndUpdate: async (query: any, update: any) => {
      const found = store.find((document) => matches(document, query));
      if (!found) return null;
      Object.assign(found, update.$set);
      return { ...found };
    },
    updateOne: async (query: any, update: any) => {
      const found = store.find((document) => matches(document, query));
      if (!found) return { matchedCount: 0, modifiedCount: 0 };
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        const keys = path.split(".");
        let target = found;
        for (const key of keys.slice(0, -1)) target = target[key] ??= {};
        target[keys[keys.length - 1]] = value;
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    findOneAndDelete: async (query: any) => {
      const index = store.findIndex((document) => matches(document, query));
      return index === -1 ? null : store.splice(index, 1)[0];
    },
  };
}

describe("PermissionsRoutes", () => {
  const agent = supertest(app);
  let rules: any[];
  let decisions: any[];
  let conversations: any[];

  const mockDb = {
    collection: (name: string) =>
      name === COLLECTIONS.PERMISSION_RULES
        ? memoryCollection(rules)
        : name === COLLECTIONS.PERMISSION_DECISIONS
          ? memoryCollection(decisions)
          : name === COLLECTIONS.AGENT_CONVERSATIONS
            ? memoryCollection(conversations)
            : memoryCollection([]),
  };

  const as = (request: supertest.Test, profile?: string) => {
    request.set("x-project", PROJECT).set("x-username", USERNAME);
    if (profile) request.set("x-profile-id", profile);
    return request;
  };
  const post = (path: string, body: unknown, profile?: string) =>
    as(agent.post(`/permissions${path}`), profile).send(body as object);

  beforeEach(() => {
    rules = [];
    decisions = [];
    conversations = [];
    clearPermissionRuleCache();
    vi.mocked(MongoWrapper.getDb).mockReturnValue(mockDb as any);
  });

  afterEach(() => {
    vi.mocked(MongoWrapper.getDb).mockReturnValue(null as any);
  });

  describe("CRUD", () => {
    it("creates, lists, updates and deletes a rule in the caller's profile", async () => {
      const created = await post("/rules", { rule: "execute_shell(git *)", decision: "allow", scope: "project" }).expect(201);
      expect(created.body).toMatchObject({
        rule: "execute_shell(git *)",
        decision: "allow",
        scope: "project",
        project: PROJECT,
        username: USERNAME,
        profileId: "default",
        origin: "user",
        enabled: true,
        agent: null,
        conversationId: null,
      });
      expect(created.body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.body._id).toBeUndefined();

      const listed = await as(agent.get("/permissions/rules")).expect(200);
      expect(listed.body.map((rule: any) => rule.id)).toEqual([created.body.id]);

      const updated = await as(agent.put(`/permissions/rules/${created.body.id}`))
        .send({ decision: "ask", description: "careful" })
        .expect(200);
      expect(updated.body).toMatchObject({ decision: "ask", description: "careful" });

      await as(agent.delete(`/permissions/rules/${created.body.id}`)).expect(200);
      await as(agent.get(`/permissions/rules/${created.body.id}`)).expect(404);
      expect(rules).toHaveLength(0);
    });

    it("keeps profiles apart", async () => {
      await post("/rules", { rule: "read_file", decision: "deny", scope: "profile" }, "work").expect(201);
      expect((await as(agent.get("/permissions/rules")).expect(200)).body).toEqual([]);
      expect((await as(agent.get("/permissions/rules"), "work").expect(200)).body).toHaveLength(1);
    });

    it("returns the existing rule instead of stacking an identical one", async () => {
      const body = { rule: "write_file(src/**)", decision: "allow", scope: "conversation", conversationId: "c1", origin: "approval" };
      const first = await post("/rules", body).expect(201);
      const second = await post("/rules", body).expect(200);
      expect(second.body.id).toBe(first.body.id);
      expect(rules).toHaveLength(1);
    });

    it("404s on an unknown id", async () => {
      await as(agent.put("/permissions/rules/nope")).send({ enabled: false }).expect(404);
      await as(agent.delete("/permissions/rules/nope")).expect(404);
    });
  });

  describe("zod validation", () => {
    it.each([
      [{ rule: "capability:telepathy", decision: "deny", scope: "profile" }, /Unknown capability/],
      [{ rule: "execute_shell(/rm -rf (/)", decision: "deny", scope: "profile" }, /Invalid regular expression/],
      [{ rule: "execute shell", decision: "deny", scope: "profile" }, /not a tool name/],
      [{ rule: "read_file", decision: "maybe", scope: "profile" }, /decision/],
      [{ rule: "read_file", decision: "deny", scope: "galaxy" }, /scope/],
      [{ rule: "read_file", decision: "deny", scope: "conversation" }, /conversationId/],
      [{ rule: "read_file", decision: "deny", scope: "profile", surprise: true }, /surprise|Unrecognized/i],
    ])("rejects %j", async (body, message) => {
      const response = await post("/rules", body).expect(400);
      expect(response.body.error).toMatch(message);
      expect(Array.isArray(response.body.issues)).toBe(true);
      expect(rules).toHaveLength(0);
    });

    it("rejects an empty update and a scope change that orphans a conversation rule", async () => {
      const created = await post("/rules", { rule: "read_file", decision: "deny", scope: "profile" }).expect(201);
      await as(agent.put(`/permissions/rules/${created.body.id}`)).send({}).expect(400);
      const orphaned = await as(agent.put(`/permissions/rules/${created.body.id}`)).send({ scope: "conversation" }).expect(400);
      expect(orphaned.body.error).toMatch(/conversationId/);
    });

    it("flags a stored rule that no longer parses", async () => {
      rules.push({ id: "legacy", username: USERNAME, profileId: "default", project: PROJECT, rule: "execute_shell(/(/)", decision: "deny", scope: "profile", enabled: true, createdAt: "2026-01-01" });
      const listed = await as(agent.get("/permissions/rules")).expect(200);
      expect(listed.body[0]).toMatchObject({ invalid: true, error: expect.stringMatching(/Invalid regular expression/) });
    });
  });

  describe("Always allow", () => {
    const call = { toolName: "write_file", args: { path: "/ws/src/components/Card.tsx" }, workspaceRoot: "/ws" };

    it("proposes the directory rule and says whether it covers the call", async () => {
      const proposal = await post("/rules/propose", call).expect(200);
      expect(proposal.body).toMatchObject({ rule: "write_file(src/components/**)", coversCall: true });
      expect(proposal.body.capabilities).toEqual(["fs_write"]);

      const compound = await post("/rules/propose", { toolName: "execute_shell", args: { command: "git add . && npm test" } }).expect(200);
      expect(compound.body).toMatchObject({ rule: "execute_shell(git add:*)", coversCall: false });
    });

    it.each([
      ["conversation", { conversationId: "conv-7" }, { conversationId: "conv-7", project: PROJECT }],
      ["project", {}, { conversationId: null, project: PROJECT }],
      ["profile", {}, { conversationId: null }],
    ])("writes the %s scope", async (scope, extra, expected) => {
      const created = await post("/rules", { rule: "write_file(src/components/**)", decision: "allow", scope, origin: "approval", ...extra }).expect(201);
      expect(created.body).toMatchObject({ scope, origin: "approval", ...expected });
    });

    it("applies to the next call of an already-running loop, without prompting", async () => {
      // The loop loaded its (empty) rule set before the card was clicked.
      const running = await PermissionRuleSet.load({ username: USERNAME, profileId: "default", project: PROJECT, conversationId: "conv-7", workspaceRoot: "/ws" });
      const engine = new AutoApprovalEngine({ permissionRules: running });
      const next = { id: "t2", name: "write_file", args: { path: "/ws/src/components/Other.tsx" } };
      expect(engine.check(next)).toMatchObject({ isApproved: false, layer: "tier" });

      await post("/rules", { rule: "write_file(src/components/**)", decision: "allow", scope: "conversation", conversationId: "conv-7", origin: "approval" }).expect(201);

      expect(engine.check(next)).toMatchObject({ isApproved: true, layer: "rules", ruleScope: "conversation" });
      // A sub-agent spawned in conv-7 inherits it; another conversation does not.
      const subAgent = new AutoApprovalEngine({ permissionRules: running.forSubAgent({ conversationId: "sub-1" }) });
      expect(subAgent.check(next).isApproved).toBe(true);
      const other = await PermissionRuleSet.load({ username: USERNAME, profileId: "default", project: PROJECT, conversationId: "conv-8", workspaceRoot: "/ws" });
      expect(new AutoApprovalEngine({ permissionRules: other }).check(next).isApproved).toBe(false);
    });
  });

  describe("test a call", () => {
    it("explains the decision with the deciding layer and every matched rule", async () => {
      await post("/rules", { rule: "capability:shell", decision: "ask", scope: "profile" }).expect(201);
      await post("/rules", { rule: "execute_shell(rm *)", decision: "deny", scope: "project" }).expect(201);

      const denied = await post("/rules/test", { toolName: "execute_shell", args: { command: "rm -rf build" } }).expect(200);
      expect(denied.body).toMatchObject({ decision: "deny", layer: "rules", rule: "execute_shell(rm *)", ruleScope: "project" });
      expect(denied.body.matchedRules.map((rule: any) => rule.rule)).toEqual(["execute_shell(rm *)", "capability:shell"]);

      const asked = await post("/rules/test", { toolName: "execute_shell", args: { command: "ls" } }).expect(200);
      expect(asked.body).toMatchObject({ decision: "ask", rule: "capability:shell" });

      const read = await post("/rules/test", { toolName: "read_file", args: { absolutePath: "a.ts" } }).expect(200);
      expect(read.body).toMatchObject({ decision: "allow", layer: "tier" });
    });

    it("evaluates an unsaved draft beside the stored rules, without saving it", async () => {
      const response = await post("/rules/test", {
        toolName: "read_web_page",
        args: { url: "https://evil.example/x" },
        draft: { rule: "capability:network", decision: "deny" },
      }).expect(200);
      expect(response.body).toMatchObject({ decision: "deny", rule: "capability:network" });
      expect(rules).toHaveLength(0);
    });

    it("rejects a malformed test body", async () => {
      const response = await post("/rules/test", { args: {} }).expect(400);
      expect(response.body.error).toMatch(/toolName/);
    });
  });

  describe("suggestions", () => {
    it("suggests what was approved at least three times, skipping existing rules", async () => {
      const at = new Date();
      for (let index = 0; index < 5; index++) {
        decisions.push({ username: USERNAME, profileId: "default", toolName: "read_file", suggestedRule: "read_file(src/**)", decision: "allow", at });
      }
      for (let index = 0; index < 2; index++) {
        decisions.push({ username: USERNAME, profileId: "default", toolName: "write_file", suggestedRule: "write_file(docs/**)", decision: "allow", at });
      }
      for (let index = 0; index < 4; index++) {
        decisions.push({ username: USERNAME, profileId: "default", toolName: "execute_shell", suggestedRule: "execute_shell(git status:*)", decision: "allow", at });
      }
      await post("/rules", { rule: "execute_shell(git status:*)", decision: "allow", scope: "profile" }).expect(201);

      const response = await as(agent.get("/permissions/rules/suggestions")).expect(200);
      expect(response.body).toEqual([
        { rule: "read_file(src/**)", toolName: "read_file", count: 5, lastApprovedAt: at.toISOString() },
      ]);
    });
  });

  describe("modes", () => {
    const put = (path: string, body: unknown) => as(agent.put(`/permissions${path}`)).send(body as object);
    const previousOwners = process.env[BYPASS_OWNERS_ENV_VAR];

    afterEach(() => {
      PermissionModeRegistry.clear();
      if (previousOwners === undefined) delete process.env[BYPASS_OWNERS_ENV_VAR];
      else process.env[BYPASS_OWNERS_ENV_VAR] = previousOwners;
    });

    it("describes the modes, and which this user may pick", async () => {
      delete process.env[BYPASS_OWNERS_ENV_VAR];
      const response = await as(agent.get("/permissions/mode")).expect(200);
      expect(response.body).toMatchObject({ mode: "default", source: "default", defaultMode: "default", bypassAllowed: false });
      expect(response.body.modes.map((mode: any) => mode.id)).toEqual([
        "default",
        "plan",
        "acceptEdits",
        "auto",
        "dontAsk",
        "bypass",
      ]);
      const bypass = response.body.modes.find((mode: any) => mode.id === "bypass");
      expect(bypass).toMatchObject({ available: false });
      expect(bypass.unavailableReason).toContain(BYPASS_OWNERS_ENV_VAR);
    });

    it("stores a conversation's mode and switches its running turn", async () => {
      conversations.push({ id: "conv-1", project: PROJECT, username: USERNAME });
      const handle = new PermissionModeHandle("default", { source: "conversation" });
      const heard: unknown[] = [];
      handle.onChange((change) => heard.push(change));
      PermissionModeRegistry.register("conv-1", handle);

      const response = await put("/mode", { conversationId: "conv-1", mode: "plan" }).expect(200);

      expect(response.body).toEqual({ conversationId: "conv-1", mode: "plan", stored: true, live: true });
      expect(conversations[0].approvals.permissionMode).toBe("plan");
      expect(handle.mode).toBe("plan");
      expect(heard).toEqual([{ mode: "plan", previousMode: "default", source: "user" }]);
      // While the turn runs, its mode is what GET reports.
      const current = await as(agent.get("/permissions/mode?conversationId=conv-1")).expect(200);
      expect(current.body).toMatchObject({ mode: "plan", source: "running" });
    });

    it("bypass is owner-only", async () => {
      conversations.push({ id: "conv-1", project: PROJECT, username: USERNAME });
      delete process.env[BYPASS_OWNERS_ENV_VAR];
      const refused = await put("/mode", { conversationId: "conv-1", mode: "bypass" }).expect(403);
      expect(refused.body.error).toContain("owner-only");
      expect(conversations[0].approvals).toBeUndefined();

      process.env[BYPASS_OWNERS_ENV_VAR] = USERNAME;
      await put("/mode", { conversationId: "conv-1", mode: "bypass" }).expect(200);
      expect(conversations[0].approvals.permissionMode).toBe("bypass");
    });

    it("404s on an unknown conversation and 400s on an unknown mode", async () => {
      await put("/mode", { conversationId: "nope", mode: "plan" }).expect(404);
      await put("/mode", { conversationId: "nope", mode: "yolo" }).expect(400);
    });

    it("sets the default mode — never bypass", async () => {
      // tests/setup.ts's SettingsService double has no `update`; lend it one.
      const update = vi.fn().mockResolvedValue({});
      (SettingsService as any).update = update;
      try {
        await put("/mode/default", { mode: "bypass" }).expect(400);
        expect(update).not.toHaveBeenCalled();
        await put("/mode/default", { mode: "acceptEdits" }).expect(200);
        expect(update).toHaveBeenCalledWith({ permissions: { defaultMode: "acceptEdits" } });
      } finally {
        delete (SettingsService as any).update;
      }
    });

    it("the tester judges a call in a given mode", async () => {
      const response = await post("/rules/test", {
        toolName: "write_file",
        args: { path: "src/a.ts" },
        workspaceRoot: "/ws",
        permissionMode: "plan",
      }).expect(200);
      expect(response.body).toMatchObject({ decision: "deny", layer: "mode", mode: "plan" });
    });
  });

  it("lists the capability vocabulary", async () => {
    const response = await as(agent.get("/permissions/capabilities")).expect(200);
    expect(response.body.capabilities).toContain("external_side_effect");
  });
});
