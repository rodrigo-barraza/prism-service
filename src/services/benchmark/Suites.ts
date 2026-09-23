/**
 * Suites — the registry a run draws its cases from.
 *
 * Built-in suites live in code (BuiltinSuites) and are read-only; imported
 * and custom suites live in Mongo per project. Every write is validated
 * here: case ids unique, every case graded (its own scorers or the
 * suite's), scorers well-formed, seed files inside the workspace and
 * within size. An edit bumps the suite's version; a run keeps a snapshot
 * of the version it evaluated.
 */
import crypto from "crypto";
import { BENCHMARK } from "#src/constants";
import BenchmarkStore from "#src/services/benchmark/BenchmarkStore";
import { BUILTIN_SUITES, builtinSuite, isBuiltinSuiteId } from "#src/services/benchmark/BuiltinSuites";
import { needsWorkspace, validateScorer } from "#src/services/benchmark/Scorers";
import { normaliseWorkspacePath } from "#src/services/benchmark/ScratchWorkspace";
import { instructionsOf } from "#src/services/benchmark/scorers/IfEval";
import type {
  BenchmarkSuite,
  CaseMessage,
  ScorerSpec,
  SuiteCase,
  SuiteSummary,
  SuiteToolPolicy,
} from "#src/types/benchmark";

export class SuiteError extends Error {
  status = 400;
}

/** Fields a create/update may carry. */
export interface SuiteInput {
  name?: unknown;
  description?: unknown;
  tags?: unknown;
  scorers?: unknown;
  systemPrompt?: unknown;
  tools?: unknown;
  workspace?: unknown;
  limits?: unknown;
  cases?: unknown;
}

const str = (value: unknown) => (typeof value === "string" ? value : "");

function validateTools(tools: unknown): SuiteToolPolicy {
  if (tools == null) return { mode: "none" };
  const policy = tools as SuiteToolPolicy;
  if (policy.mode === "none" || policy.mode === "agent") return { mode: policy.mode };
  if (policy.mode === "list" && Array.isArray(policy.tools) && policy.tools.every((tool) => typeof tool === "string" && tool.trim())) {
    return { mode: "list", tools: [...new Set(policy.tools.map((tool) => tool.trim()))] };
  }
  throw new SuiteError('tools must be {mode: "none"}, {mode: "agent"} or {mode: "list", tools: [...]}');
}

function validateScorers(scorers: unknown, where: string): ScorerSpec[] {
  if (scorers == null) return [];
  if (!Array.isArray(scorers)) throw new SuiteError(`${where}: scorers must be a list`);
  if (scorers.length > BENCHMARK.MAX_SCORERS_PER_CASE) throw new SuiteError(`${where}: at most ${BENCHMARK.MAX_SCORERS_PER_CASE} scorers`);
  for (const [index, scorer] of scorers.entries()) {
    const problem = validateScorer(scorer as ScorerSpec);
    if (problem) throw new SuiteError(`${where}, scorer ${index + 1}: ${problem}`);
  }
  return scorers as ScorerSpec[];
}

function validateFiles(files: unknown, where: string): Record<string, string> | null {
  if (files == null) return null;
  if (typeof files !== "object" || Array.isArray(files)) throw new SuiteError(`${where} must map paths to text`);
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length > BENCHMARK.MAX_FILES_PER_CASE) throw new SuiteError(`${where}: at most ${BENCHMARK.MAX_FILES_PER_CASE} files`);
  let bytes = 0;
  const clean: Record<string, string> = {};
  for (const [path, content] of entries) {
    const relative = normaliseWorkspacePath(path);
    if (!relative) throw new SuiteError(`${where}: "${path}" is not a relative path inside the workspace`);
    if (typeof content !== "string") throw new SuiteError(`${where}: "${path}" must be text`);
    bytes += Buffer.byteLength(content);
    clean[relative] = content;
  }
  if (bytes > BENCHMARK.MAX_FILE_BYTES_PER_CASE) throw new SuiteError(`${where}: files exceed ${BENCHMARK.MAX_FILE_BYTES_PER_CASE / 1024} KB`);
  return entries.length > 0 ? clean : null;
}

