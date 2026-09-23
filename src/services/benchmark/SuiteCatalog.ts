/**
 * SuiteCatalog — public benchmarks, imported as suites.
 *
 * Each entry maps a Hugging Face dataset's rows to suite cases with the
 * grading the benchmark's authors use: GSM8K's final number, MATH's boxed
 * answer, MMLU-Pro's option letter, IFEval's verifiable instructions,
 * HumanEval/MBPP's unit tests, SimpleQA's judged CORRECT/INCORRECT/
 * NOT_ATTEMPTED. Rows are read through the datasets-server rows API
 * (datasets-server.huggingface.co) and SAMPLED with a seed, so a quick
 * 100-case import is reproducible and a second import with the same seed
 * is the same cases. Gated datasets (GPQA) need HUGGINGFACE_TOKEN after
 * accepting the dataset's terms; their items must not be republished.
 */
import crypto from "crypto";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";
import { shuffled, seededRandom } from "#src/services/benchmark/Statistics";
import type { BenchmarkSuite, CatalogEntry, ScorerSpec, SuiteCase, SuiteToolPolicy } from "#src/types/benchmark";

const ROWS_API = "https://datasets-server.huggingface.co/rows";
const PAGE = 100;
/** Pages fetched at once — the datasets server answers 429 to larger bursts. */
const FETCH_CONCURRENCY = 3;
const LETTERS = "ABCDEFGHIJ";

type Row = Record<string, unknown>;

interface Importer {
  entry: CatalogEntry;
  dataset: string;
  config: string;
  split: string;
  /** Row → case; null skips the row. `random` is seeded per row (option shuffles). */
  toCase(row: Row, index: number, random: () => number): SuiteCase | null;
  scorers: ScorerSpec[];
  systemPrompt: string | null;
  tools?: SuiteToolPolicy;
  workspace?: boolean;
  tags: string[];
}

const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));

function lettered(options: string[]): string {
  return options.map((option, index) => `${LETTERS[index]}) ${option}`).join("\n");
}

const CHOICE_PROMPT =
  "Answer the multiple-choice question. Reason briefly if you need to, then finish with a final line of the form \"Answer: X\", where X is the letter of the correct option.";
const NUMBER_PROMPT =
  "Solve the problem. Reason step by step, then finish with a final line of the form \"Answer: <number>\" containing only the number.";
const BOXED_PROMPT = "Solve the problem. Reason step by step, and put your final answer in \\boxed{}.";
const CODE_PROMPT_SUFFIX = "Reply with the complete solution in a single ```python code block.";

