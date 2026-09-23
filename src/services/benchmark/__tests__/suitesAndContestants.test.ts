import { describe, it, expect, vi } from "vitest";
import { BUILTIN_SUITES, builtinSuite } from "#src/services/benchmark/BuiltinSuites";
import { buildSuite, validateCases } from "#src/services/benchmark/Suites";
import { listCatalog } from "#src/services/benchmark/SuiteCatalog";
import { contestantKey, defaultLabel, normaliseSpec, prepareContestants, toContestant } from "#src/services/benchmark/Contestants";
import { buildRequest, classifyFailure, resolveTools } from "#src/services/benchmark/BenchmarkExecutor";
import { evaluateIfEval, instructionsOf } from "#src/services/benchmark/scorers/IfEval";
import type { ContestantSpec } from "#src/types/benchmark";

vi.mock("#src/providers/index", () => ({
  getProvider: (name: string) => {
    if (name === "missing") throw new Error("not configured");
    return {};
  },
}));
vi.mock("#src/config", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getModelByName: (name: string) => ({ name, label: name === "gemini-3.5-flash" ? "Gemini 3.5 Flash" : name }),
}));
vi.mock("#src/services/AgentPersonaRegistry", () => ({
  default: {
    has: (id: string) => ["CODING", "OMNI"].includes(id.toUpperCase()),
    get: (id: string) => ({ id, name: id === "CODING" ? "Coding" : id }),
  },
}));

describe("built-in suites", () => {
  it("are all valid, graded, uniquely identified and carry the canary in code", () => {
    const ids = new Set<string>();
    for (const suite of BUILTIN_SUITES) {
      expect(suite.id).toMatch(/^builtin\./);
      expect(ids.has(suite.id)).toBe(false);
      ids.add(suite.id);
      const cases = validateCases(suite.cases, suite.scorers);
      expect(cases.map((datasetCase) => datasetCase.id)).toEqual(suite.cases.map((datasetCase) => datasetCase.id));
      expect(builtinSuite(suite.id)).toMatchObject({ source: { kind: "builtin" }, project: null });
    }
    expect(builtinSuite("builtin.nope")).toBeNull();
  });

  it("have IFEval metadata every instruction checker knows", () => {
    for (const suite of BUILTIN_SUITES) {
      for (const datasetCase of suite.cases) {
        const instructions = instructionsOf(datasetCase.metadata);
        if (!instructions) continue;
        for (const result of evaluateIfEval("some reply text here", instructions)) expect(result.error).toBeUndefined();
      }
    }
  });

  it("give the coding suite workspace tools, seeds and hidden tests", () => {
    const coding = builtinSuite("builtin.coding-agent")!;
    expect(coding.workspace).toBe(true);
    for (const datasetCase of coding.cases) {
      expect(Object.keys(datasetCase.files ?? {}).length).toBeGreaterThan(0);
      expect(Object.keys(datasetCase.hiddenFiles ?? {}).length).toBeGreaterThan(0);
      expect(datasetCase.scorers?.[0].type).toBe("command");
    }
  });
});

describe("suite validation", () => {
  it("builds a custom suite and turns on the workspace a case needs", () => {
    const suite = buildSuite(
      { name: " Mine ", scorers: [{ type: "exact" }], cases: [{ input: "q", target: "a" }, { id: "files", input: "q", files: { "a.txt": "x" }, target: "a" }] },
      { project: "p", username: "u" },
    );
    expect(suite).toMatchObject({ name: "Mine", workspace: true, version: 1, source: { kind: "custom" } });
    expect(suite.cases[0].id).toBe("case-1");
  });

  it("de-duplicates case ids", () => {
    const cases = validateCases(
      [
        { id: "a", input: "1" },
        { id: "a", input: "2" },
      ],
      [{ type: "exact" }],
    );
    expect(cases.map((datasetCase) => datasetCase.id)).toEqual(["a", "a-2"]);
  });
});