function validateInput(input: unknown, where: string): string | CaseMessage[] {
  if (typeof input === "string") {
    if (!input.trim()) throw new SuiteError(`${where}: the input is empty`);
    return input;
  }
  if (Array.isArray(input) && input.length > 0) {
    const messages = input.map((message, index) => {
      const role = (message as CaseMessage)?.role;
      const content = (message as CaseMessage)?.content;
      if ((role !== "user" && role !== "assistant") || typeof content !== "string") {
        throw new SuiteError(`${where}: message ${index + 1} needs role user|assistant and text content`);
      }
      return { role, content };
    });
    if (messages[messages.length - 1].role !== "user") throw new SuiteError(`${where}: a conversation must end on a user message`);
    return messages;
  }
  throw new SuiteError(`${where}: input must be text or a list of messages`);
}

/** Validate and normalise cases; ids made unique, `suiteScorers` the fallback grader. */
export function validateCases(raw: unknown, suiteScorers: ScorerSpec[]): SuiteCase[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new SuiteError("a suite needs at least one case");
  if (raw.length > BENCHMARK.MAX_SUITE_CASES) throw new SuiteError(`at most ${BENCHMARK.MAX_SUITE_CASES} cases per suite`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    let id = str(item.id).trim() || `case-${index + 1}`;
    if (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    const where = `case "${id}"`;
    const scorers = item.scorers == null ? null : validateScorers(item.scorers, where);
    const effective = scorers ?? suiteScorers;
    if (effective.length === 0) throw new SuiteError(`${where}: no scorer — give the case or the suite at least one`);
    const target = item.target;
    if (target != null && typeof target !== "string" && !(Array.isArray(target) && target.every((value) => typeof value === "string"))) {
      throw new SuiteError(`${where}: target must be text or a list of texts`);
    }
    const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? (item.metadata as Record<string, unknown>) : null;
    if (effective.some((scorer) => scorer.type === "ifeval") && !instructionsOf(metadata)) {
      throw new SuiteError(`${where}: an ifeval scorer needs metadata.ifeval instructions`);
    }
    const tags = Array.isArray(item.tags) ? [...new Set(item.tags.map(str).map((tag) => tag.trim()).filter(Boolean))] : [];
    const files = validateFiles(item.files, `${where} files`);
    const hiddenFiles = validateFiles(item.hiddenFiles, `${where} hiddenFiles`);
    return {
      id,
      input: validateInput(item.input, where),
      ...(str(item.systemPrompt).trim() && { systemPrompt: str(item.systemPrompt) }),
      ...(target != null && target !== "" && { target: target as string | string[] }),
      ...(scorers && { scorers }),
      ...(files && { files }),
      ...(hiddenFiles && { hiddenFiles }),
      ...(tags.length > 0 && { tags }),
      ...(metadata && { metadata }),
    };
  });
}

function validateLimits(limits: unknown): BenchmarkSuite["limits"] {
  if (limits == null) return null;
  const value = limits as Record<string, unknown>;
  const positive = (key: string, max: number) => {
    const raw = value[key];
    if (raw == null || raw === "") return undefined;
    const number = Math.floor(Number(raw));
    if (!Number.isFinite(number) || number < 1 || number > max) throw new SuiteError(`limits.${key} must be between 1 and ${max}`);
    return number;
  };
  const clean = {
    maxIterations: positive("maxIterations", 100),
    maxTokens: positive("maxTokens", 1_000_000),
    timeoutSeconds: positive("timeoutSeconds", 3600),
  };
  return Object.values(clean).some((entry) => entry !== undefined) ? clean : null;
}