const IMPORTERS: Importer[] = [
  {
    entry: {
      id: "gsm8k",
      name: "GSM8K",
      description: "Grade-school math word problems; graded on the final number. Saturated for frontier models — a smoke test, not a separator.",
      category: "Math",
      url: "https://huggingface.co/datasets/openai/gsm8k",
      license: "MIT",
      totalRows: 1319,
      suggestedSample: 100,
      scorer: "numeric",
    },
    dataset: "openai/gsm8k",
    config: "main",
    split: "test",
    toCase: (row, index) => {
      const answer = text(row.answer).split("####").pop()?.trim().replace(/,/g, "") ?? "";
      if (!answer) return null;
      return { id: `gsm8k-${index}`, input: text(row.question), target: answer, tags: ["math"] };
    },
    scorers: [{ type: "numeric" }],
    systemPrompt: NUMBER_PROMPT,
    tags: ["math", "reasoning"],
  },
  {
    entry: {
      id: "math500",
      name: "MATH-500",
      description: "Competition math (the MATH benchmark's 500-problem subset) across seven subjects and five levels; boxed answers checked for equivalence, a judge settles forms the normaliser misses.",
      category: "Math",
      url: "https://huggingface.co/datasets/HuggingFaceH4/MATH-500",
      license: "MIT (MATH)",
      totalRows: 500,
      suggestedSample: 150,
      scorer: "math",
      judged: true,
    },
    dataset: "HuggingFaceH4/MATH-500",
    config: "default",
    split: "test",
    toCase: (row, index) => ({
      id: text(row.unique_id) || `math500-${index}`,
      input: text(row.problem),
      target: text(row.answer),
      tags: [text(row.subject), `level ${text(row.level)}`].filter((tag) => tag.trim() && tag !== "level "),
    }),
    scorers: [{ type: "math", judgeFallback: true }],
    systemPrompt: BOXED_PROMPT,
    tags: ["math", "reasoning"],
  },
  ...(["aime_2025", "aime_2026"] as const).map(
    (name): Importer => ({
      entry: {
        id: name.replace("_", ""),
        name: name === "aime_2025" ? "AIME 2025" : "AIME 2026",
        description: `The ${name === "aime_2025" ? "2025" : "2026"} American Invitational Mathematics Examination (I and II): 30 problems with integer answers 0–999. Few cases — run 4+ epochs.`,
        category: "Math",
        url: `https://huggingface.co/datasets/MathArena/${name}`,
        license: "CC BY-NC-SA 4.0",
        totalRows: 30,
        suggestedSample: 30,
        scorer: "numeric",
      },
      dataset: `MathArena/${name}`,
      config: "default",
      split: "train",
      toCase: (row, index) => ({
        id: `${name}-${text(row.problem_idx) || index + 1}`,
        input: text(row.problem),
        target: text(row.answer),
        tags: Array.isArray(row.problem_type) ? row.problem_type.map(text) : [],
      }),
      scorers: [{ type: "numeric", tolerance: 0 }],
      systemPrompt: "Solve the problem. The answer is an integer between 0 and 999. Reason step by step and put the final answer in \\boxed{}.",
      tags: ["math", "competition"],
    }),
  ),
  {
    entry: {
      id: "hmmt_feb_2025",
      name: "HMMT February 2025",
      description: "Harvard–MIT Math Tournament, February 2025: 30 hard problems with exact answers.",
      category: "Math",
      url: "https://huggingface.co/datasets/MathArena/hmmt_feb_2025",
      license: "CC BY-NC-SA 4.0",
      totalRows: 30,
      suggestedSample: 30,
      scorer: "math",
      judged: true,
    },
    dataset: "MathArena/hmmt_feb_2025",
    config: "default",
    split: "train",
    toCase: (row, index) => ({
      id: `hmmt-feb-2025-${text(row.problem_idx) || index + 1}`,
      input: text(row.problem),
      target: text(row.answer),
      tags: Array.isArray(row.problem_type) ? row.problem_type.map(text) : [],
    }),
    scorers: [{ type: "math", judgeFallback: true }],
    systemPrompt: BOXED_PROMPT,
    tags: ["math", "competition"],
  },
  {
    entry: {
      id: "mmlu_pro",
      name: "MMLU-Pro",
      description: "Graduate-level knowledge and reasoning in 14 subjects, ten options per question.",
      category: "Knowledge",
      url: "https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro",
      license: "MIT",
      totalRows: 12032,
      suggestedSample: 280,
      scorer: "choice",
    },
    dataset: "TIGER-Lab/MMLU-Pro",
    config: "default",
    split: "test",
    toCase: (row, index) => {
      const options = Array.isArray(row.options) ? row.options.map(text) : [];
      if (options.length === 0) return null;
      return {
        id: `mmlu-pro-${text(row.question_id) || index}`,
        input: `${text(row.question)}\n\n${lettered(options)}`,
        target: text(row.answer),
        tags: [text(row.category)].filter(Boolean),
        metadata: { choices: options },
      };
    },
    scorers: [{ type: "choice" }],
    systemPrompt: CHOICE_PROMPT,
    tags: ["knowledge", "reasoning"],
  },
  {
    entry: {
      id: "arc_challenge",
      name: "ARC-Challenge",
      description: "Grade-school science questions that retrieval and co-occurrence methods fail.",
      category: "Knowledge",
      url: "https://huggingface.co/datasets/allenai/ai2_arc",
      license: "CC BY-SA 4.0",
      totalRows: 1172,
      suggestedSample: 100,
      scorer: "choice",
    },
    dataset: "allenai/ai2_arc",
    config: "ARC-Challenge",
    split: "test",
    toCase: (row, index) => {
      const choices = row.choices as { text?: unknown[]; label?: unknown[] } | undefined;
      const options = (choices?.text ?? []).map(text);
      const labels = (choices?.label ?? []).map(text);
      const answer = labels.indexOf(text(row.answerKey));
      if (options.length === 0 || answer < 0) return null;
      return {
        id: text(row.id) || `arc-${index}`,
        input: `${text(row.question)}\n\n${lettered(options)}`,
        target: LETTERS[answer],
        tags: ["science"],
        metadata: { choices: options },
      };
    },
    scorers: [{ type: "choice" }],
    systemPrompt: CHOICE_PROMPT,
    tags: ["knowledge", "science"],
  },
  {
    entry: {
      id: "gpqa_diamond",
      name: "GPQA Diamond",
      description: "PhD-level biology, chemistry and physics questions that experts answer and skilled non-experts with web access do not. Options are shuffled per case with the import seed.",
      category: "Knowledge",
      url: "https://huggingface.co/datasets/Idavidrein/gpqa",
      license: "CC BY 4.0 — gated; do not republish items",
      totalRows: 198,
      suggestedSample: 198,
      scorer: "choice",
      gated: true,
    },
    dataset: "Idavidrein/gpqa",
    config: "gpqa_diamond",
    split: "train",
    toCase: (row, index, random) => {
      const correct = text(row["Correct Answer"]).trim();
      const wrong = ["Incorrect Answer 1", "Incorrect Answer 2", "Incorrect Answer 3"].map((key) => text(row[key]).trim());
      if (!correct || wrong.some((option) => !option)) return null;
      const options = [correct, ...wrong];
      for (let position = options.length - 1; position > 0; position--) {
        const swap = Math.floor(random() * (position + 1));
        [options[position], options[swap]] = [options[swap], options[position]];
      }
      return {
        id: text(row["Record ID"]) || `gpqa-${index}`,
        input: `${text(row.Question).trim()}\n\n${lettered(options)}`,
        target: LETTERS[options.indexOf(correct)],
        tags: [text(row["High-level domain"])].filter(Boolean),
        metadata: { choices: options },
      };
    },
    scorers: [{ type: "choice" }],
    systemPrompt: CHOICE_PROMPT,
    tags: ["knowledge", "science", "expert"],
  },
  {
    entry: {
      id: "ifeval",
      name: "IFEval",
      description: "541 prompts with verifiable formatting instructions (word counts, JSON, case, sections…), checked by code — no judge.",
      category: "Instruction following",
      url: "https://huggingface.co/datasets/google/IFEval",
      license: "Apache-2.0",
      totalRows: 541,
      suggestedSample: 150,
      scorer: "ifeval",
    },
    dataset: "google/IFEval",
    config: "default",
    split: "train",
    toCase: (row, index) => {
      const ids = Array.isArray(row.instruction_id_list) ? row.instruction_id_list.map(text) : [];
      const kwargs = Array.isArray(row.kwargs) ? row.kwargs : [];
      if (ids.length === 0) return null;
      return {
        id: `ifeval-${text(row.key) || index}`,
        input: text(row.prompt),
        tags: [...new Set(ids.map((id) => id.split(":")[0]))],
        metadata: { ifeval: ids.map((id, position) => ({ id, kwargs: (kwargs[position] as Record<string, unknown>) ?? {} })) },
      };
    },
    scorers: [{ type: "ifeval", mode: "strict" }],
    systemPrompt: null,
    tags: ["instruction-following"],
  },
  {
    entry: {
      id: "simpleqa_verified",
      name: "SimpleQA Verified",
      description: "Short fact-seeking questions with one indisputable answer (Google's cleaned 1,000-question SimpleQA); a judge grades CORRECT / INCORRECT / NOT ATTEMPTED — abstaining beats guessing wrong.",
      category: "Factuality",
      url: "https://huggingface.co/datasets/google/simpleqa-verified",
      license: "MIT",
      totalRows: 1000,
      suggestedSample: 200,
      scorer: "reference",
      judged: true,
    },
    dataset: "google/simpleqa-verified",
    config: "simpleqa_verified",
    split: "eval",
    toCase: (row, index) => ({
      id: `simpleqa-${text(row.original_index) || index}`,
      input: text(row.problem),
      target: text(row.answer),
      tags: [text(row.topic)].filter(Boolean),
    }),
    scorers: [{ type: "reference" }],
    systemPrompt: null,
    tags: ["factuality", "knowledge"],
  },
  {
    entry: {
      id: "humaneval",
      name: "HumanEval",
      description: "164 Python functions from docstrings, graded by running their unit tests in a scratch workspace.",
      category: "Coding",
      url: "https://huggingface.co/datasets/openai/openai_humaneval",
      license: "MIT",
      totalRows: 164,
      suggestedSample: 164,
      scorer: "code_tests",
    },
    dataset: "openai/openai_humaneval",
    config: "openai_humaneval",
    split: "test",
    toCase: (row, index) => {
      const prompt = text(row.prompt);
      const imports = prompt
        .split("\n")
        .filter((line) => /^(from\s+\S+\s+import|import)\s/.test(line))
        .join("\n");
      return {
        id: text(row.task_id).replace("/", "-") || `humaneval-${index}`,
        input: `Complete this Python function.\n\n\`\`\`python\n${prompt}\`\`\`\n\n${CODE_PROMPT_SUFFIX} Include the imports and the full function, signature included.`,
        tags: ["python"],
        metadata: {
          codePreamble: imports,
          testProgram: `${text(row.test)}\n\ncheck(${text(row.entry_point)})\n`,
        },
      };
    },
    scorers: [{ type: "code_tests", language: "python" }],
    systemPrompt: null,
    tags: ["coding", "python"],
  },
  {
    entry: {
      id: "mbpp",
      name: "MBPP (sanitized)",
      description: "257 hand-verified basic Python programming problems, graded by their assert tests.",
      category: "Coding",
      url: "https://huggingface.co/datasets/google-research-datasets/mbpp",
      license: "CC BY 4.0",
      totalRows: 257,
      suggestedSample: 150,
      scorer: "code_tests",
    },
    dataset: "google-research-datasets/mbpp",
    config: "sanitized",
    split: "test",
    toCase: (row, index) => {
      const tests = Array.isArray(row.test_list) ? row.test_list.map(text) : [];
      if (tests.length === 0) return null;
      const imports = Array.isArray(row.test_imports) ? row.test_imports.map(text) : [];
      return {
        id: `mbpp-${text(row.task_id) || index}`,
        input: `${text(row.prompt)}\nYour code should pass these tests:\n${tests.join("\n")}\n\n${CODE_PROMPT_SUFFIX}`,
        tags: ["python"],
        metadata: { testProgram: `${imports.join("\n")}\n${tests.join("\n")}\n` },
      };
    },
    scorers: [{ type: "code_tests", language: "python" }],
    systemPrompt: null,
    tags: ["coding", "python"],
  },
];

