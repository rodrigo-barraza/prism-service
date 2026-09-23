/**
 * /benchmark/datasets, /benchmark/sweeps and scheduled regressions over
 * HTTP: validation, a run and a sweep (JSON and SSE), what they store, and
 * the scheduled task a schedule creates. The agent turns come from a
 * scripted handleAgent; the store is an in-memory Mongo.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { app } from "./setup.ts";
import benchmarkReliabilityRouter from "#src/routes/BenchmarkReliabilityRoutes";
import benchmarkRouter from "#src/routes/BenchmarkRoutes";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { handleAgent } from "#src/routes/ChatRoutes";

vi.mock("#src/routes/ChatRoutes", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  handleAgent: vi.fn(),
  handleConversation: vi.fn(),
}));

app.use("/benchmark", benchmarkReliabilityRouter);
app.use("/benchmark", benchmarkRouter);

const collections = new Map<string, any[]>();
const matches = (document: any, query: any) =>
  Object.entries(query ?? {}).every(([key, value]) => document[key] === value);
const database = {
  collection: (name: string) => {
    if (!collections.has(name)) collections.set(name, []);
    const documents = collections.get(name)!;
    return {
      insertOne: async (document: any) => {
        documents.push(structuredClone(document));
        return { acknowledged: true };
      },
      findOne: async (query: any) => documents.find((document) => matches(document, query)) ?? null,
      find: (query: any) => {
        const cursor = { sort: () => cursor, toArray: async () => documents.filter((document) => matches(document, query)) };
        return cursor;
      },
      updateOne: async (filter: any, update: any) => {
        const document = documents.find((candidate) => matches(candidate, filter));
        if (document) Object.assign(document, update.$set ?? {});
        return { matchedCount: document ? 1 : 0 };
      },
      deleteOne: async (filter: any) => {
        const index = documents.findIndex((document) => matches(document, filter));
        if (index >= 0) documents.splice(index, 1);
        return { deletedCount: index >= 0 ? 1 : 0 };
      },
      deleteMany: async (filter: any) => {
        const kept = documents.filter((document) => !matches(document, filter));
        documents.splice(0, documents.length, ...kept);
        return { deletedCount: 0 };
      },
    };
  },
};

const send = (method: "get" | "post" | "put" | "delete", path: string) =>
  request(app)[method](path).set("x-gateway-secret", "test-secret").set("x-project", "bench").set("x-username", "tester");

const DATASET = {
  name: "Arithmetic",
  agent: "CODING",
  k: 2,
  cases: [
    { prompt: "What is 6 × 7?", graders: [{ type: "regex", pattern: "\\b42\\b" }] },
    {
      id: "writes",
      prompt: "Write the answer to answer.txt",
      graders: [{ type: "tool_used", tool: "write_file" }],
    },
  ],
};

beforeEach(() => {
  collections.clear();
  vi.mocked(MongoWrapper.getDb).mockReturnValue(database as any);
  vi.mocked(handleAgent).mockReset();
  vi.mocked(handleAgent).mockImplementation(async (parameters: any, emit: any) => {
    emit({ type: "chunk", content: "It is 42." });
    if (parameters.messages.at(-1).content.includes("answer.txt")) {
      emit({ type: "tool_execution", status: "done", tool: { id: "t1", name: "write_file", args: { path: "answer.txt" } } });
    }
    emit({ type: "done", usage: { inputTokens: 50, outputTokens: 5 }, estimatedCost: 0.001 });
  });
});

describe("datasets", () => {
  it("rejects what cannot be run", async () => {
    const cases = [{ prompt: "p", graders: [{ type: "regex", pattern: "a" }] }];
    const errors = [
      [{ cases }, /name is required/],
      [{ name: "x" }, /cases are required/],
      [{ name: "x", cases: [] }, /non-empty array/],
      [{ name: "x", cases: [{ prompt: "p", graders: [] }] }, /at least one grader/],
      [{ name: "x", cases: [{ prompt: "p", graders: [{ type: "regex", pattern: "(" }] }] }, /graders\[0\]: invalid regex/],
      [{ name: "x", cases: [{ prompt: "p", graders: [{ type: "file_exists", path: "../x" }] }] }, /inside the workspace/],
      [{ name: "x", cases: [{ ...cases[0], files: { "/etc/passwd": "" } }] }, /must stay inside the workspace/],
      [{ name: "x", cases: [{ ...cases[0], id: "a" }, { ...cases[0], id: "a" }] }, /unique/],
      [{ name: "x", cases, k: 11 }, /k must be an integer between 1 and 10/],
      [{ name: "x", cases, workspaceRoot: "relative/path" }, /absolute path/],
    ] as const;
    for (const [body, error] of errors) {
      const response = await send("post", "/benchmark/datasets").send(body).expect(400);
      expect(response.body.error).toMatch(error);
    }
  });

  it("create, read, update, list, delete — cases get ids", async () => {
    const created = await send("post", "/benchmark/datasets").send(DATASET).expect(201);
    expect(created.body).toMatchObject({ name: "Arithmetic", project: "bench", k: 2, agent: "CODING" });
    expect(created.body.cases.map((datasetCase: any) => datasetCase.id)).toEqual(["case-1", "writes"]);
    const id = created.body.id;
    await send("get", `/benchmark/datasets/${id}`).expect(200);
    const updated = await send("put", `/benchmark/datasets/${id}`).send({ k: 3 }).expect(200);
    expect(updated.body.k).toBe(3);
    await send("put", `/benchmark/datasets/${id}`).send({ k: 0 }).expect(400);
    const listed = await send("get", "/benchmark/datasets").expect(200);
    expect(listed.body.count).toBe(1);
    await send("delete", `/benchmark/datasets/${id}`).expect(200);
    await send("get", `/benchmark/datasets/${id}`).expect(404);
  });
});

describe("runs and sweeps", () => {
  async function createDataset() {
    return (await send("post", "/benchmark/datasets").send(DATASET).expect(201)).body.id as string;
  }

  it("a run (?stream=false) answers with pass@k / pass^k and stores every trial", async () => {
    const id = await createDataset();
    const response = await send("post", `/benchmark/datasets/${id}/run?stream=false`)
      .send({ target: { provider: "google", model: "gemini-3.5-flash-lite" }, settings: { effort: "low", toolDiscovery: "off" } })
      .expect(200);
    const { run } = response.body;
    expect(run).toMatchObject({
      configKey: "google:gemini-3.5-flash-lite|effort=low|discovery=off",
      k: 2,
      summary: { trials: 4, passRate: 1, passAtK: 1, passHatK: 1, totalCost: 0.004 },
    });
    expect(vi.mocked(handleAgent).mock.calls[0][0]).toMatchObject({ reasoningEffort: "low", toolDiscovery: "off", agent: "CODING" });
    const runs = await send("get", `/benchmark/datasets/${id}/runs`).expect(200);
    expect(runs.body.runs[0].trials).toBeUndefined();
    const full = await send("get", `/benchmark/dataset-runs/${run.id}`).expect(200);
    expect(full.body.trials).toHaveLength(4);
  });

  it("a run streams its trials, then the run", async () => {
    const id = await createDataset();
    const response = await send("post", `/benchmark/datasets/${id}/run`)
      .send({ target: { provider: "google", model: "gemini-3.5-flash-lite" } })
      .expect(200)
      .expect("content-type", /text\/event-stream/);
    const events = String(response.text)
      .split("\n\n")
      .filter((frame) => frame.startsWith("data: "))
      .map((frame) => JSON.parse(frame.slice(6)));
    expect(events.filter((event) => event.type === "trial_complete")).toHaveLength(4);
    expect(events.at(-1)).toMatchObject({ type: "run_complete", run: { summary: { passHatK: 1 } } });
  });

  it("rejects a bad configuration", async () => {
    const id = await createDataset();
    await send("post", `/benchmark/datasets/${id}/run?stream=false`).send({ target: { provider: "google" } }).expect(400);
    await send("post", `/benchmark/datasets/${id}/run?stream=false`)
      .send({ target: { provider: "google", model: "m" }, settings: { toolDiscovery: "sometimes" } })
      .expect(400);
    await send("post", `/benchmark/datasets/missing/run?stream=false`).send({ target: { provider: "google", model: "m" } }).expect(404);
  });

  it("a sweep (?stream=false) answers with its cells and the per-config stats; GET reads it back", async () => {
    const id = await createDataset();
    const response = await send("post", `/benchmark/datasets/${id}/sweeps?stream=false`)
      .send({ axes: { models: [{ provider: "google", model: "gemini-3.5-flash-lite" }], effort: ["low", "high"] }, k: 1 })
      .expect(200);
    expect(response.body.sweep).toMatchObject({ status: "complete", k: 1 });
    expect(response.body.sweep.cells).toHaveLength(2);
    expect(response.body.stats).toHaveLength(2);
    const sweepId = response.body.sweep.id;
    const read = await send("get", `/benchmark/sweeps/${sweepId}`).expect(200);
    expect(read.body.stats.map((stat: any) => stat.settings.effort)).toEqual(["low", "high"]);
    const listed = await send("get", `/benchmark/sweeps?datasetId=${id}`).expect(200);
    expect(listed.body.count).toBe(1);
  });
});

describe("scheduled regression runs", () => {
  it("POST /datasets/:id/schedule creates a benchmark task for the scheduler", async () => {
    const id = (await send("post", "/benchmark/datasets").send(DATASET).expect(201)).body.id;
    const response = await send("post", `/benchmark/datasets/${id}/schedule`)
      .send({
        scheduleType: "cron",
        cronExpression: "0 3 * * *",
        axes: { models: [{ provider: "google", model: "gemini-3.5-flash-lite" }] },
        threshold: 0.2,
        alert: { ntfyTopic: "prism-bench" },
      })
      .expect(201);
    expect(response.body).toMatchObject({
      kind: "benchmark",
      name: "Benchmark regression · Arithmetic",
      scheduleType: "cron",
      cronExpression: "0 3 * * *",
      enabled: true,
      project: "bench",
      benchmark: { datasetId: id, threshold: 0.2, alert: { ntfyTopic: "prism-bench" } },
    });
    expect(collections.get("scheduled_tasks")).toHaveLength(1);
  });

  it("rejects a schedule it could not run", async () => {
    const id = (await send("post", "/benchmark/datasets").send(DATASET).expect(201)).body.id;
    const axes = { models: [{ provider: "google", model: "gemini-3.5-flash-lite" }] };
    const cases = [
      [{ scheduleType: "cron", axes }, /cronExpression/],
      [{ scheduleType: "daily", axes }, /scheduleTime/],
      [{ scheduleType: "whenever", axes }, /scheduleType must be one of/],
      [{ scheduleType: "hourly", axes, threshold: 2 }, /threshold/],
      [{ scheduleType: "hourly", axes, metric: "vibes" }, /metric/],
      [{ scheduleType: "hourly", axes: { models: [] } }, /at least one target/],
    ] as const;
    for (const [body, error] of cases) {
      const response = await send("post", `/benchmark/datasets/${id}/schedule`).send(body).expect(400);
      expect(response.body.error).toMatch(error);
    }
  });
});