describe("import catalog", () => {
  it("lists every public benchmark with its licence and grading", () => {
    const catalog = listCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(12);
    for (const entry of catalog) {
      expect(entry.license).toBeTruthy();
      expect(entry.url).toMatch(/^https:\/\/huggingface\.co\/datasets\//);
      expect(entry.suggestedSample).toBeGreaterThan(0);
    }
  });
});

describe("contestants", () => {
  const model: ContestantSpec = { kind: "model", provider: "google", model: "gemini-3.5-flash" };

  it("keys a configuration, not its spelling", () => {
    const key = contestantKey(model);
    expect(contestantKey({ ...model, label: "Nice name", temperature: null, harness: {} })).toBe(key);
    expect(contestantKey({ ...model, effort: "high" })).not.toBe(key);
    expect(contestantKey({ ...model, tools: ["b", "a"] })).toBe(contestantKey({ ...model, tools: ["a", "b", "a"] }));
    expect(normaliseSpec({ ...model, kind: "model", agent: "CODING" }).agent).toBeUndefined();
  });

  it("labels by what differs", () => {
    expect(defaultLabel(model)).toBe("Gemini 3.5 Flash");
    expect(defaultLabel({ ...model, effort: "none" })).toBe("Gemini 3.5 Flash · no thinking");
    expect(defaultLabel({ kind: "agent", provider: "google", model: "gemini-3.5-flash", agent: "coding", harness: { maxIterations: 8, toolDiscovery: "off" } })).toBe(
      "Coding · Gemini 3.5 Flash · discovery off · ≤8 steps",
    );
  });

  it("validates a lineup and numbers colliding labels", () => {
    expect(prepareContestants([])).toEqual({ error: "pick at least one contestant" });
    expect(prepareContestants([{ ...model, provider: "missing" }])).toMatchObject({ error: expect.stringMatching(/not configured/) });
    expect(prepareContestants([{ ...model, temperature: 5 }])).toMatchObject({ error: expect.stringMatching(/temperature/) });
    expect(prepareContestants([{ kind: "agent", provider: "google", model: "m" }])).toMatchObject({ error: expect.stringMatching(/needs an agent/) });
    const prepared = prepareContestants([
      { ...model, label: "Same" },
      { ...model, effort: "low", label: "Same" },
    ]);
    expect("contestants" in prepared && prepared.contestants.map((contestant) => contestant.label)).toEqual(["Same", "Same (2)"]);
  });
});

describe("executor requests", () => {
  const model = toContestant({ kind: "model", provider: "google", model: "gemini-3.5-flash", temperature: 0.2, effort: "none", systemPrompt: "Be terse." });
  const agent = toContestant({ kind: "agent", provider: "google", model: "gemini-3.5-flash", agent: "CODING", harness: { maxIterations: 30, compactionThreshold: 16000, topology: "hierarchical" } });

  it("sends a bare model as a plain chat, with its system prompt before the case's", () => {
    const tools = resolveTools(model, { mode: "none" });
    const request = buildRequest({ contestant: model, systemPrompt: "Answer briefly.", messages: [{ role: "user", content: "hi" }], tools, project: "p", username: "u", timeoutMs: 1000 });
    expect(request).toMatchObject({ temperature: 0.2, thinkingEnabled: false, skipConversation: true });
    expect(request.reasoningEffort).toBeUndefined();
    expect(request.agenticLoopEnabled).toBeUndefined();
    expect((request.messages as any[])[0]).toEqual({ role: "system", content: "Be terse.\n\nAnswer briefly." });
  });

  it("sends an agent unattended through the loop, its iteration cap the lower of its own and the suite's", () => {
    const tools = resolveTools(agent, { mode: "none" });
    expect(tools).toEqual({ mode: "agent" });
    const request = buildRequest({ contestant: agent, messages: [{ role: "user", content: "hi" }], tools, maxIterations: 10, workspaceRoot: "/w", project: "p", username: "u", timeoutMs: 1000 });
    expect(request).toMatchObject({
      agent: "CODING",
      agenticLoopEnabled: true,
      // A sample: no learned state in or out.
      evaluation: true,
      // On its persona's own tools nothing that writes runs unasked — and nobody answers.
      autoApprove: false,
      unattended: true,
      onBudgetReached: "stop",
      maxIterations: 10,
      contextWindowLimit: 16000,
      topology: "hierarchical",
      workspaceRoot: "/w",
    });
    expect(request.enabledTools).toBeUndefined();
  });

  it("gives full auto only over the tools a suite names", () => {
    const request = buildRequest({ contestant: agent, messages: [{ role: "user", content: "hi" }], tools: resolveTools(agent, { mode: "list", tools: ["calc"] }), project: "p", username: "u", timeoutMs: 1000 });
    expect(request).toMatchObject({ evaluation: true, autoApprove: true, unattended: true, enabledTools: ["calc"] });
  });

  it("gives a suite's tool list to models and agents alike; a contestant's own list wins", () => {
    expect(resolveTools(model, { mode: "list", tools: ["calc"] })).toEqual({ mode: "list", tools: ["calc"] });
    expect(resolveTools(agent, { mode: "list", tools: ["calc"] })).toEqual({ mode: "list", tools: ["calc"] });
    const own = toContestant({ kind: "model", provider: "google", model: "m", tools: ["search"] });
    expect(resolveTools(own, { mode: "list", tools: ["calc"] })).toEqual({ mode: "list", tools: ["search"] });
    expect(resolveTools(model, { mode: "agent" })).toEqual({ mode: "none" });
  });

  it("classifies failures: infrastructure retries, the contestant's own do not", () => {
    expect(classifyFailure("slow down", { code: "rate_limited", retryable: true })).toEqual({ kind: "provider", message: "slow down", retryable: true });
    expect(classifyFailure("no", { code: "refusal" })).toMatchObject({ kind: "refusal", retryable: false });
    expect(classifyFailure("late", { timedOut: true })).toMatchObject({ kind: "timeout", retryable: false });
    expect(classifyFailure("fetch failed", {})).toMatchObject({ kind: "provider", retryable: true });
    expect(classifyFailure("bad request", { code: "invalid_request" })).toMatchObject({ retryable: false });
  });
});
