/**
 * BenchmarkStore — suites, runs, samples, battles and lineups in Mongo.
 *
 * Every read and write of a user-facing document is scoped by project.
 * A run's samples are created up front as `pending` and updated as they
 * finish, so a reload shows a run exactly as far as it got and a resumed
 * run knows what is left.
 */
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import type {
  Battle,
  BenchmarkRun,
  BenchmarkSample,
  BenchmarkSuite,
  ContestantLineup,
  SampleStatus,
  SuiteSummary,
} from "#src/types/benchmark";

function database() {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) throw new Error("Database not available");
  return db;
}

/** A stored document without Mongo's `_id`. */
function withoutId<Document>(document: unknown): Document | null {
  if (!document || typeof document !== "object") return null;
  const { _id, ...rest } = document as Record<string, unknown>;
  return rest as Document;
}

const summariseSuite = (suite: BenchmarkSuite): SuiteSummary => {
  const { cases, ...rest } = suite;
  const caseTags = new Set<string>();
  for (const datasetCase of cases ?? []) for (const tag of datasetCase.tags ?? []) caseTags.add(tag);
  return { ...rest, caseCount: cases?.length ?? 0, caseTags: [...caseTags].sort() };
};

const BenchmarkStore = {
  // ── Suites ──────────────────────────────────────────────────
  async listSuites(project: string | null): Promise<SuiteSummary[]> {
    const suites = (await database()
      .collection(COLLECTIONS.BENCHMARK_SUITES)
      .find({ project })
      .sort({ updatedAt: -1 })
      .toArray()) as unknown as BenchmarkSuite[];
    return suites.map((suite) => summariseSuite(withoutId<BenchmarkSuite>(suite)!));
  },

  async getSuite(id: string, project: string | null): Promise<BenchmarkSuite | null> {
    return withoutId<BenchmarkSuite>(await database().collection(COLLECTIONS.BENCHMARK_SUITES).findOne({ id, project }));
  },

  async insertSuite(suite: BenchmarkSuite): Promise<BenchmarkSuite> {
    await database().collection(COLLECTIONS.BENCHMARK_SUITES).insertOne({ ...suite });
    return suite;
  },

  async replaceSuite(suite: BenchmarkSuite): Promise<void> {
    await database()
      .collection(COLLECTIONS.BENCHMARK_SUITES)
      .updateOne({ id: suite.id, project: suite.project }, { $set: { ...suite } });
  },

  async deleteSuite(id: string, project: string | null): Promise<boolean> {
    const result = await database().collection(COLLECTIONS.BENCHMARK_SUITES).deleteOne({ id, project });
    return result.deletedCount > 0;
  },

  summariseSuite,

  // ── Runs ────────────────────────────────────────────────────
  async insertRun(run: BenchmarkRun): Promise<void> {
    await database().collection(COLLECTIONS.BENCHMARK_EVALS).insertOne({ ...run });
  },

  async getRun(id: string, project: string | null): Promise<BenchmarkRun | null> {
    return withoutId<BenchmarkRun>(await database().collection(COLLECTIONS.BENCHMARK_EVALS).findOne({ id, project }));
  },

  /** A run by id regardless of project — the engine's own reads. */
  async getRunById(id: string): Promise<BenchmarkRun | null> {
    return withoutId<BenchmarkRun>(await database().collection(COLLECTIONS.BENCHMARK_EVALS).findOne({ id }));
  },

  async listRuns(
    project: string | null,
    { scheduleId, limit = 100 }: { scheduleId?: string | null; limit?: number } = {},
  ): Promise<BenchmarkRun[]> {
    const query: Record<string, unknown> = { project };
    if (scheduleId) query.scheduleId = scheduleId;
    const runs = (await database()
      .collection(COLLECTIONS.BENCHMARK_EVALS)
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()) as unknown as BenchmarkRun[];
    return runs.map((run) => withoutId<BenchmarkRun>(run)!);
  },

  /** Runs left `running` / `judging` / `queued` — a restart interrupted them. */
  async listUnfinishedRuns(): Promise<BenchmarkRun[]> {
    const collection = database().collection(COLLECTIONS.BENCHMARK_EVALS);
    const runs: BenchmarkRun[] = [];
    for (const status of ["queued", "running", "judging"]) {
      const found = (await collection.find({ status }).toArray()) as unknown as BenchmarkRun[];
      runs.push(...found.map((run) => withoutId<BenchmarkRun>(run)!));
    }
    return runs;
  },

  async updateRun(id: string, fields: Partial<BenchmarkRun>): Promise<void> {
    await database().collection(COLLECTIONS.BENCHMARK_EVALS).updateOne({ id }, { $set: fields });
  },

  async deleteRun(id: string, project: string | null): Promise<boolean> {
    const db = database();
    const result = await db.collection(COLLECTIONS.BENCHMARK_EVALS).deleteOne({ id, project });
    if (result.deletedCount === 0) return false;
    await db.collection(COLLECTIONS.BENCHMARK_SAMPLES).deleteMany({ runId: id });
    await db.collection(COLLECTIONS.BENCHMARK_BATTLES).deleteMany({ runId: id });
    return true;
  },

  // ── Samples ─────────────────────────────────────────────────
  async insertSamples(samples: BenchmarkSample[]): Promise<void> {
    if (samples.length === 0) return;
    const collection = database().collection(COLLECTIONS.BENCHMARK_SAMPLES);
    // insertMany in slices keeps each round trip small.
    for (let start = 0; start < samples.length; start += 500) {
      await collection.insertMany(samples.slice(start, start + 500).map((sample) => ({ ...sample })));
    }
  },

  async updateSample(id: string, fields: Partial<BenchmarkSample>): Promise<void> {
    await database().collection(COLLECTIONS.BENCHMARK_SAMPLES).updateOne({ id }, { $set: fields });
  },

  /**
   * A run's samples — all of them (the report reads every one), or those
   * matching `filter` (suiteId, caseId, contestantKey, status). Without
   * `withOutput` the tool trace and the thinking stay in the database.
   */
  async listSamples(
    runId: string,
    { withOutput = false, filter = {} }: { withOutput?: boolean; filter?: Partial<Pick<BenchmarkSample, "suiteId" | "caseId" | "contestantKey" | "status">> } = {},
  ): Promise<BenchmarkSample[]> {
    const projection = withOutput ? undefined : { projection: { "output.toolCalls": 0, "output.thinking": 0 } };
    const query: Record<string, unknown> = { runId };
    for (const [key, value] of Object.entries(filter)) if (value !== undefined) query[key] = value;
    const samples = (await database()
      .collection(COLLECTIONS.BENCHMARK_SAMPLES)
      .find(query, projection)
      .toArray()) as unknown as BenchmarkSample[];
    return samples.map((sample) => withoutId<BenchmarkSample>(sample)!);
  },

  async listSamplesByStatus(runId: string, statuses: SampleStatus[]): Promise<BenchmarkSample[]> {
    const collection = database().collection(COLLECTIONS.BENCHMARK_SAMPLES);
    const samples: BenchmarkSample[] = [];
    for (const status of statuses) {
      const found = (await collection.find({ runId, status }).toArray()) as unknown as BenchmarkSample[];
      samples.push(...found.map((sample) => withoutId<BenchmarkSample>(sample)!));
    }
    return samples;
  },

  async getSample(runId: string, id: string): Promise<BenchmarkSample | null> {
    return withoutId<BenchmarkSample>(await database().collection(COLLECTIONS.BENCHMARK_SAMPLES).findOne({ runId, id }));
  },

  /** Past samples of one contestant key — what a new run of it will likely cost. */
  async recentSamplesOf(contestantKey: string, limit = 200): Promise<BenchmarkSample[]> {
    const samples = (await database()
      .collection(COLLECTIONS.BENCHMARK_SAMPLES)
      .find({ contestantKey, status: "done" }, { projection: { output: 0, scores: 0 } })
      .sort({ completedAt: -1 })
      .limit(limit)
      .toArray()) as unknown as BenchmarkSample[];
    return samples.map((sample) => withoutId<BenchmarkSample>(sample)!);
  },

  // ── Battles ─────────────────────────────────────────────────
  async insertBattle(battle: Battle): Promise<void> {
    await database().collection(COLLECTIONS.BENCHMARK_BATTLES).insertOne({ ...battle });
  },

  async listBattles(query: Record<string, unknown>, limit = 50_000): Promise<Battle[]> {
    const battles = (await database()
      .collection(COLLECTIONS.BENCHMARK_BATTLES)
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray()) as unknown as Battle[];
    return battles.map((battle) => withoutId<Battle>(battle)!);
  },

  async deleteBattle(id: string, project: string | null): Promise<boolean> {
    const result = await database().collection(COLLECTIONS.BENCHMARK_BATTLES).deleteOne({ id, project });
    return result.deletedCount > 0;
  },

  // ── Lineups ─────────────────────────────────────────────────
  async listLineups(project: string | null): Promise<ContestantLineup[]> {
    const lineups = (await database()
      .collection(COLLECTIONS.BENCHMARK_LINEUPS)
      .find({ project })
      .sort({ updatedAt: -1 })
      .toArray()) as unknown as ContestantLineup[];
    return lineups.map((lineup) => withoutId<ContestantLineup>(lineup)!);
  },

  async saveLineup(lineup: ContestantLineup): Promise<void> {
    const collection = database().collection(COLLECTIONS.BENCHMARK_LINEUPS);
    const existing = await collection.findOne({ id: lineup.id, project: lineup.project });
    if (existing) await collection.updateOne({ id: lineup.id, project: lineup.project }, { $set: { ...lineup } });
    else await collection.insertOne({ ...lineup });
  },

  async deleteLineup(id: string, project: string | null): Promise<boolean> {
    const result = await database().collection(COLLECTIONS.BENCHMARK_LINEUPS).deleteOne({ id, project });
    return result.deletedCount > 0;
  },
};