export function listCatalog(): CatalogEntry[] {
  return IMPORTERS.map((importer) => ({
    ...importer.entry,
    ...(importer.entry.gated && { gated: true, available: !!huggingFaceToken() }),
  }));
}

const huggingFaceToken = () => process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN || null;

async function fetchPage(importer: Importer, offset: number, length: number): Promise<{ rows: Row[]; total: number }> {
  const url = `${ROWS_API}?${new URLSearchParams({
    dataset: importer.dataset,
    config: importer.config,
    split: importer.split,
    offset: String(offset),
    length: String(length),
  })}`;
  const token = huggingFaceToken();
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    let waitMs = 750 * 2 ** (attempt - 1);
    try {
      const response = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        rows?: Array<{ row_idx: number; row: Row }>;
        num_rows_total?: number;
        error?: string;
      };
      if (!response.ok || body.error) {
        const message = body.error || `HTTP ${response.status}`;
        if (/gated|authentication|private/i.test(message)) {
          throw Object.assign(new Error(`${importer.entry.name} is gated: set HUGGINGFACE_TOKEN after accepting its terms on Hugging Face`), { permanent: true });
        }
        // The datasets server rate-limits bursts: honour Retry-After (capped).
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        if (response.status === 429) waitMs = Math.min(30_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : waitMs * 2);
        throw new Error(message);
      }
      return { rows: (body.rows ?? []).map((entry) => ({ ...entry.row, __index: entry.row_idx })), total: body.num_rows_total ?? 0 };
    } catch (error: unknown) {
      if ((error as { permanent?: boolean }).permanent) throw error;
      lastError = error;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  throw new Error(`Could not read ${importer.dataset}: ${getErrorMessage(lastError)}`);
}

