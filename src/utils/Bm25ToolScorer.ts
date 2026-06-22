// ─── BM25 Tool Search Scorer ────────────────────────────────
//
// Implements the Okapi BM25 ranking function for tool discovery.
// Indexes tool name, description, and parameter names to surface
// relevant tools even when the query targets argument signatures
// (e.g. "latitude longitude" matching a geocoding tool).
//
// Falls back to literal substring matching on the tool name when
// BM25 returns zero positive-score hits — protects against the
// zero-IDF degenerate case where every document contains the
// query term (e.g. searching "github" against a catalog where
// every tool name starts with "mcp_github_").

// ─── BM25 Tuning Constants ─────────────────────────────────
// k1: term frequency saturation — higher values reward repeated terms more
const BM25_TERM_FREQUENCY_SATURATION = 1.5;
// b: document length normalization — 0 disables, 1 fully normalizes
const BM25_LENGTH_NORMALIZATION = 0.75;

// Exact name match gets a large additive bonus on top of BM25
const EXACT_NAME_MATCH_BONUS = 50;
// Substring match on tool name (query is a substring of the name)
const PARTIAL_NAME_MATCH_BONUS = 20;

export interface ScoredDocument<T> {
  document: T;
  score: number;
}

/**
 * Tokenize a string into lowercase alphabetic terms.
 * Splits on underscores, spaces, hyphens, and camelCase boundaries.
 * Filters out single-character tokens and common stop words.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "or", "and", "not", "no", "it", "its", "this", "that",
]);

export function tokenize(text: string): string[] {
  const withCamelSplits = text.replace(/([a-z])([A-Z])/g, "$1 $2");
  const rawTokens = withCamelSplits
    .toLowerCase()
    .split(/[\s_\-./,;:()[\]{}'"]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
  return rawTokens;
}

/**
 * Extract all searchable text from a tool schema.
 * Concatenates: tool name + description + parameter names + parameter descriptions.
 */
export function extractSearchableText(toolSchema: {
  name?: string;
  description?: string;
  parameters?: { properties?: Record<string, { description?: string }> };
}): string {
  const segments: string[] = [];

  if (toolSchema.name) {
    segments.push(toolSchema.name);
  }

  if (toolSchema.description) {
    segments.push(toolSchema.description);
  }

  const properties = toolSchema.parameters?.properties;
  if (properties) {
    for (const [parameterName, parameterDefinition] of Object.entries(properties)) {
      segments.push(parameterName);
      if (parameterDefinition?.description) {
        segments.push(parameterDefinition.description);
      }
    }
  }

  return segments.join(" ");
}

/**
 * Pre-built BM25 index over a corpus of tool schemas.
 *
 * Builds the document frequency table and average document length once,
 * then scores queries against it cheaply. Rebuild when the tool catalog
 * changes (stateless per-turn, like Hermes).
 */
export class Bm25ToolIndex<T extends { name?: string; description?: string; parameters?: unknown }> {
  private readonly documentTokens: Map<T, string[]> = new Map();
  private readonly documentFrequency: Map<string, number> = new Map();
  private readonly totalDocuments: number;
  private readonly averageDocumentLength: number;
  private readonly toolNamesByDocument: Map<T, string> = new Map();

  constructor(documents: T[]) {
    this.totalDocuments = documents.length;

    let totalTokenCount = 0;

    for (const document of documents) {
      const searchableText = extractSearchableText(
        document as unknown as Parameters<typeof extractSearchableText>[0],
      );
      const tokens = tokenize(searchableText);
      this.documentTokens.set(document, tokens);
      this.toolNamesByDocument.set(document, (document.name || "").toLowerCase());
      totalTokenCount += tokens.length;

      const uniqueTermsInDocument = new Set(tokens);
      for (const term of uniqueTermsInDocument) {
        this.documentFrequency.set(
          term,
          (this.documentFrequency.get(term) || 0) + 1,
        );
      }
    }

    this.averageDocumentLength =
      this.totalDocuments > 0 ? totalTokenCount / this.totalDocuments : 1;
  }

  /**
   * Score a single document against query terms using BM25.
   */
  private computeBm25(documentTokens: string[], queryTerms: string[]): number {
    let score = 0;
    const documentLength = documentTokens.length;

    for (const queryTerm of queryTerms) {
      const termFrequency = documentTokens.filter(
        (token) => token === queryTerm,
      ).length;
      if (termFrequency === 0) continue;

      const documentsContainingTerm = this.documentFrequency.get(queryTerm) || 0;

      // IDF: rarer terms across the corpus score higher
      const inverseDocumentFrequency = Math.log(
        (this.totalDocuments - documentsContainingTerm + 0.5) /
          (documentsContainingTerm + 0.5) +
          1,
      );

      // TF with saturation + length normalization
      const normalizedTermFrequency =
        (termFrequency * (BM25_TERM_FREQUENCY_SATURATION + 1)) /
        (termFrequency +
          BM25_TERM_FREQUENCY_SATURATION *
            (1 -
              BM25_LENGTH_NORMALIZATION +
              BM25_LENGTH_NORMALIZATION *
                (documentLength / this.averageDocumentLength)));

      score += inverseDocumentFrequency * normalizedTermFrequency;
    }

    return score;
  }

  /**
   * Search the index for documents matching the query.
   *
   * Returns scored results sorted by relevance (highest first).
   * Uses BM25 as primary ranking, with additive bonuses for exact
   * and partial name matches. Falls back to literal substring
   * matching on tool names when BM25 returns zero hits.
   */
  search(query: string, limit: number = 20): ScoredDocument<T>[] {
    const queryLowercase = query.toLowerCase().trim();
    if (!queryLowercase) {
      return [...this.documentTokens.keys()].map((document) => ({
        document,
        score: 1,
      }));
    }

    const queryTerms = tokenize(query);
    const scoredResults: ScoredDocument<T>[] = [];

    for (const [document, documentTokens] of this.documentTokens) {
      const toolNameLowercase = this.toolNamesByDocument.get(document) || "";

      let score = this.computeBm25(documentTokens, queryTerms);

      // Additive bonuses for name relevance
      if (toolNameLowercase === queryLowercase) {
        score += EXACT_NAME_MATCH_BONUS;
      } else if (toolNameLowercase.includes(queryLowercase)) {
        score += PARTIAL_NAME_MATCH_BONUS;
      }

      if (score > 0) {
        scoredResults.push({ document, score });
      }
    }

    // Fallback: if BM25 found nothing, try literal substring on tool name.
    // Protects against zero-IDF degenerate cases (e.g. every tool contains "github").
    if (scoredResults.length === 0) {
      for (const [document] of this.documentTokens) {
        const toolNameLowercase = this.toolNamesByDocument.get(document) || "";
        if (toolNameLowercase.includes(queryLowercase)) {
          scoredResults.push({ document, score: 1 });
        }
      }
    }

    scoredResults.sort(
      (firstResult, secondResult) => secondResult.score - firstResult.score,
    );
    return scoredResults.slice(0, limit);
  }
}