export default BenchmarkStore;

/** The indexes the benchmark collections need (created at boot, see index.ts). */
export const BENCHMARK_INDEXES: Array<{ collection: string; keys: Record<string, number>; options?: { unique?: boolean } }> = [
  { collection: COLLECTIONS.BENCHMARK_SUITES, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.BENCHMARK_SUITES, keys: { project: 1, updatedAt: -1 } },
  { collection: COLLECTIONS.BENCHMARK_EVALS, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.BENCHMARK_EVALS, keys: { project: 1, createdAt: -1 } },
  { collection: COLLECTIONS.BENCHMARK_EVALS, keys: { status: 1 } },
  { collection: COLLECTIONS.BENCHMARK_EVALS, keys: { scheduleId: 1, createdAt: -1 } },
  { collection: COLLECTIONS.BENCHMARK_SAMPLES, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.BENCHMARK_SAMPLES, keys: { runId: 1, status: 1 } },
  { collection: COLLECTIONS.BENCHMARK_SAMPLES, keys: { contestantKey: 1, status: 1, completedAt: -1 } },
  { collection: COLLECTIONS.BENCHMARK_BATTLES, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.BENCHMARK_BATTLES, keys: { project: 1, createdAt: -1 } },
  { collection: COLLECTIONS.BENCHMARK_BATTLES, keys: { runId: 1 } },
  { collection: COLLECTIONS.BENCHMARK_LINEUPS, keys: { id: 1 }, options: { unique: true } },
  { collection: COLLECTIONS.BENCHMARK_LINEUPS, keys: { project: 1, updatedAt: -1 } },
];
