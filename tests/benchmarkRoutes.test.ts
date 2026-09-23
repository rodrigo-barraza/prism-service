/**
 * /benchmark over HTTP, end to end: suites (custom, built-in, import),
 * estimates, runs as background jobs (progress events, report, samples,
 * overrides, cancel/resume, regrade, pairwise judging, rerun, export),
 * run comparison, the leaderboard, the arena (blind votes and a live
 * battle) and schedules. Contestants and judges are a scripted
 * handleConversation / handleAgent; the store is an in-memory Mongo; the
 * workspace is an in-memory tools-service.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { app } from "./setup.ts";
import benchmarkRouter from "#src/routes/BenchmarkRoutes";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { handleAgent, handleConversation } from "#src/routes/ChatRoutes";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import { RunEvents } from "#src/services/benchmark/RunEngine";

vi.mock("#src/routes/ChatRoutes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  handleAgent: vi.fn(),
  handleConversation: vi.fn(),
}));

app.use("/benchmark", benchmarkRouter);

// ── In-memory Mongo ─────────────────────────────────────────
const collections = new Map<string, any[]>();
const matches = (document: any, query: any) => Object.entries(query ?? {}).every(([key, value]) => document[key] === value);
function cursor(documents: any[]) {
  let result = [...documents];
  const api = {
    sort: (spec: Record<string, number>) => {
      const [[field, direction]] = Object.entries(spec);
      result.sort((a, b) => (a[field] < b[field] ? -direction : a[field] > b[field] ? direction : 0));
      return api;
    },
    limit: (count: number) => {
      result = result.slice(0, count);
      return api;
    },
    toArray: async () => structuredClone(result),
  };
  return api;
}
const database = {
  collection: (name: string) => {
    if (!collections.has(name)) collections.set(name, []);
    const documents = collections.get(name)!;
    return {
      insertOne: async (document: any) => {
        documents.push(structuredClone(document));
        return { acknowledged: true };
      },
      insertMany: async (list: any[]) => {
        documents.push(...list.map((document) => structuredClone(document)));
        return { acknowledged: true };
      },
      findOne: async (query: any) => structuredClone(documents.find((document) => matches(document, query)) ?? null),
      find: (query: any) => cursor(documents.filter((document) => matches(document, query))),
      updateOne: async (filter: any, update: any) => {
        const document = documents.find((candidate) => matches(candidate, filter));
        if (document) Object.assign(document, structuredClone(update.$set ?? {}));
        return { matchedCount: document ? 1 : 0 };
      },
      deleteOne: async (filter: any) => {
        const index = documents.findIndex((document) => matches(document, filter));
        if (index >= 0) documents.splice(index, 1);
        return { deletedCount: index >= 0 ? 1 : 0 };
      },
      deleteMany: async (filter: any) => {
        const kept = documents.filter((document) => !matches(document, filter));
        const deleted = documents.length - kept.length;
        documents.splice(0, documents.length, ...kept);
        return { deletedCount: deleted };
      },
    };
  },
};

const send = (method: "get" | "post" | "put" | "patch" | "delete", path: string) =>
  request(app)[method](path).set("x-gateway-secret", "test-secret").set("x-project", "bench").set("x-username", "tester");

// ── Scripted contestants and judges ─────────────────────────
const STRONG = { kind: "model", provider: "google", model: "gemini-3.5-flash-lite" };
const WEAK = { kind: "model", provider: "google", model: "gemini-3-flash" };
let gate: Promise<void> | null = null;

function contestantReply(parameters: any): string {
  const question = String(parameters.messages.at(-1).content);
  const strong = parameters.model === STRONG.model;
  if (question.includes("6 × 7")) return strong ? "Answer: 42" : "Answer: 41";
  if (question.includes("capital of France")) return "Paris";
  if (question.includes("Explain")) return strong ? "A thorough explanation." : "Short.";
  return "I don't know.";
}

function judgeReply(parameters: any): string {
  const system = String(parameters.messages[0].content);
  const user = String(parameters.messages[1].content);
  if (system.includes("comparing two assistants")) {
    // The judge prefers the thorough answer, whichever side it is on.
    const answerA = user.split("<<<ANSWER_A")[1]?.split("ANSWER_A>>>")[0] ?? "";
    return JSON.stringify({ winner: answerA.includes("thorough") ? "A" : "B", reasoning: "more thorough" });
  }
  if (system.includes("RUBRIC")) {
    const response = user.split("<<<RESPONSE")[1] ?? "";
    return JSON.stringify({ score: response.includes("thorough") ? 9 : 3, reasoning: "graded" });
  }
  return JSON.stringify({ grade: "CORRECT" });
}

beforeEach(() => {
  collections.clear();
  gate = null;
  vi.mocked(MongoWrapper.getDb).mockReturnValue(database as any);
  vi.mocked(handleConversation).mockReset();
  vi.mocked(handleConversation).mockImplementation(async (parameters: any, emit: any) => {
    if (parameters.responseFormat === "json_object") {
      emit({ type: "chunk", content: judgeReply(parameters) });
      emit({ type: "done", usage: { inputTokens: 100, outputTokens: 10 }, estimatedCost: 0.0001 });
      return;
    }
    if (gate) await gate;
    emit({ type: "chunk", content: contestantReply(parameters) });
    emit({ type: "done", usage: { inputTokens: 40, outputTokens: 8, requests: 1 }, estimatedCost: 0.001, tokensPerSec: 50 });
  });
  vi.mocked(handleAgent).mockReset();
  vi.mocked(handleAgent).mockImplementation(async (parameters: any, emit: any) => {
    emit({ type: "tool_execution", status: "done", tool: { id: "t1", name: "evaluate_expression", args: { expression: "6*7" }, result: { result: 42 } } });
    emit({ type: "chunk", content: `Answer: 42 (${parameters.agent ?? "no agent"})` });
    emit({ type: "done", usage: { inputTokens: 4000, outputTokens: 30, requests: 2 }, estimatedCost: 0.01 });
  });
});

const ARITHMETIC = {
  name: "Arithmetic",
  scorers: [{ type: "numeric" }],
  cases: [
    { id: "six-sevens", input: "What is 6 × 7?", target: "42", tags: ["math"] },
    { id: "france", input: "What is the capital of France?", target: "Paris", scorers: [{ type: "includes" }], tags: ["geo"] },
  ],
};

async function createSuite(body: Record<string, unknown> = ARITHMETIC) {
  return (await send("post", "/benchmark/suites").send(body).expect(201)).body;
}

async function waitForRun(runId: string, statuses = ["completed", "cancelled", "failed"]) {
  for (let attempt = 0; attempt < 1500; attempt++) {
    const run = (await send("get", `/benchmark/runs/${runId}`).expect(200)).body;
    if (statuses.includes(run.status) && !run.live) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not finish`);
}

async function startRun(suiteIds: string[], contestants: any[], settings: Record<string, unknown> = {}) {
  const created = await send("post", "/benchmark/runs").send({ suiteIds, contestants, settings }).expect(201);
  return waitForRun(created.body.id);
}

describe("suites", () => {
  it("rejects suites that cannot be graded or run", async () => {
    const cases = [{ input: "q", target: "a" }];
    const errors: Array<[Record<string, unknown>, RegExp]> = [
      [{ cases, scorers: [{ type: "exact" }] }, /needs a name/],
      [{ name: "x", cases: [] }, /at least one case/],
      [{ name: "x", cases }, /no scorer/],
      [{ name: "x", cases, scorers: [{ type: "regex", pattern: "(" }] }, /invalid regex/],
      [{ name: "x", cases: [{ input: "q", scorers: [{ type: "ifeval" }] }] }, /metadata\.ifeval/],
      [{ name: "x", cases: [{ input: "q", files: { "../x": "" } }], scorers: [{ type: "exact" }] }, /inside the workspace/],
      [{ name: "x", cases: [{ input: [{ role: "assistant", content: "hi" }] }], scorers: [{ type: "exact" }] }, /end on a user message/],
    ];
    for (const [body, error] of errors) {
      const response = await send("post", "/benchmark/suites").send(body).expect(400);
      expect(response.body.error).toMatch(error);
    }
  });

  it("lists built-ins with custom suites; built-ins are read-only but duplicate into editable copies", async () => {
    const custom = await createSuite();
    expect(custom.version).toBe(1);
    const listed = (await send("get", "/benchmark/suites").expect(200)).body.suites;
    expect(listed.map((suite: any) => suite.id)).toEqual(expect.arrayContaining(["builtin.smoke", "builtin.reasoning", custom.id]));
    expect(listed.find((suite: any) => suite.id === "builtin.smoke").caseCount).toBe(11);
    await send("put", "/benchmark/suites/builtin.smoke").send({ name: "mine" }).expect(400);
    await send("delete", "/benchmark/suites/builtin.smoke").expect(400);
    const copy = (await send("post", "/benchmark/suites/builtin.smoke/duplicate").send({}).expect(201)).body;
    expect(copy.name).toBe("Smoke test (copy)");
    const edited = (await send("put", `/benchmark/suites/${copy.id}`).send({ name: "My smoke" }).expect(200)).body;
    expect(edited).toMatchObject({ name: "My smoke", version: 2 });
    await send("delete", `/benchmark/suites/${copy.id}`).expect(200);
    await send("get", `/benchmark/suites/${copy.id}`).expect(404);
  });

  it("imports a public benchmark, sampled with a seed", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({
      row_idx: index,
      row: { question: `What is ${index} + ${index}?`, answer: `Double it.\n#### ${index * 2}` },
    }));
    const fetchMock = vi.mocked(global.fetch);
    const previous = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: any, init: any) => {
      if (String(url).includes("datasets-server.huggingface.co/rows")) {
        const offset = Number(new URL(String(url)).searchParams.get("offset"));
        return { ok: true, status: 200, json: async () => ({ rows: rows.slice(offset, offset + 100), num_rows_total: rows.length }) } as any;
      }
      return previous!(url, init);
    });
    try {
      const first = (await send("post", "/benchmark/suites/import").send({ catalogId: "gsm8k", limit: 3, seed: 5 }).expect(201)).body;
      expect(first).toMatchObject({ caseCount: 3, source: { kind: "import", ref: "gsm8k", totalRows: 7, sampledRows: 3, seed: 5 } });
      const suite = (await send("get", `/benchmark/suites/${first.id}`).expect(200)).body;
      for (const datasetCase of suite.cases) {
        const n = Number(/What is (\d+)/.exec(datasetCase.input)![1]);
        expect(datasetCase.target).toBe(String(n * 2));
      }
      const again = (await send("post", "/benchmark/suites/import").send({ catalogId: "gsm8k", limit: 3, seed: 5 }).expect(201)).body;
      const againSuite = (await send("get", `/benchmark/suites/${again.id}`).expect(200)).body;
      expect(againSuite.cases.map((datasetCase: any) => datasetCase.id)).toEqual(suite.cases.map((datasetCase: any) => datasetCase.id));
      await send("post", "/benchmark/suites/import").send({ catalogId: "nope" }).expect(400);
    } finally {
      fetchMock.mockImplementation(previous!);
    }
  });

  it("serves the import catalog", async () => {
    const { entries } = (await send("get", "/benchmark/catalog").expect(200)).body;
    expect(entries.map((entry: any) => entry.id)).toEqual(
      expect.arrayContaining(["gsm8k", "math500", "mmlu_pro", "gpqa_diamond", "ifeval", "simpleqa_verified", "humaneval", "aime2026"]),
    );
    expect(entries.find((entry: any) => entry.id === "gpqa_diamond")).toMatchObject({ gated: true, available: false });
  });
});

describe("runs", () => {
  it("estimates before running: samples, cost band, detectable difference, warnings", async () => {
    const suite = await createSuite();
    const estimate = (
      await send("post", "/benchmark/estimate")
        .send({ suiteIds: [suite.id], contestants: [STRONG, { kind: "agent", provider: "google", model: STRONG.model, agent: "CODING" }], settings: { epochs: 3 } })
        .expect(200)
    ).body;
    expect(estimate).toMatchObject({ samples: 12, cases: 2, battles: 0 });
    expect(estimate.total.high).toBeGreaterThan(estimate.total.low);
    expect(estimate.detectableDifference).toBeGreaterThan(0.5);
    expect(estimate.warnings.join(" ")).toMatch(/persona's assembled system prompt/);
    expect(estimate.contestants).toHaveLength(2);
  });

  it("refuses a bad request", async () => {
    const suite = await createSuite();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ suiteIds: [], contestants: [STRONG] }, /at least one suite/],
      [{ suiteIds: [suite.id], contestants: [] }, /at least one contestant/],
      [{ suiteIds: [suite.id], contestants: [STRONG, { ...STRONG }] }, /same configuration/],
      [{ suiteIds: [suite.id], contestants: [{ kind: "agent", provider: "google", model: STRONG.model, agent: "NOPE" }] }, /unknown agent/],
      [{ suiteIds: [suite.id], contestants: [{ kind: "agent", provider: "google", model: STRONG.model, agent: "CODING", tools: "none" }] }, /persona's tools/],
      [{ suiteIds: ["missing"], contestants: [STRONG] }, /not found/],
      [{ suiteIds: [suite.id], contestants: [STRONG], settings: { judges: ["nobody:nothing"] } }, /not available/],
    ];
    for (const [body, error] of cases) {
      const response = await send("post", "/benchmark/runs").send(body).expect(400);
      expect(response.body.error).toMatch(error);
    }
  });

  it("runs every case × contestant × epoch in the background and reports with intervals and paired tests", async () => {
    const suite = await createSuite();
    const run = await startRun([suite.id], [STRONG, WEAK], { epochs: 2 });
    expect(run.status).toBe("completed");
    expect(run.progress).toMatchObject({ total: 8, done: 8, errored: 0 });
    expect(run.results.leader.key).toBe(run.contestants[0].key);

    const report = (await send("get", `/benchmark/runs/${run.id}/report`).expect(200)).body;
    const [strong, weak] = report.overall;
    expect(strong).toMatchObject({ label: expect.stringContaining("Flash"), mean: 1, passRate: 1, cases: 2, samples: 4, rank: 1 });
    expect(weak).toMatchObject({ mean: 0.5, passRate: 0.5, rank: 2 });
    expect(strong.passCurve.map((point: any) => point.k)).toEqual([1, 2]);
    expect(strong.ci.low).toBeLessThan(1);
    const [pair] = report.suites[0].pairwise;
    expect(pair).toMatchObject({ n: 2, wins: 1, ties: 1, losses: 0, test: "mcnemar" });
    expect(report.suites[0].caseRows.find((row: any) => row.caseId === "six-sevens").discrimination).toBe(1);
    expect(report.suites[0].health).toMatchObject({ saturated: 1, unsolved: 0, discriminating: 1 });
    expect(report.suites[0].tags.map((tag: any) => tag.tag)).toEqual(expect.arrayContaining(["math", "geo"]));
    expect(report.pareto.cost).toContain(strong.key);

    const samples = (await send("get", `/benchmark/runs/${run.id}/samples?caseId=six-sevens&full=1`).expect(200)).body.samples;
    expect(samples).toHaveLength(4);
    const wrong = samples.find((sample: any) => sample.contestantKey === weak.key);
    expect(wrong.scores[0]).toMatchObject({ type: "numeric", passed: false, answer: "41", expected: "42" });
    const one = (await send("get", `/benchmark/runs/${run.id}/samples/${wrong.id}`).expect(200)).body;
    expect(one.output.text).toBe("Answer: 41");
  });

  it("streams progress events to a listener and ends when the run does", async () => {
    const suite = await createSuite();
    let release!: () => void;
    gate = new Promise<void>((resolve) => (release = resolve));
    const created = (await send("post", "/benchmark/runs").send({ suiteIds: [suite.id], contestants: [STRONG] }).expect(201)).body;
    // Let the contestants answer only once the listener is subscribed.
    const subscribe = RunEvents.subscribe.bind(RunEvents);
    const spy = vi.spyOn(RunEvents, "subscribe").mockImplementation((runId, listener) => {
      const unsubscribe = subscribe(runId, listener);
      release();
      return unsubscribe;
    });
    const response = await send("get", `/benchmark/runs/${created.id}/events`).expect(200).expect("content-type", /text\/event-stream/);
    spy.mockRestore();
    const events = String(response.text)
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)));
    expect(events[0]).toMatchObject({ type: "snapshot", live: true });
    expect(events.filter((event) => event.type === "sample")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "end", status: "completed" });
    // A finished run answers with its snapshot and ends at once.
    const after = await send("get", `/benchmark/runs/${created.id}/events`).expect(200);
    expect(String(after.text)).toMatch(/"type":"snapshot"[\s\S]*"type":"end"/);
  });

  it("counts an infrastructure error as a failure by default and leaves it out on request; retries it on resume", async () => {
    const suite = await createSuite();
    let failing = true;
    vi.mocked(handleConversation).mockImplementation(async (parameters: any, emit: any) => {
      if (failing && parameters.messages.at(-1).content.includes("France")) {
        emit({ type: "error", code: "invalid_request", message: "boom", retryable: false });
        return;
      }
      emit({ type: "chunk", content: contestantReply(parameters) });
      emit({ type: "done", usage: { inputTokens: 10, outputTokens: 2 }, estimatedCost: 0.001 });
    });
    const run = await startRun([suite.id], [STRONG]);
    expect(run.progress).toMatchObject({ done: 1, errored: 1 });
    const strict = (await send("get", `/benchmark/runs/${run.id}/report`).expect(200)).body.overall[0];
    expect(strict).toMatchObject({ mean: 0.5, errored: 1, errors: { provider: 1 } });
    const lenient = (await send("get", `/benchmark/runs/${run.id}/report?errors=exclude`).expect(200)).body.overall[0];
    expect(lenient).toMatchObject({ mean: 1, cases: 1 });

    failing = false;
    await send("post", `/benchmark/runs/${run.id}/resume`).send({}).expect(200);
    const resumed = await waitForRun(run.id);
    expect(resumed.progress).toMatchObject({ done: 2, errored: 0 });
    const healed = (await send("get", `/benchmark/runs/${run.id}/report`).expect(200)).body.overall[0];
    expect(healed.mean).toBe(1);
  });

  it("retries a retryable provider error before giving up on the sample", async () => {
    const suite = await createSuite({ ...ARITHMETIC, cases: [ARITHMETIC.cases[0]] });
    let calls = 0;
    vi.mocked(handleConversation).mockImplementation(async (parameters: any, emit: any) => {
      calls++;
      if (calls === 1) {
        emit({ type: "error", code: "rate_limited", message: "429", retryable: true });
        return;
      }
      emit({ type: "chunk", content: contestantReply(parameters) });
      emit({ type: "done", usage: { inputTokens: 10, outputTokens: 2 }, estimatedCost: 0.001 });
    });
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout"] });
    try {
      const created = (await send("post", "/benchmark/runs").send({ suiteIds: [suite.id], contestants: [STRONG] }).expect(201)).body;
      await vi.advanceTimersByTimeAsync(5_000);
      vi.useRealTimers();
      const run = await waitForRun(created.id);
      expect(run.progress).toMatchObject({ done: 1, errored: 0 });
      const [sample] = (await send("get", `/benchmark/runs/${run.id}/samples`).expect(200)).body.samples;
      expect(sample.attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops starting samples at the budget and says so", async () => {
    const suite = await createSuite();
    const run = await startRun([suite.id], [STRONG, WEAK], { budgetUsd: 0.0005, concurrency: 1 });
    expect(run.status).toBe("cancelled");
    expect(run.statusReason).toMatch(/budget/);
    const samples = (await send("get", `/benchmark/runs/${run.id}/samples`).expect(200)).body.samples;
    expect(samples.filter((sample: any) => sample.status === "cancelled").every((sample: any) => sample.error.kind === "budget")).toBe(true);
  });

  it("takes a person's verdict over the scorers, and measures the judges against it", async () => {
    const suite = await createSuite({
      name: "Judged",
      scorers: [{ type: "rubric", rubric: "Is it thorough?" }],
      cases: [{ id: "explain", input: "Explain gravity." }],
    });
    const run = await startRun([suite.id], [STRONG, WEAK]);
    const samples = (await send("get", `/benchmark/runs/${run.id}/samples`).expect(200)).body.samples;
    const weakSample = samples.find((sample: any) => sample.contestantKey !== run.contestants[0].key);
    expect(weakSample.passed).toBe(false);
    await send("patch", `/benchmark/runs/${run.id}/samples/${weakSample.id}`).send({ override: { passed: "yes" } }).expect(400);
    await send("patch", `/benchmark/runs/${run.id}/samples/${weakSample.id}`).send({ override: { passed: true, note: "fine by me" } }).expect(200);
    const report = (await send("get", `/benchmark/runs/${run.id}/report`).expect(200)).body;
    const meanOf = (body: any, key: string) => body.overall.find((summary: any) => summary.key === key).mean;
    // The rubric's 9/10 is a 0.9 score; the person's pass is a 1.
    expect(meanOf(report, run.contestants[0].key)).toBe(0.9);
    expect(meanOf(report, weakSample.contestantKey)).toBe(1);
    expect(report.judgeAgreement).toMatchObject({ compared: 1, agreed: 0 });
    await send("patch", `/benchmark/runs/${run.id}/samples/${weakSample.id}`).send({ override: null }).expect(200);
    const cleared = (await send("get", `/benchmark/runs/${run.id}/report`).expect(200)).body;
    expect(cleared.overall.find((summary: any) => summary.key === weakSample.contestantKey).mean).toBe(0.3);
  });

  it("regrades stored answers with the suite's current scorers, without asking the contestants again", async () => {
    const suite = await createSuite({ ...ARITHMETIC, cases: [ARITHMETIC.cases[0]] });
    const run = await startRun([suite.id], [WEAK]);
    expect((await send("get", `/benchmark/runs/${run.id}/report`).expect(200)).body.overall[0].mean).toBe(0);
    const callsBefore = vi.mocked(handleConversation).mock.calls.length;
    // The suite now accepts anything within 2 of the target.
    await send("put", `/benchmark/suites/${suite.id}`).send({ scorers: [{ type: "numeric", tolerance: 0.05 }] }).expect(200);
    await send("post", `/benchmark/runs/${run.id}/regrade`).send({}).expect(202);
    const regraded = await waitForRun(run.id);
    expect(vi.mocked(handleConversation).mock.calls.length).toBe(callsBefore);
    expect(regraded.suites[0].version).toBe(2);
    expect((await send("get", `/benchmark/runs/${run.id}/report`).expect(200)).body.overall[0].mean).toBe(1);
  });

  it("judges finished answers head to head and fits arena ratings for the run", async () => {
    const suite = await createSuite({
      name: "Explain",
      scorers: [{ type: "length", unit: "characters", min: 1 }],
      cases: [
        { id: "gravity", input: "Explain gravity." },
        { id: "tides", input: "Explain tides." },
      ],
    });
    const run = await startRun([suite.id], [STRONG, WEAK], { pairwise: { mode: "all_pairs" } });
    expect(run.progress).toMatchObject({ battlesTotal: 2, battlesDone: 2 });
    const report = (await send("get", `/benchmark/runs/${run.id}/report`).expect(200)).body;
    expect(report.arena.standings[0]).toMatchObject({ key: run.contestants[0].key, wins: 2, losses: 0 });
    expect(report.arena.inconsistentJudgements).toBe(0);
    // Judging again on demand adds nothing new: every pair is judged.
    await send("post", `/benchmark/runs/${run.id}/pairwise`).send({ mode: "vs_baseline", baselineKey: run.contestants[1].key }).expect(202);
    const again = await waitForRun(run.id);
    expect(again.progress.battlesDone).toBe(2);
    const standings = (await send("get", `/benchmark/arena?source=judge`).expect(200)).body;
    expect(standings.standings[0].key).toBe(run.contestants[0].key);
  });

  it("runs an agent through the agent loop with its harness knobs and the suite's tools", async () => {
    const suite = await createSuite({
      name: "Tools",
      scorers: [{ type: "tool_called", tool: "evaluate_expression" }, { type: "numeric" }],
      tools: { mode: "list", tools: ["evaluate_expression"] },
      limits: { maxIterations: 5 },
      cases: [{ id: "multiply", input: "Use the calculator: 6 × 7", target: "42" }],
    });
    const agent = { kind: "agent", provider: "google", model: STRONG.model, agent: "CODING", effort: "low", harness: { toolDiscovery: "off", maxIterations: 8 } };
    const run = await startRun([suite.id], [agent, STRONG]);
    const params = vi.mocked(handleAgent).mock.calls.map((call) => call[0] as any);
    const agentCall = params.find((parameters) => parameters.agent === "CODING");
    expect(agentCall).toMatchObject({
      agenticLoopEnabled: true,
      autoApprove: true,
      unattended: true,
      reasoningEffort: "low",
      thinkingEnabled: true,
      toolDiscovery: "off",
      maxIterations: 5,
      enabledTools: ["evaluate_expression"],
      skipConversation: true,
    });
    // The bare model gets the suite's tools through function calling (same loop, no persona).
    const modelCall = params.find((parameters) => !parameters.agent);
    expect(modelCall).toMatchObject({ functionCallingEnabled: true, enabledTools: ["evaluate_expression"] });
    const report = (await send("get", `/benchmark/runs/${run.id}/report`).expect(200)).body;
    expect(report.overall.every((summary: any) => summary.mean === 1)).toBe(true);
    expect(report.overall[0].meanToolCalls).toBe(1);
  });

  it("reruns, compares two runs and exports", async () => {
    const suite = await createSuite();
    const base = await startRun([suite.id], [STRONG, WEAK]);
    const rerun = (await send("post", `/benchmark/runs/${base.id}/rerun`).send({}).expect(201)).body;
    const head = await waitForRun(rerun.id);
    expect(head.baselineRunId).toBe(base.id);
    const comparison = (await send("get", `/benchmark/compare?base=${base.id}&head=${head.id}`).expect(200)).body;
    expect(comparison.deltas).toHaveLength(2);
    expect(comparison.deltas.every((delta: any) => delta.diff === 0 && !delta.significant)).toBe(true);
    const csv = await send("get", `/benchmark/runs/${base.id}/export?format=csv`).expect(200);
    expect(String(csv.text).split("\n")).toHaveLength(5);
    expect(String(csv.text)).toMatch(/^suite,case,contestant/);
    const json = (await send("get", `/benchmark/runs/${base.id}/export`).expect(200)).body;
    expect(json.samples).toHaveLength(4);
    await send("delete", `/benchmark/runs/${base.id}`).expect(200);
    await send("get", `/benchmark/runs/${base.id}`).expect(404);
    expect(collections.get("benchmark_samples")!.filter((sample) => sample.runId === base.id)).toHaveLength(0);
  });

  it("builds the leaderboard from the latest result of every contestant on every suite", async () => {
    const suite = await createSuite();
    const first = await startRun([suite.id], [STRONG]);
    const second = await startRun([suite.id], [STRONG, WEAK]);
    const board = (await send("get", "/benchmark/leaderboard").expect(200)).body;
    expect(board.suites).toEqual([{ id: suite.id, name: "Arithmetic", runs: 2 }]);
    const strongKey = second.contestants[0].key;
    expect(board.cells[suite.id][strongKey]).toMatchObject({ mean: 1, runId: second.id });
    expect(board.contestants.find((contestant: any) => contestant.key === strongKey).runs).toBe(2);
    expect(first.contestants[0].key).toBe(strongKey);
  });
});

describe("workspace suites", () => {
  it("seeds files, writes hidden tests after the answer and grades by running them", async () => {
    const files = new Map<string, string>();
    const execute = vi.spyOn(ToolOrchestratorService, "executeTool").mockImplementation(async (name: string, args: any) => {
      if (name === "write_file") {
        files.set(args.path, args.content);
        return { success: true };
      }
      if (name === "delete_file") {
        for (const path of [...files.keys()]) if (path.startsWith(args.path)) files.delete(path);
        return { success: true };
      }
      if (name === "execute_command") {
        const solution = [...files.entries()].find(([path]) => path.startsWith(args.cwd) && path.endsWith("solution.txt"))?.[1] ?? "";
        const hidden = [...files.keys()].some((path) => path.startsWith(args.cwd) && path.endsWith("hidden_test.sh"));
        return { exitCode: hidden && solution.includes("fixed") ? 0 : 1, stdout: hidden ? "ran" : "no test", stderr: "" };
      }
      return { error: `unexpected tool ${name}` };
    });
    vi.spyOn(ToolOrchestratorService, "getWorkspaceRoot").mockReturnValue("/srv/bench");
    vi.mocked(handleAgent).mockImplementation(async (parameters: any, emit: any) => {
      // The agent "fixes" the file in its workspace, which the run passed as its root.
      files.set(`${parameters.workspaceRoot}/solution.txt`, parameters.model === STRONG.model ? "fixed" : "still broken");
      emit({ type: "chunk", content: "done" });
      emit({ type: "done", usage: { inputTokens: 10, outputTokens: 2 }, estimatedCost: 0.002 });
    });
    try {
      const suite = await createSuite({
        name: "Fix it",
        tools: { mode: "list", tools: ["write_file"] },
        cases: [
          {
            id: "fix",
            input: "Fix solution.txt",
            files: { "solution.txt": "broken" },
            hiddenFiles: { "hidden_test.sh": "grep fixed solution.txt" },
            scorers: [{ type: "command", command: "sh hidden_test.sh" }],
          },
        ],
      });
      expect(suite.workspace).toBe(true);
      const run = await startRun([suite.id], [STRONG, WEAK]);
      const report = (await send("get", `/benchmark/runs/${run.id}/report`).expect(200)).body;
      expect(report.overall.map((summary: any) => summary.mean)).toEqual([1, 0]);
      const workspaces = vi.mocked(handleAgent).mock.calls.map((call) => (call[0] as any).workspaceRoot);
      expect(new Set(workspaces).size).toBe(2);
      expect(workspaces.every((root: string) => root.startsWith(`/srv/bench/.prism-benchmarks/${run.id}/`))).toBe(true);
      // Every scratch directory is removed afterwards.
      expect([...files.keys()]).toEqual([]);
    } finally {
      execute.mockRestore();
    }
  });
});

describe("arena", () => {
  it("serves blind pairs of a run's answers, least-voted pair first, and reveals names after the vote", async () => {
    const suite = await createSuite({
      name: "Explain",
      scorers: [{ type: "length", unit: "characters", min: 1 }],
      cases: [{ id: "gravity", input: "Explain gravity." }],
    });
    const run = await startRun([suite.id], [STRONG, WEAK], { epochs: 2 });
    const { pair } = (await send("get", `/benchmark/runs/${run.id}/arena/next`).expect(200)).body;
    expect(pair).toMatchObject({ caseId: "gravity", prompt: "Explain gravity.", remaining: 2 });
    expect(JSON.stringify(pair)).not.toMatch(/Flash|contestantKey/);
    const thorough = pair.a.output.includes("thorough") ? "a" : "b";
    const voted = (await send("post", `/benchmark/runs/${run.id}/arena/votes`).send({ aSampleId: pair.a.sampleId, bSampleId: pair.b.sampleId, winner: thorough }).expect(201)).body;
    expect(voted.reveal[thorough]).toBe(run.contestants[0].label);
    await send("post", `/benchmark/runs/${run.id}/arena/votes`).send({ aSampleId: pair.a.sampleId, bSampleId: pair.b.sampleId, winner: "maybe" }).expect(400);
    const next = (await send("get", `/benchmark/runs/${run.id}/arena/next`).expect(200)).body.pair;
    expect(next.remaining).toBe(1);
    await send("post", `/benchmark/runs/${run.id}/arena/votes`).send({ aSampleId: next.a.sampleId, bSampleId: next.b.sampleId, winner: "tie" }).expect(201);
    expect((await send("get", `/benchmark/runs/${run.id}/arena/next`).expect(200)).body.pair).toBeNull();
    const standings = (await send("get", "/benchmark/arena?source=human").expect(200)).body;
    expect(standings).toMatchObject({ battles: 2, source: "human" });
    expect(standings.standings[0]).toMatchObject({ key: run.contestants[0].key, wins: 1, ties: 1 });
    const battles = (await send("get", "/benchmark/arena/battles?source=human").expect(200)).body.battles;
    expect(battles).toHaveLength(2);
    await send("delete", `/benchmark/arena/battles/${battles[0].id}`).expect(200);
  });

  it("streams a live battle blind and records the vote", async () => {
    const response = await send("post", "/benchmark/arena/live").send({ prompt: "Explain rainbows.", contestants: [STRONG, WEAK] }).expect(200);
    const events = String(response.text)
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)));
    expect(events.filter((event) => event.type === "side").map((event) => event.side).sort()).toEqual(["a", "b"]);
    expect(events.filter((event) => event.type === "side_done")).toHaveLength(2);
    const ready = events.find((event) => event.type === "ready");
    expect(JSON.stringify(events)).not.toMatch(/Flash/);
    const vote = (await send("post", `/benchmark/arena/live/${ready.token}/vote`).send({ winner: "both_bad" }).expect(201)).body;
    expect(new Set([vote.reveal.a, vote.reveal.b]).size).toBe(2);
    await send("post", `/benchmark/arena/live/${ready.token}/vote`).send({ winner: "a" }).expect(404);
    const bad = await send("post", "/benchmark/arena/live").send({ prompt: "x", contestants: [STRONG] }).expect(200);
    expect(String(bad.text)).toMatch(/exactly two contestants/);
  });
});

describe("lineups and schedules", () => {
  it("saves, lists and deletes lineups", async () => {
    await send("post", "/benchmark/lineups").send({ name: "x", contestants: [{ kind: "model" }] }).expect(400);
    const saved = (await send("post", "/benchmark/lineups").send({ name: "Frontier", contestants: [STRONG, WEAK] }).expect(201)).body;
    const renamed = (await send("post", "/benchmark/lineups").send({ id: saved.id, name: "Frontier 2", contestants: [STRONG] }).expect(200)).body;
    expect(renamed).toMatchObject({ id: saved.id, name: "Frontier 2" });
    expect((await send("get", "/benchmark/lineups").expect(200)).body.count).toBe(1);
    await send("delete", `/benchmark/lineups/${saved.id}`).expect(200);
  });

  it("creates a scheduled benchmark task, refusing one that could not run", async () => {
    const suite = await createSuite();
    await send("post", "/benchmark/schedules").send({ suiteIds: [suite.id], contestants: [], scheduleType: "daily", scheduleTime: "03:00" }).expect(400);
    await send("post", "/benchmark/schedules").send({ suiteIds: [suite.id], contestants: [STRONG], scheduleType: "daily" }).expect(400);
    const task = (
      await send("post", "/benchmark/schedules")
        .send({ name: "Nightly", suiteIds: [suite.id], contestants: [STRONG], threshold: 0.1, scheduleType: "cron", cronExpression: "0 3 * * *" })
        .expect(201)
    ).body;
    expect(task).toMatchObject({ kind: "benchmark", name: "Nightly", benchmark: { suiteIds: [suite.id], threshold: 0.1 } });
  });
});
