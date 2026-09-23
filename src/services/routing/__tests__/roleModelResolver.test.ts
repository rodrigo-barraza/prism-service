/**
 * Prompt 11 Landing 2 — role precedence: custom agent > persona > settings > default,
 * for every role; the caller's model where the resolver documents it; effort first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PROVIDERS } from "#src/constants";
import SettingsService from "#src/services/SettingsService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import ModelRoleRouter, { MODEL_ROLES } from "#src/services/ModelRoleRouter";
import {
  clampEffort,
  effortOneStepLower,
  resolveMainModel,
  resolveOracleModel,
  resolveSubAgentModel,
  resolveUtilityRole,
} from "#src/services/routing/RoleModelResolver";

vi.mock("#src/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

vi.mock("#src/services/SettingsService", () => ({
  default: { getSection: vi.fn().mockResolvedValue({}) },
}));

vi.mock("#src/providers/instance-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/providers/instance-registry")>()),
  listInstances: vi.fn().mockReturnValue([]),
  getInstanceType: vi.fn().mockReturnValue(null),
}));

// Every cloud provider has a key (the oracle's default looks at which do).
vi.mock("#src/services/ModelRoleRouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/services/ModelRoleRouter")>()),
  getAvailableCloudProviders: () => new Set(["anthropic", "openai", "google"]),
}));

// Built-in personas carry no pins today; this one is registered per test.
const PERSONA = "ROUTING_TEST_PERSONA";
const CUSTOM = "ROUTING_TEST_CUSTOM";

function settings(agents: Record<string, unknown>, memory: Record<string, unknown> = {}) {
  vi.mocked(SettingsService.getSection).mockImplementation((async (section: string) =>
    section === "agents" ? agents : section === "memory" ? memory : {}) as never);
}

/** Register a built-in-looking persona (custom: false) and a custom agent, each pinning `role`. */
function pinBoth(role: string, personaModel: string, customModel: string | null) {
  AgentPersonaRegistry.registerCustom({ agentId: PERSONA, name: PERSONA, modelRoles: { [role]: { model: personaModel } } });
  const persona = AgentPersonaRegistry.get(PERSONA)!;
  persona.custom = false; // behave as a built-in persona
  if (customModel) {
    AgentPersonaRegistry.registerCustom({ agentId: CUSTOM, name: CUSTOM, modelRoles: { [role]: { model: customModel } } });
  }
}

