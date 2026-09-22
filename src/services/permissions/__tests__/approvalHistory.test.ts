import { describe, it, expect, vi, beforeEach } from "vitest";
import { proposeRule } from "../ApprovalHistory.ts";
import AutoApprovalEngine, { APPROVAL_TIERS } from "#src/services/AutoApprovalEngine";
import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";
import { resolveToolCapabilities } from "../ToolCapabilities.ts";
import { CAPABILITIES } from "../types.ts";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

const inserted: unknown[] = [];
vi.mock("#src/wrappers/MongoWrapper", () => ({
  default: {
    getDb: vi.fn(() => ({
      collection: () => ({ insertOne: vi.fn(async (document: unknown) => inserted.push(document)) }),
    })),
  },
}));

describe("proposeRule — what 'Always allow' offers", () => {
  it.each([
    ["execute_shell", { command: "git status --short" }, "execute_shell(git status:*)", true],
    ["execute_shell", { command: "ls -la" }, "execute_shell(ls:*)", true],
    ["execute_shell", { command: "npm --version" }, "execute_shell(npm:*)", true],
    ["execute_shell", { command: "git add . && git commit -m x" }, "execute_shell(git add:*)", false],
    ["write_file", { path: "/ws/src/components/Card.tsx" }, "write_file(src/components/**)", true],
    ["write_file", { path: "README.md" }, "write_file(README.md)", true],
    ["write_file", { path: "/etc/hosts" }, "write_file(/etc/hosts)", true],
    ["read_web_page", { url: "https://docs.python.org/3/library/re.html" }, "read_web_page(https://docs.python.org/*)", true],
    ["send_email", { to: "a@b.c" }, "send_email", true],
  ])("%s %j → %s", (name, args, rule, coversCall) => {
    expect(proposeRule({ name, args }, "/ws")).toEqual({ rule, coversCall });
  });

  it("escapes glob characters taken from the call", () => {
    expect(proposeRule({ name: "write_file", args: { path: "/ws/a*b/c.ts" } }, "/ws").rule).toBe("write_file(a\\*b/**)");
  });
});

describe("a human approval is recorded for suggestions — without the arguments", () => {
  beforeEach(() => {
    inserted.length = 0;
  });

  it("stamps layer 'user' and logs the proposed rule only", async () => {
    const engine = new AutoApprovalEngine();
    const hook = engine.createHook();
    const toolCall = {
      id: "c1",
      name: "write_file",
      args: { path: "/ws/src/a.ts", content: "SECRET FILE BODY" },
      _approval: { isApproved: true, tier: APPROVAL_TIERS.WRITE, tierLabel: "write", reason: "user_approved" },
    };

    const result = await hook(toolCall, {
      username: "rodrigo",
      profileId: "default",
      project: "prism-client",
      conversationId: "conv-1",
      agent: "CODING",
      workspaceRoot: "/ws",
      options: {},
    } as never);
    await vi.waitFor(() => expect(inserted).toHaveLength(1));

    expect(result).toMatchObject({ isApproved: true, layer: "user" });
    expect(toolCall._approval).toMatchObject({ layer: "user" });
    expect(inserted[0]).toMatchObject({
      username: "rodrigo",
      conversationId: "conv-1",
      toolName: "write_file",
      suggestedRule: "write_file(src/**)",
      decision: "allow",
    });
    expect(JSON.stringify(inserted[0])).not.toContain("SECRET FILE BODY");
  });

  it("does not record approvals the rules or the tier made", async () => {
    const hook = new AutoApprovalEngine().createHook();
    await hook(
      { id: "c2", name: "read_file", args: {}, _approval: { isApproved: true, tier: 1, tierLabel: "auto", reason: "read_only" } },
      { options: {} } as never,
    );
    expect(inserted).toHaveLength(0);
  });
});

describe("internal tools declare their capabilities", () => {
  it("every registered internal tool carries a valid list, and the resolver sees it", () => {
    const vocabulary = new Set<string>(CAPABILITIES);
    const schemas = InternalToolRegistry.getClientSchemas("en") as Array<{ name: string; capabilities?: readonly string[] }>;
    expect(schemas.length).toBeGreaterThan(20);
    const undeclared = schemas.filter((schema) => !Array.isArray(schema.capabilities)).map((schema) => schema.name);
    expect(undeclared).toEqual([]);
    for (const schema of schemas) {
      for (const tag of schema.capabilities!) expect(vocabulary.has(tag), `${schema.name}: ${tag}`).toBe(true);
      expect(resolveToolCapabilities(schema.name)).toEqual(schema.capabilities);
    }
  });
});