export interface ImportRequest {
  catalogId: string;
  /** Cases to take (default: the entry's suggested sample). */
  limit?: number | null;
  seed?: number | null;
  name?: string | null;
}

/** Read a catalog entry's rows, sample them, and build the suite (not stored). */
export async function importCatalogSuite(
  request: ImportRequest,
  identity: { project: string | null; username: string },
): Promise<BenchmarkSuite> {
  const importer = IMPORTERS.find((candidate) => candidate.entry.id === request.catalogId);
  if (!importer) throw Object.assign(new Error(`Unknown catalog entry "${request.catalogId}"`), { status: 400 });
  const seed = Number.isFinite(request.seed) ? Math.floor(request.seed as number) : 1;
  const first = await fetchPage(importer, 0, PAGE);
  const total = first.total || first.rows.length;
  const wanted = Math.max(1, Math.min(total, Math.floor(request.limit ?? importer.entry.suggestedSample)));
  // A seeded sample of row indices, then only the pages holding them.
  const indices = new Set(shuffled(Array.from({ length: total }, (_, index) => index), seed).slice(0, wanted));
  const pages = new Map<number, Row[]>([[0, first.rows]]);
  const neededPages = [...new Set([...indices].map((index) => Math.floor(index / PAGE) * PAGE))].filter((offset) => !pages.has(offset));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, neededPages.length) }, async () => {
      while (cursor < neededPages.length) {
        const offset = neededPages[cursor++];
        pages.set(offset, (await fetchPage(importer, offset, PAGE)).rows);
      }
    }),
  );
  const cases: SuiteCase[] = [];
  const seenIds = new Set<string>();
  for (const index of [...indices].sort((first, second) => first - second)) {
    const row = pages.get(Math.floor(index / PAGE) * PAGE)?.find((candidate) => candidate.__index === index);
    if (!row) continue;
    const datasetCase = importer.toCase(row, index, seededRandom(seed * 100_003 + index));
    if (!datasetCase) continue;
    let id = datasetCase.id;
    while (seenIds.has(id)) id = `${datasetCase.id}-${crypto.randomUUID().slice(0, 4)}`;
    seenIds.add(id);
    cases.push({ ...datasetCase, id });
  }
  if (cases.length === 0) throw new Error(`${importer.entry.name}: no usable rows`);
  logger.info(`[benchmark] Imported ${cases.length}/${total} rows of ${importer.dataset} (seed ${seed})`);
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    project: identity.project,
    username: identity.username,
    name: request.name?.trim() || `${importer.entry.name} · ${cases.length}${cases.length < total ? ` of ${total}` : ""}`,
    description: importer.entry.description,
    source: {
      kind: "import",
      ref: importer.entry.id,
      url: importer.entry.url,
      license: importer.entry.license,
      totalRows: total,
      sampledRows: cases.length,
      seed,
      split: `${importer.config}/${importer.split}`,
    },
    tags: importer.tags,
    scorers: importer.scorers,
    systemPrompt: importer.systemPrompt,
    tools: importer.tools ?? { mode: "none" },
    workspace: importer.workspace ?? false,
    limits: null,
    cases,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}
