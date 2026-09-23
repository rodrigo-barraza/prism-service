/**
 * ArenaService — people voting blind, and the standings.
 *
 * Two ways to cast a human vote, both blind (the contestants' names come
 * back only after the vote):
 *   - over a run's answers: the next pair is two contestants' answers to
 *     the same case and epoch, drawn from the pair of contestants with the
 *     fewest votes so far (so votes spread where the ratings are least
 *     certain), sides randomised;
 *   - live: a prompt of your own, two contestants answering it side by side
 *     in real time (the same executor as a run), then the vote.
 * Judge battles (RunEngine's pairwise phase) and human battles are kept
 * apart: standings are computed from one source or the other, never mixed
 * unless asked.
 */
import crypto from "crypto";
import BenchmarkStore from "#src/services/benchmark/BenchmarkStore";
import { battleStyle, buildArenaReport } from "#src/services/benchmark/Arena";
import { caseTask } from "#src/services/benchmark/Cases";
import { executeSample, resolveTools, type StreamedEvent } from "#src/services/benchmark/BenchmarkExecutor";
import { toContestant, validateContestant } from "#src/services/benchmark/Contestants";
import { BENCHMARK } from "#src/constants";
import type { ArenaReport, Battle, BattleWinner, BenchmarkRun, BenchmarkSample, Contestant, ContestantSpec } from "#src/types/benchmark";

const OUTPUT_LIMIT = 20_000;
const LIVE_TOKEN_TTL_MS = 60 * 60 * 1000;
const WINNERS: ReadonlySet<string> = new Set(["a", "b", "tie", "both_bad"]);

