/**
 * DatasetStore — benchmark datasets, their runs and sweeps in Mongo.
 *
 *   benchmark_datasets      one document per dataset (its cases inline)
 *   benchmark_dataset_runs  one per (dataset × configuration) run: every
 *                           trial, per-case pass@k / pass^k, the summary
 *   benchmark_sweeps        one per sweep: its cells and their summaries
 *
 * Everything is scoped by project, like the single-prompt benchmarks.
 */
import crypto from "crypto";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { BENCHMARK, COLLECTIONS } from "#src/constants";
import { validateGrader } from "#src/services/benchmark/DatasetGraders";
import { normaliseWorkspacePath } from "#src/services/benchmark/ScratchWorkspace";
import type {
  BenchmarkDataset,
  BenchmarkSweep,
  DatasetCase,
  DatasetRun,
} from "#src/types/benchmark";

const DATASETS = COLLECTIONS.BENCHMARK_DATASETS;
const RUNS = COLLECTIONS.BENCHMARK_DATASET_RUNS;
const SWEEPS = COLLECTIONS.BENCHMARK_SWEEPS;

export interface DatasetWrite {
  name?: unknown;
  description?: unknown;
  cases?: unknown;
  agent?: unknown;
  enabledTools?: unknown;
  k?: unknown;
  temperature?: unknown;
  maxTokens?: unknown;
  workspaceRoot?: unknown;
  tags?: unknown;
}

function database() {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) throw new Error("Database not available");
  return db;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** A case's mistakes, or null. */
function validateCase(value: unknown, index: number): string | null {
  const where = `cases[${index}]`;
  if (!value || typeof value !== "object") return `${where} must be an object`;
  const datasetCase = value as Partial<DatasetCase>;
  if (typeof datasetCase.prompt !== "string" || !datasetCase.prompt.trim()) {
    return `${where}.prompt is required`;
  }
  if (datasetCase.id !== undefined && (typeof datasetCase.id !== "string" || !datasetCase.id.trim())) {
    return `${where}.id must be a non-empty string`;
  }
  if (!Array.isArray(datasetCase.graders) || datasetCase.graders.length === 0) {
    return `${where} needs at least one grader`;
  }
  if (datasetCase.graders.length > BENCHMARK.MAX_GRADERS_PER_CASE) {
    return `${where} has more than ${BENCHMARK.MAX_GRADERS_PER_CASE} graders`;
  }
  for (const [graderIndex, grader] of datasetCase.graders.entries()) {
    const invalid = validateGrader(grader);
    if (invalid) return `${where}.graders[${graderIndex}]: ${invalid}`;
  }
  if (datasetCase.files !== undefined) {
    if (!datasetCase.files || typeof datasetCase.files !== "object" || Array.isArray(datasetCase.files)) {
      return `${where}.files must map paths to contents`;
    }
    const entries = Object.entries(datasetCase.files);
    if (entries.length > BENCHMARK.MAX_SEED_FILES_PER_CASE) {
      return `${where}.files holds more than ${BENCHMARK.MAX_SEED_FILES_PER_CASE} files`;
    }
    let bytes = 0;
    for (const [path, content] of entries) {
      if (!normaliseWorkspacePath(path)) return `${where}.files: "${path}" must stay inside the workspace`;
      if (typeof content !== "string") return `${where}.files["${path}"] must be text`;
      bytes += Buffer.byteLength(content, "utf-8");
    }
    if (bytes > BENCHMARK.MAX_SEED_BYTES_PER_CASE) {
      return `${where}.files exceed ${BENCHMARK.MAX_SEED_BYTES_PER_CASE} bytes`;
    }
  }
  return null;
}

/**
 * Validate a dataset write. `requireComplete` (create) demands a name and
 * cases; an update checks only the fields it carries.
 */
export function validateDatasetWrite(body: DatasetWrite, requireComplete: boolean): string | null {
  if (requireComplete && (typeof body.name !== "string" || !body.name.trim())) {
    return "name is required";
  }
  if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
    return "name must be a non-empty string";
  }
  if (requireComplete && body.cases === undefined) return "cases are required";
  if (body.cases !== undefined) {
    if (!Array.isArray(body.cases) || body.cases.length === 0) return "cases must be a non-empty array";
    if (body.cases.length > BENCHMARK.MAX_DATASET_CASES) {
      return `a dataset holds at most ${BENCHMARK.MAX_DATASET_CASES} cases`;
    }
    for (const [index, datasetCase] of body.cases.entries()) {
      const invalid = validateCase(datasetCase, index);
      if (invalid) return invalid;
    }
    const ids = body.cases
      .map((datasetCase) => (datasetCase as DatasetCase).id)
      .filter((id): id is string => typeof id === "string");
    if (new Set(ids).size !== ids.length) return "case ids must be unique";
  }
  if (body.k !== undefined) {
    const k = Number(body.k);
    if (!Number.isInteger(k) || k < 1 || k > BENCHMARK.MAX_K) {
      return `k must be an integer between 1 and ${BENCHMARK.MAX_K}`;
    }
  }
  if (body.enabledTools !== undefined && !isStringArray(body.enabledTools)) {
    return "enabledTools must be an array of tool names";
  }
  if (body.tags !== undefined && !isStringArray(body.tags)) return "tags must be an array of strings";
  if (body.agent !== undefined && body.agent !== null && typeof body.agent !== "string") {
    return "agent must be a persona id or null";
  }
  if (
    body.workspaceRoot !== undefined &&
    body.workspaceRoot !== null &&
    (typeof body.workspaceRoot !== "string" || !body.workspaceRoot.startsWith("/"))
  ) {
    return "workspaceRoot must be an absolute path (a registered workspace root)";
  }
  for (const field of ["temperature", "maxTokens"] as const) {
    if (body[field] !== undefined && (typeof body[field] !== "number" || !Number.isFinite(body[field]))) {
      return `${field} must be a number`;
    }
  }
  return null;
}