/** A complete, validated suite from a create body. */
export function buildSuite(input: SuiteInput, identity: { project: string | null; username: string }): BenchmarkSuite {
  const name = str(input.name).trim();
  if (!name) throw new SuiteError("a suite needs a name");
  const scorers = validateScorers(input.scorers, "suite");
  const cases = validateCases(input.cases, scorers);
  const now = new Date().toISOString();
  const suite: BenchmarkSuite = {
    id: crypto.randomUUID(),
    project: identity.project,
    username: identity.username,
    name,
    description: str(input.description).trim() || null,
    source: { kind: "custom" },
    tags: Array.isArray(input.tags) ? [...new Set(input.tags.map(str).map((tag) => tag.trim()).filter(Boolean))] : [],
    scorers,
    systemPrompt: str(input.systemPrompt).trim() || null,
    tools: validateTools(input.tools),
    workspace: input.workspace === true,
    limits: validateLimits(input.limits),
    cases,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  // A case that writes files or checks them runs in a workspace anyway.
  if (!suite.workspace && suite.cases.some((datasetCase) => datasetCase.files || datasetCase.hiddenFiles || needsWorkspace(datasetCase.scorers ?? scorers))) {
    suite.workspace = true;
  }
  return suite;
}

/** Apply an update body to a stored suite (fields present replace; the version bumps). */
export function applySuiteUpdate(suite: BenchmarkSuite, input: SuiteInput): BenchmarkSuite {
  const scorers = input.scorers !== undefined ? validateScorers(input.scorers, "suite") : suite.scorers;
  const updated: BenchmarkSuite = {
    ...suite,
    ...(input.name !== undefined && { name: str(input.name).trim() || suite.name }),
    ...(input.description !== undefined && { description: str(input.description).trim() || null }),
    ...(input.tags !== undefined && { tags: Array.isArray(input.tags) ? input.tags.map(str).filter(Boolean) : [] }),
    ...(input.systemPrompt !== undefined && { systemPrompt: str(input.systemPrompt).trim() || null }),
    ...(input.tools !== undefined && { tools: validateTools(input.tools) }),
    ...(input.workspace !== undefined && { workspace: input.workspace === true }),
    ...(input.limits !== undefined && { limits: validateLimits(input.limits) }),
    scorers,
    cases: input.cases !== undefined ? validateCases(input.cases, scorers) : validateCases(suite.cases, scorers),
    version: suite.version + 1,
    updatedAt: new Date().toISOString(),
  };
  if (!updated.workspace && updated.cases.some((datasetCase) => datasetCase.files || datasetCase.hiddenFiles || needsWorkspace(datasetCase.scorers ?? scorers))) {
    updated.workspace = true;
  }
  return updated;
}

const Suites = {
  async get(id: string, project: string | null): Promise<BenchmarkSuite | null> {
    if (isBuiltinSuiteId(id)) return builtinSuite(id);
    return BenchmarkStore.getSuite(id, project);
  },

  async list(project: string | null): Promise<SuiteSummary[]> {
    const builtins = BUILTIN_SUITES.map((suite) => BenchmarkStore.summariseSuite(builtinSuite(suite.id)!));
    return [...builtins, ...(await BenchmarkStore.listSuites(project))];
  },

  async create(input: SuiteInput, identity: { project: string | null; username: string }): Promise<BenchmarkSuite> {
    return BenchmarkStore.insertSuite(buildSuite(input, identity));
  },

  async save(suite: BenchmarkSuite): Promise<BenchmarkSuite> {
    return BenchmarkStore.insertSuite(suite);
  },

  async update(id: string, input: SuiteInput, project: string | null): Promise<BenchmarkSuite | null> {
    if (isBuiltinSuiteId(id)) throw new SuiteError("built-in suites are read-only — duplicate it to edit");
    const suite = await BenchmarkStore.getSuite(id, project);
    if (!suite) return null;
    const updated = applySuiteUpdate(suite, input);
    await BenchmarkStore.replaceSuite(updated);
    return updated;
  },

  /** An editable copy of any suite (built-in, imported or custom). */
  async duplicate(id: string, identity: { project: string | null; username: string }, name?: string): Promise<BenchmarkSuite | null> {
    const suite = await Suites.get(id, identity.project);
    if (!suite) return null;
    const now = new Date().toISOString();
    return BenchmarkStore.insertSuite({
      ...structuredClone(suite),
      id: crypto.randomUUID(),
      project: identity.project,
      username: identity.username,
      name: name?.trim() || `${suite.name} (copy)`,
      source: { ...suite.source, kind: suite.source.kind === "import" ? "import" : "custom", ref: suite.source.ref ?? suite.id },
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  },

  async remove(id: string, project: string | null): Promise<boolean> {
    if (isBuiltinSuiteId(id)) throw new SuiteError("built-in suites cannot be deleted");
    return BenchmarkStore.deleteSuite(id, project);
  },
};

export default Suites;