describe("RoleModelResolver — precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings({});
    delete process.env.MODEL_ROLE_SUBAGENT;
    delete process.env.MODEL_ROLE_ORACLE;
  });

  afterEach(() => {
    const persona = AgentPersonaRegistry.has(PERSONA) ? AgentPersonaRegistry.get(PERSONA) : null;
    if (persona) persona.custom = true; // so unregister() removes it
    AgentPersonaRegistry.unregister(PERSONA);
    AgentPersonaRegistry.unregister(CUSTOM);
    delete process.env.MODEL_ROLE_SUBAGENT;
  });

  describe("subagent: custom agent > persona > settings > default", () => {
    const parent = { provider: PROVIDERS.ANTHROPIC, model: "claude-sonnet-5", effort: "high" };

    it("custom agent (the member's own `main`) wins over the parent persona's `subagent` pin and Settings", async () => {
      settings({ subAgentProvider: PROVIDERS.GOOGLE, subAgentModel: "gemini-3.6-flash" });
      pinBoth("subagent", "claude-opus-5-5", null);
      AgentPersonaRegistry.registerCustom({ agentId: CUSTOM, name: CUSTOM, modelRoles: { main: { model: "gpt-5.6-luna" } } });

      const decision = await resolveSubAgentModel({ memberAgent: CUSTOM, parentAgent: PERSONA, parent });

      expect(decision).toMatchObject({ provider: PROVIDERS.OPENAI, model: "gpt-5.6-luna", source: "custom_agent", pinnedBy: CUSTOM });
    });

    it("a definition's own model/provider/effort (prompt 17's fields) is its main pin", async () => {
      AgentPersonaRegistry.registerCustom({ agentId: CUSTOM, name: CUSTOM });
      Object.assign(AgentPersonaRegistry.get(CUSTOM)!, { model: "gemini-3.6-flash", effort: "low" });

      const decision = await resolveSubAgentModel({ memberAgent: CUSTOM, parentAgent: "CODING", parent });

      expect(decision).toMatchObject({ provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash", effort: "low", source: "custom_agent" });
    });

    it("persona wins over Settings", async () => {
      settings({ subAgentProvider: PROVIDERS.GOOGLE, subAgentModel: "gemini-3.6-flash" });
      pinBoth("subagent", "claude-opus-5-5", null);

      const decision = await resolveSubAgentModel({ parentAgent: PERSONA, parent });

      expect(decision).toMatchObject({ provider: PROVIDERS.ANTHROPIC, model: "claude-opus-5-5", source: "persona" });
    });

    it("Settings wins over the default; the MODEL_ROLE_SUBAGENT env heads the settings layer", async () => {
      settings({ subAgentProvider: PROVIDERS.GOOGLE, subAgentModel: "gemini-3.6-flash" });
      expect(await resolveSubAgentModel({ parentAgent: "CODING", parent })).toMatchObject({
        provider: PROVIDERS.GOOGLE,
        model: "gemini-3.6-flash",
        source: "settings",
        effort: "high",
      });

      process.env.MODEL_ROLE_SUBAGENT = "openai=gpt-5.6-luna";
      expect(await resolveSubAgentModel({ parentAgent: "CODING", parent })).toMatchObject({
        provider: PROVIDERS.OPENAI,
        model: "gpt-5.6-luna",
        source: "settings",
      });
    });

    it("default: the parent's model, effort one step lower (effort first)", async () => {
      expect(await resolveSubAgentModel({ parentAgent: "CODING", parent })).toMatchObject({
        provider: PROVIDERS.ANTHROPIC,
        model: "claude-sonnet-5",
        effort: "medium",
        source: "default",
      });
    });

    it("the user's explicit model heads the order", async () => {
      pinBoth("subagent", "claude-opus-5-5", null);
      expect(
        await resolveSubAgentModel({ parentAgent: PERSONA, explicitModel: "gemini-3.6-flash", parent }),
      ).toMatchObject({ provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash", source: "request" });
    });
  });

  describe("main: custom agent > persona > the caller's model > settings > default", () => {
    const request = { provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash", effort: "high" };

    it("a custom agent pin beats a persona pin", async () => {
      pinBoth("main", "claude-opus-5-5", "gpt-5.6-luna");
      // The conversation runs AS the custom agent; the persona is not in scope.
      expect(await resolveMainModel({ agent: CUSTOM, request })).toMatchObject({ model: "gpt-5.6-luna", source: "custom_agent" });
      expect(await resolveMainModel({ agent: PERSONA, request })).toMatchObject({ model: "claude-opus-5-5", source: "persona" });
    });

    it("the caller's model beats Settings; Settings fills in when the caller names none", async () => {
      settings({ mainProvider: PROVIDERS.ANTHROPIC, mainModel: "claude-sonnet-5" });
      expect(await resolveMainModel({ agent: "CODING", request })).toMatchObject({ model: "gemini-3.6-flash", source: "request" });
      expect(
        await resolveMainModel({ agent: "CODING", request: { provider: PROVIDERS.GOOGLE, model: null } }),
      ).toMatchObject({ provider: PROVIDERS.ANTHROPIC, model: "claude-sonnet-5", source: "settings" });
    });

    it("default: the provider's default model", async () => {
      const decision = await resolveMainModel({ agent: "CODING", request: { provider: PROVIDERS.GOOGLE } });
      expect(decision.source).toBe("default");
      expect(decision.provider).toBe(PROVIDERS.GOOGLE);
      expect(decision.model).toEqual(expect.any(String));
    });
  });

  describe("oracle: custom agent > persona > settings > default (a frontier model, another provider)", () => {
    const main = { provider: PROVIDERS.ANTHROPIC, model: "claude-sonnet-5" };

    it("follows the same order", async () => {
      pinBoth("oracle", "gemini-3.1-pro-preview", "gpt-6-astra");
      settings({ oracleProvider: PROVIDERS.ANTHROPIC, oracleModel: "claude-opus-5-5" });
      expect(await resolveOracleModel({ agent: CUSTOM, main })).toMatchObject({ model: "gpt-6-astra", source: "custom_agent" });
      expect(await resolveOracleModel({ agent: PERSONA, main })).toMatchObject({ model: "gemini-3.1-pro-preview", source: "persona" });
      expect(await resolveOracleModel({ agent: "CODING", main })).toMatchObject({ model: "claude-opus-5-5", source: "settings" });
    });

    it("default prefers a frontier model from ANOTHER provider", async () => {
      const decision = await resolveOracleModel({ agent: "CODING", main });
      expect(decision).toMatchObject({ source: "default", provider: PROVIDERS.OPENAI, model: "gpt-6-astra" });

      const underGpt = await resolveOracleModel({ agent: "CODING", main: { provider: PROVIDERS.OPENAI, model: "gpt-5.6-luna" } });
      expect(underGpt).toMatchObject({ provider: PROVIDERS.ANTHROPIC, model: "claude-opus-5-5" });
    });
  });

  describe("utility roles (compaction, memory, critic, classifier)", () => {
    it.each([MODEL_ROLES.COMPACTION, MODEL_ROLES.CLASSIFIER, MODEL_ROLES.CRITIC])(
      "%s: custom agent > persona > settings > the utility chain",
      async (role) => {
        const knob = role === MODEL_ROLES.CRITIC ? "critic" : role;
        settings(
          { [`${knob}Provider`]: PROVIDERS.OPENAI, [`${knob}Model`]: "gpt-5.6-luna" },
          { extractionProvider: PROVIDERS.GOOGLE, extractionModel: "gemini-3.5-flash-lite" },
        );
        pinBoth(role, "claude-haiku-4-5", "gemini-3.6-flash");

        expect(await resolveUtilityRole(role, { agent: CUSTOM })).toMatchObject({ model: "gemini-3.6-flash", source: "custom_agent" });
        expect(await resolveUtilityRole(role, { agent: PERSONA })).toMatchObject({ model: "claude-haiku-4-5", source: "persona" });
        expect(await resolveUtilityRole(role, { agent: "CODING" })).toMatchObject({ model: "gpt-5.6-luna", source: "settings" });

        settings({}, { extractionProvider: PROVIDERS.GOOGLE, extractionModel: "gemini-3.5-flash-lite" });
        expect(await resolveUtilityRole(role, { agent: "CODING" })).toMatchObject({ model: "gemini-3.5-flash-lite", source: "default" });

        // The chain callers run heads with the same pin.
        const [head] = await ModelRoleRouter.resolveChain(role, { agents: [CUSTOM] });
        expect(head).toEqual({ provider: PROVIDERS.GOOGLE, model: "gemini-3.6-flash" });
      },
    );

    it("compaction keeps its old order when its own knob is unset: utility model, then the conversation's", async () => {
      settings({}, { extractionProvider: PROVIDERS.GOOGLE, extractionModel: "gemini-3.5-flash-lite" });
      const chain = await ModelRoleRouter.resolveChain(MODEL_ROLES.COMPACTION, {
        fallback: { provider: PROVIDERS.ANTHROPIC, model: "claude-sonnet-5" },
      });
      expect(chain.slice(0, 2)).toEqual([
        { provider: PROVIDERS.GOOGLE, model: "gemini-3.5-flash-lite" },
        { provider: PROVIDERS.ANTHROPIC, model: "claude-sonnet-5" },
      ]);
    });
  });
});

describe("effort ladder", () => {
  it("steps down the model's own levels and never below low", () => {
    expect(effortOneStepLower("high", "claude-sonnet-5")).toBe("medium");
    expect(effortOneStepLower("max", "claude-sonnet-5")).toBe("xhigh");
    expect(effortOneStepLower("low", "claude-sonnet-5")).toBe("low");
    expect(effortOneStepLower("low", "gemini-3.6-flash")).toBe("low");
    expect(effortOneStepLower(null, "claude-sonnet-5")).toBeNull();
  });

  it("clamps an effort the target model lacks to its nearest level below", () => {
    expect(clampEffort("xhigh", "gemini-3.6-flash")).toBe("high");
    expect(clampEffort("medium", "gemini-3.6-flash")).toBe("medium");
    expect(clampEffort("none", "claude-sonnet-5")).toBe("none");
  });
});