/** Cases as stored: every one with an id (its position when it named none). */
function normaliseCases(cases: DatasetCase[]): DatasetCase[] {
  return cases.map((datasetCase, index) => ({
    id: datasetCase.id?.trim() || `case-${index + 1}`,
    ...(datasetCase.name && { name: datasetCase.name }),
    prompt: datasetCase.prompt,
    systemPrompt: datasetCase.systemPrompt ?? null,
    graders: datasetCase.graders,
    ...(datasetCase.files && { files: datasetCase.files }),
    ...(datasetCase.tags && { tags: datasetCase.tags }),
  }));
}

function pickDatasetFields(body: DatasetWrite): Partial<BenchmarkDataset> {
  return {
    ...(body.name !== undefined && { name: String(body.name).trim() }),
    ...(body.description !== undefined && { description: String(body.description) }),
    ...(body.cases !== undefined && { cases: normaliseCases(body.cases as DatasetCase[]) }),
    ...(body.agent !== undefined && { agent: (body.agent as string | null) || null }),
    ...(body.enabledTools !== undefined && { enabledTools: body.enabledTools as string[] }),
    ...(body.k !== undefined && { k: Number(body.k) }),
    ...(body.temperature !== undefined && { temperature: body.temperature as number }),
    ...(body.maxTokens !== undefined && { maxTokens: body.maxTokens as number }),
    ...(body.workspaceRoot !== undefined && { workspaceRoot: (body.workspaceRoot as string | null) || null }),
    ...(body.tags !== undefined && { tags: body.tags as string[] }),
  };
}

const DatasetStore = {
  async create(body: DatasetWrite, project: string | null, username: string): Promise<BenchmarkDataset> {
    const now = new Date().toISOString();
    const dataset: BenchmarkDataset = {
      id: crypto.randomUUID(),
      project,
      username,
      name: "",
      cases: [],
      agent: null,
      k: BENCHMARK.DEFAULT_K,
      temperature: 0,
      ...pickDatasetFields(body),
      createdAt: now,
      updatedAt: now,
    };
    await database().collection(DATASETS).insertOne({ ...dataset });
    return dataset;
  },

  async update(id: string, body: DatasetWrite, project: string | null): Promise<BenchmarkDataset | null> {
    await database()
      .collection(DATASETS)
      .updateOne(
        { id, project },
        { $set: { ...pickDatasetFields(body), updatedAt: new Date().toISOString() } },
      );
    return this.get(id, project);
  },

  async get(id: string, project: string | null): Promise<BenchmarkDataset | null> {
    return (await database()
      .collection(DATASETS)
      .findOne({ id, project })) as unknown as BenchmarkDataset | null;
  },

  async list(project: string | null): Promise<BenchmarkDataset[]> {
    return (await database()
      .collection(DATASETS)
      .find({ project })
      .sort({ updatedAt: -1 })
      .toArray()) as unknown as BenchmarkDataset[];
  },

  /** Delete a dataset with its runs and sweeps. */
  async remove(id: string, project: string | null): Promise<void> {
    const db = database();
    await db.collection(DATASETS).deleteOne({ id, project });
    await db.collection(RUNS).deleteMany({ datasetId: id, project });
    await db.collection(SWEEPS).deleteMany({ datasetId: id, project });
  },

  async saveRun(run: DatasetRun): Promise<void> {
    await database().collection(RUNS).insertOne({ ...run });
  },

  async getRun(id: string, project: string | null): Promise<DatasetRun | null> {
    return (await database().collection(RUNS).findOne({ id, project })) as unknown as DatasetRun | null;
  },

  async listRuns(datasetId: string, project: string | null): Promise<DatasetRun[]> {
    return (await database()
      .collection(RUNS)
      .find({ datasetId, project })
      .sort({ startedAt: -1 })
      .toArray()) as unknown as DatasetRun[];
  },

  async insertSweep(sweep: BenchmarkSweep): Promise<void> {
    await database().collection(SWEEPS).insertOne({ ...sweep });
  },

  async updateSweep(id: string, fields: Partial<BenchmarkSweep>): Promise<void> {
    await database().collection(SWEEPS).updateOne({ id }, { $set: fields });
  },

  async getSweep(id: string, project: string | null): Promise<BenchmarkSweep | null> {
    return (await database().collection(SWEEPS).findOne({ id, project })) as unknown as BenchmarkSweep | null;
  },

  async listSweeps(
    filter: { datasetId?: string; scheduleId?: string },
    project: string | null,
  ): Promise<BenchmarkSweep[]> {
    return (await database()
      .collection(SWEEPS)
      .find({ ...filter, project })
      .sort({ startedAt: -1 })
      .toArray()) as unknown as BenchmarkSweep[];
  },

  /** The last finished sweep of a schedule before `beforeSweepId` — the regression baseline. */
  async previousScheduledSweep(
    scheduleId: string,
    project: string | null,
    beforeSweepId: string,
  ): Promise<BenchmarkSweep | null> {
    const sweeps = await this.listSweeps({ scheduleId }, project);
    return (
      sweeps.find((sweep) => sweep.id !== beforeSweepId && sweep.status === "complete") ?? null
    );
  },
};

export default DatasetStore;