export class ArenaError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const truncate = (text: string | null | undefined) =>
  text && text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n…[truncated]` : (text ?? "");

export const isWinner = (value: unknown): value is BattleWinner => typeof value === "string" && WINNERS.has(value);

// ── Blind votes over a run ──────────────────────────────────

export interface BlindPair {
  runId: string;
  suiteId: string;
  caseId: string;
  epoch: number;
  prompt: string;
  systemPrompt: string | null;
  a: { sampleId: string; output: string };
  b: { sampleId: string; output: string };
  /** Pairs of answers in the run not voted on yet. */
  remaining: number;
}

const pairKey = (first: string, second: string) => [first, second].sort().join("|");

/** The next pair to vote on in a run, or null when every pair has a vote. */
export async function nextBlindPair(run: BenchmarkRun): Promise<BlindPair | null> {
  const samples = (await BenchmarkStore.listSamples(run.id, { filter: { status: "done" } })).filter((sample) => sample.output?.text);
  const votes = await BenchmarkStore.listBattles({ runId: run.id, source: "human" });
  const votedPairs = new Set(votes.map((battle) => pairKey(battle.a.sampleId ?? "", battle.b.sampleId ?? "")));
  const votesPerContestants = new Map<string, number>();
  for (const battle of votes) {
    const key = pairKey(battle.a.contestantKey, battle.b.contestantKey);
    votesPerContestants.set(key, (votesPerContestants.get(key) ?? 0) + 1);
  }
  const cells = new Map<string, BenchmarkSample[]>();
  for (const sample of samples) {
    const cell = `${sample.suiteId}\u0000${sample.caseId}\u0000${sample.epoch}`;
    if (!cells.has(cell)) cells.set(cell, []);
    cells.get(cell)!.push(sample);
  }
  const candidates: Array<{ first: BenchmarkSample; second: BenchmarkSample; contestants: string }> = [];
  for (const group of cells.values()) {
    for (let first = 0; first < group.length; first++) {
      for (let second = first + 1; second < group.length; second++) {
        if (group[first].contestantKey === group[second].contestantKey) continue;
        if (votedPairs.has(pairKey(group[first].id, group[second].id))) continue;
        candidates.push({
          first: group[first],
          second: group[second],
          contestants: pairKey(group[first].contestantKey, group[second].contestantKey),
        });
      }
    }
  }
  if (candidates.length === 0) return null;
  const fewest = Math.min(...candidates.map((candidate) => votesPerContestants.get(candidate.contestants) ?? 0));
  const pool = candidates.filter((candidate) => (votesPerContestants.get(candidate.contestants) ?? 0) === fewest);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const [left, right] = Math.random() < 0.5 ? [pick.first, pick.second] : [pick.second, pick.first];
  const suite = run.suites.find((candidate) => candidate.id === left.suiteId);
  const datasetCase = suite?.cases.find((candidate) => candidate.id === left.caseId);
  return {
    runId: run.id,
    suiteId: left.suiteId,
    caseId: left.caseId,
    epoch: left.epoch,
    prompt: datasetCase ? caseTask(datasetCase) : "",
    systemPrompt: datasetCase?.systemPrompt ?? suite?.systemPrompt ?? null,
    a: { sampleId: left.id, output: truncate(left.output?.text) },
    b: { sampleId: right.id, output: truncate(right.output?.text) },
    remaining: candidates.length,
  };
}

/** Record a blind vote on two of a run's answers; returns the battle with the names revealed. */
export async function recordBlindVote(
  run: BenchmarkRun,
  { aSampleId, bSampleId, winner }: { aSampleId: string; bSampleId: string; winner: unknown },
  username: string,
): Promise<Battle> {
  if (!isWinner(winner)) throw new ArenaError('winner must be "a", "b", "tie" or "both_bad"');
  const [first, second] = await Promise.all([BenchmarkStore.getSample(run.id, aSampleId), BenchmarkStore.getSample(run.id, bSampleId)]);
  if (!first || !second) throw new ArenaError("sample not found", 404);
  if (first.suiteId !== second.suiteId || first.caseId !== second.caseId) throw new ArenaError("the two answers are to different cases");
  if (first.contestantKey === second.contestantKey) throw new ArenaError("the two answers are from the same contestant");
  const label = (key: string) => run.contestants.find((contestant) => contestant.key === key)?.label ?? key;
  const suite = run.suites.find((candidate) => candidate.id === first.suiteId);
  const datasetCase = suite?.cases.find((candidate) => candidate.id === first.caseId);
  const battle: Battle = {
    id: crypto.randomUUID(),
    project: run.project,
    username,
    source: "human",
    runId: run.id,
    suiteId: first.suiteId,
    caseId: first.caseId,
    epoch: first.epoch,
    prompt: datasetCase ? caseTask(datasetCase).slice(0, 4000) : "",
    a: { contestantKey: first.contestantKey, label: label(first.contestantKey), sampleId: first.id, output: truncate(first.output?.text) },
    b: { contestantKey: second.contestantKey, label: label(second.contestantKey), sampleId: second.id, output: truncate(second.output?.text) },
    winner,
    judge: null,
    style: battleStyle(first.output?.text ?? "", second.output?.text ?? ""),
    category: datasetCase?.tags?.[0] ?? null,
    createdAt: new Date().toISOString(),
  };
  await BenchmarkStore.insertBattle(battle);
  return battle;
}

// ── Live battles ────────────────────────────────────────────

interface PendingLiveBattle {
  project: string | null;
  prompt: string;
  contestants: [Contestant, Contestant];
  outputs: [string, string];
  expiresAt: number;
}

const pendingLive = new Map<string, PendingLiveBattle>();

function sweepExpired() {
  const now = Date.now();
  for (const [token, pending] of pendingLive) if (pending.expiresAt < now) pendingLive.delete(token);
}

export type LiveBattleEvent =
  | { type: "side"; side: "a" | "b"; kind: "text" | "thinking"; content: string }
  | { type: "side_tool"; side: "a" | "b"; name: string; status: string }
  | { type: "side_done"; side: "a" | "b"; latencyMs: number; cost: number | null; error: string | null }
  | { type: "ready"; token: string };

/**
 * Two contestants answer one prompt side by side. Events stream as they
 * come (tagged "a"/"b", no names); `ready` carries the token the vote cites.
 * The contestants are shuffled onto the sides.
 */
export async function runLiveBattle(
  {
    prompt,
    systemPrompt,
    contestants: specs,
    project,
    username,
    signal,
  }: {
    prompt: string;
    systemPrompt?: string | null;
    contestants: ContestantSpec[];
    project: string | null;
    username: string;
    signal?: AbortSignal;
  },
  send: (event: LiveBattleEvent) => void,
): Promise<string> {
  if (typeof prompt !== "string" || !prompt.trim()) throw new ArenaError("a live battle needs a prompt");
  if (!Array.isArray(specs) || specs.length !== 2) throw new ArenaError("a live battle needs exactly two contestants");
  for (const spec of specs) {
    const problem = validateContestant(spec);
    if (problem) throw new ArenaError(problem);
  }
  const contestants = specs.map(toContestant);
  if (contestants[0].key === contestants[1].key) throw new ArenaError("the two contestants are the same configuration");
  const sides = (Math.random() < 0.5 ? [contestants[0], contestants[1]] : [contestants[1], contestants[0]]) as [Contestant, Contestant];
  const outputs: [string, string] = ["", ""];
  await Promise.all(
    sides.map(async (contestant, index) => {
      const side = index === 0 ? "a" : "b";
      const execution = await executeSample({
        contestant,
        systemPrompt: systemPrompt ?? null,
        messages: [{ role: "user", content: prompt }],
        tools: resolveTools(contestant, { mode: "none" }),
        project,
        username,
        signal,
        timeoutMs: (contestant.kind === "agent" ? BENCHMARK.DEFAULT_AGENT_TIMEOUT_SECONDS : BENCHMARK.DEFAULT_MODEL_TIMEOUT_SECONDS) * 1000,
        onEvent: (event: StreamedEvent) => {
          if ((event.type === "chunk" || event.type === "thinking") && event.content) {
            send({ type: "side", side, kind: event.type === "chunk" ? "text" : "thinking", content: event.content });
          } else if (event.type === "tool_execution" && event.tool?.name) {
            send({ type: "side_tool", side, name: event.tool.name, status: event.status ?? "" });
          }
        },
      });
      outputs[index] = execution.output.text;
      send({ type: "side_done", side, latencyMs: execution.latencyMs, cost: execution.cost, error: execution.error?.message ?? null });
    }),
  );
  sweepExpired();
  const token = crypto.randomUUID();
  pendingLive.set(token, { project, prompt, contestants: sides, outputs, expiresAt: Date.now() + LIVE_TOKEN_TTL_MS });
  send({ type: "ready", token });
  return token;
}

/** Record the vote on a live battle; returns the battle with the names revealed. */
export async function recordLiveVote(token: string, winner: unknown, identity: { project: string | null; username: string }): Promise<Battle> {
  if (!isWinner(winner)) throw new ArenaError('winner must be "a", "b", "tie" or "both_bad"');
  const pending = pendingLive.get(token);
  if (!pending || pending.project !== identity.project) throw new ArenaError("this battle expired or was already voted on", 404);
  pendingLive.delete(token);
  const [first, second] = pending.contestants;
  const battle: Battle = {
    id: crypto.randomUUID(),
    project: identity.project,
    username: identity.username,
    source: "human",
    runId: null,
    prompt: pending.prompt.slice(0, 4000),
    a: { contestantKey: first.key, label: first.label, output: truncate(pending.outputs[0]) },
    b: { contestantKey: second.key, label: second.label, output: truncate(pending.outputs[1]) },
    winner,
    judge: null,
    style: battleStyle(pending.outputs[0], pending.outputs[1]),
    category: "live",
    createdAt: new Date().toISOString(),
  };
  await BenchmarkStore.insertBattle(battle);
  return battle;
}

// ── Standings ───────────────────────────────────────────────

export async function arenaStandings(
  project: string | null,
  { source = "human", runId, suiteId, styleControl = false }: { source?: "human" | "judge" | "all"; runId?: string | null; suiteId?: string | null; styleControl?: boolean },
): Promise<ArenaReport & { source: string }> {
  const query: Record<string, unknown> = { project };
  if (source !== "all") query.source = source;
  if (runId) query.runId = runId;
  if (suiteId) query.suiteId = suiteId;
  const battles = await BenchmarkStore.listBattles(query);
  return { ...buildArenaReport(battles, { styleControl }), source };
}
