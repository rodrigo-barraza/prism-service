import {
  Bm25ToolIndex,
  tokenize,
} from "@rodrigo-barraza/utilities-library/search";
import { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
import { MEMORY } from "#src/constants";

// ────────────────────────────────────────────────────────────
// HybridRetrieval — multi-signal memory scoring with RRF fusion
// ────────────────────────────────────────────────────────────
// Cosine-only retrieval finds "vibes" but misses exact things —
// a project name, an ID, a config value. This module scores the
// already-fetched candidate set through four channels and fuses
// them with reciprocal-rank fusion (RRF):
//
//   1. semantic  — cosine similarity over embeddings (existing signal)
//   2. bm25      — keyword relevance (reuses the in-house Bm25ToolIndex)
//   3. exact     — whole-query substring + rare-token verbatim hits
//   4. recency   — newest-first, weakly weighted (tiebreak, not driver)
//
// A candidate is kept when ANY strong channel fires (semantic above
// the relevance threshold, a BM25 hit, or an exact hit) — so an exact
// ID match with low cosine similarity is no longer lost.
//
// Research basis (harness_landscape_survey_2026-07.md, B2):
//  - Mem0, "State of AI Agent Memory 2026" — parallel semantic + BM25 +
//    entity matching fused into one score (LoCoMo 92.5):
//    https://mem0.ai/blog/state-of-ai-agent-memory-2026
//  - Graphiti (Zep) — RRF/MMR hybrid retrieval recipes over memory graphs:
//    https://github.com/getzep/graphiti
// ────────────────────────────────────────────────────────────

export interface HybridCandidate {
  /** Stable key back into the caller's candidate array. */
  key: number;
  title: string;
  content: string;
  embedding: number[] | null;
  createdAt: string | null;
}

export interface HybridScore {
  key: number;
  /** Cosine similarity (0 when the candidate has no embedding). */
  semantic: number;
  bm25Hit: boolean;
  exactHit: boolean;
  /** Fused RRF score — use for ordering only, not as a similarity. */
  fused: number;
}

export interface HybridOptions {
  /** Semantic gate — candidates below this need a bm25/exact hit to survive. */
  relevanceThreshold: number;
  limit: number;
}

const RRF_K = MEMORY.HYBRID_RRF_K;
const WEIGHTS = {
  semantic: MEMORY.HYBRID_WEIGHT_SEMANTIC,
  bm25: MEMORY.HYBRID_WEIGHT_BM25,
  exact: MEMORY.HYBRID_WEIGHT_EXACT,
  recency: MEMORY.HYBRID_WEIGHT_RECENCY,
};

/** RRF contribution of a 0-based rank within a channel. */
function rankContribution(rank: number, weight: number): number {
  return weight / (RRF_K + rank + 1);
}

/**
 * Exact-match channel: whole-query substring beats per-token hits;
 * per-token hits require rare-ish tokens (length ≥ 4) verbatim in the text.
 */
function exactMatchScore(query: string, candidate: HybridCandidate): number {
  const haystackTitle = candidate.title.toLowerCase();
  const haystackContent = candidate.content.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  if (haystackTitle.includes(needle)) return 2;
  if (haystackContent.includes(needle)) return 1;

  const queryTokens = tokenize(query).filter(
    (token) => token.length >= MEMORY.HYBRID_EXACT_MIN_TOKEN_LENGTH,
  );
  if (queryTokens.length === 0) return 0;
  const matched = queryTokens.filter(
    (token) =>
      haystackTitle.includes(token) || haystackContent.includes(token),
  ).length;
  // Require a majority of significant tokens to count as an entity hit
  return matched / queryTokens.length >= 0.5
    ? (0.5 * matched) / queryTokens.length
    : 0;
}

/**
 * Score candidates through all four channels and fuse with RRF.
 * Pure — no I/O; exported for direct unit testing.
 */
export function scoreHybrid(
  candidates: HybridCandidate[],
  queryText: string,
  queryEmbedding: number[] | null,
  options: HybridOptions,
): HybridScore[] {
  if (candidates.length === 0) return [];

  // ── Channel 1: semantic (cosine) ─────────────────────────
  const semanticScores = new Map<number, number>();
  for (const candidate of candidates) {
    const score =
      queryEmbedding && candidate.embedding && candidate.embedding.length > 0
        ? cosineSimilarity(queryEmbedding, candidate.embedding)
        : 0;
    semanticScores.set(candidate.key, score);
  }
  const semanticRanked = candidates
    .filter((candidate) => (semanticScores.get(candidate.key) ?? 0) > 0)
    .sort((first, second) => {
      const delta =
        (semanticScores.get(second.key) ?? 0) -
        (semanticScores.get(first.key) ?? 0);
      if (delta !== 0) return delta;
      // Equal similarity → newer first (recency tiebreak inside the channel,
      // where it can actually change the rank)
      return (second.createdAt || "").localeCompare(first.createdAt || "");
    });

  // ── Channel 2: BM25 keyword relevance ────────────────────
  // Bm25ToolIndex flattens name + description into one token bag;
  // shaping memories as {name: title, description: content} reuses it
  // as-is, and its exact/partial name bonus doubles as a title boost.
  const bm25Index = new Bm25ToolIndex(
    candidates.map((candidate) => ({
      name: candidate.title,
      description: candidate.content,
      __key: candidate.key,
    })),
  );
  const bm25Results = bm25Index.search(queryText, candidates.length);
  const bm25Ranks = new Map<number, number>();
  bm25Results.forEach((result, rank) => {
    const key = (result.document as { __key: number }).__key;
    if (result.score > 0) bm25Ranks.set(key, rank);
  });
  // Gate-bypassing keyword hits must be STRONG: a single shared common
  // word (e.g. "fix") must not resurrect a semantically unrelated doc.
  // Require at least 2 distinct query tokens present (or all of them for
  // one-token queries); weak matches still contribute to RRF ordering.
  const queryTokenSet = new Set(tokenize(queryText));
  const strongTokenBar = Math.min(2, Math.max(1, queryTokenSet.size));
  const strongBm25Keys = new Set<number>();
  for (const candidate of candidates) {
    if (!bm25Ranks.has(candidate.key)) continue;
    const documentTokens = new Set(
      tokenize(`${candidate.title} ${candidate.content}`),
    );
    let matchedTokens = 0;
    for (const token of queryTokenSet) {
      if (documentTokens.has(token)) matchedTokens++;
    }
    if (matchedTokens >= strongTokenBar) strongBm25Keys.add(candidate.key);
  }

  // ── Channel 3: exact / entity hits ───────────────────────
  const exactScores = new Map<number, number>();
  for (const candidate of candidates) {
    const score = exactMatchScore(queryText, candidate);
    if (score > 0) exactScores.set(candidate.key, score);
  }
  const exactRanked = [...exactScores.entries()].sort(
    (first, second) => second[1] - first[1],
  );

  // ── Channel 4: recency (weak tiebreak) ───────────────────
  const recencyRanked = [...candidates].sort((first, second) =>
    (second.createdAt || "").localeCompare(first.createdAt || ""),
  );

  // ── Fuse with RRF ────────────────────────────────────────
  const fused = new Map<number, number>();
  const addContribution = (key: number, rank: number, weight: number) => {
    fused.set(key, (fused.get(key) ?? 0) + rankContribution(rank, weight));
  };
  semanticRanked.forEach((candidate, rank) =>
    addContribution(candidate.key, rank, WEIGHTS.semantic),
  );
  bm25Ranks.forEach((rank, key) => addContribution(key, rank, WEIGHTS.bm25));
  exactRanked.forEach(([key], rank) =>
    addContribution(key, rank, WEIGHTS.exact),
  );
  recencyRanked.forEach((candidate, rank) =>
    addContribution(candidate.key, rank, WEIGHTS.recency),
  );

  // ── Gate + order ─────────────────────────────────────────
  return candidates
    .map((candidate) => ({
      key: candidate.key,
      semantic: semanticScores.get(candidate.key) ?? 0,
      bm25Hit: strongBm25Keys.has(candidate.key),
      exactHit: exactScores.has(candidate.key),
      fused: fused.get(candidate.key) ?? 0,
    }))
    .filter(
      (scored) =>
        scored.semantic > options.relevanceThreshold ||
        scored.bm25Hit ||
        scored.exactHit,
    )
    .sort((first, second) => second.fused - first.fused)
    .slice(0, options.limit);
}
