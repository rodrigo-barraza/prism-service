/**
 * RepetitionDetector — real-time streaming repetition detector for
 * degenerate token loops in LLM output.
 *
 * Uses sliding window n-gram frequency analysis to detect when a model
 * has entered a degenerate repetition loop (e.g., repeating "I'll try
 * to call get_task_output for the IDs" endlessly).
 *
 * The detector operates on word-level n-grams (not character-level) to
 * avoid false positives on code and JSON output. Two n-gram sizes are
 * analyzed simultaneously:
 *   - 4-grams: catch tight loops (short repeated phrases)
 *   - 6-grams: catch broader repetitive blocks
 *
 * Additionally, a unique n-gram ratio is computed as a secondary signal.
 * When the ratio of unique n-grams to total n-grams drops below a
 * threshold, the output is flagged as degenerate even if no single
 * n-gram exceeds the frequency threshold.
 *
 * The detector is stateful (accumulates text across streaming chunks)
 * and should be instantiated per-stream (one per consumeStream call).
 */

export interface RepetitionVerdict {
  isDegenerate: boolean;
  confidence: number;
  pattern?: string;
  metric: string;
}

interface RepetitionDetectorOptions {
  /** Maximum character buffer size for the sliding window. Default: 2000. */
  windowSize?: number;
  /** Frequency threshold for 4-grams before flagging. Default: 4. */
  shortNgramFrequencyThreshold?: number;
  /** Frequency threshold for 6-grams before flagging. Default: 3. */
  longNgramFrequencyThreshold?: number;
  /** Unique n-gram ratio below which the output is flagged. Default: 0.3. */
  uniqueRatioThreshold?: number;
  /** Minimum buffer characters before detection activates. Default: 400. */
  minimumBufferSizeForDetection?: number;
}

const DEFAULT_WINDOW_SIZE = 2000;
const DEFAULT_SHORT_NGRAM_FREQUENCY_THRESHOLD = 12;
const DEFAULT_LONG_NGRAM_FREQUENCY_THRESHOLD = 8;
const DEFAULT_UNIQUE_RATIO_THRESHOLD = 0.15;
const DEFAULT_MINIMUM_BUFFER_SIZE = 500;

const SHORT_NGRAM_SIZE = 4;
const LONG_NGRAM_SIZE = 6;

/**
 * Tokenize text into normalized words for n-gram extraction.
 * Strips punctuation, lowercases, and splits on whitespace.
 * Collapses runs of whitespace and filters empty tokens.
 */
function tokenizeIntoWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * Extract n-grams of the given size from a word array.
 * Returns the n-grams as joined strings for map keying.
 */
function extractNgrams(words: string[], ngramSize: number): string[] {
  if (words.length < ngramSize) return [];

  const ngrams: string[] = [];
  const upperBound = words.length - ngramSize + 1;
  for (let index = 0; index < upperBound; index++) {
    ngrams.push(words.slice(index, index + ngramSize).join(" "));
  }
  return ngrams;
}

/**
 * Build a frequency map from an array of n-gram strings.
 */
function buildFrequencyMap(ngrams: string[]): Map<string, number> {
  const frequencyMap = new Map<string, number>();
  for (const ngram of ngrams) {
    frequencyMap.set(ngram, (frequencyMap.get(ngram) || 0) + 1);
  }
  return frequencyMap;
}

/**
 * Find the most frequent n-gram and its count.
 */
function findMostFrequent(
  frequencyMap: Map<string, number>,
): { ngram: string; count: number } | null {
  let maxNgram: string | null = null;
  let maxCount = 0;

  for (const [ngram, count] of frequencyMap) {
    if (count > maxCount) {
      maxCount = count;
      maxNgram = ngram;
    }
  }

  return maxNgram !== null ? { ngram: maxNgram, count: maxCount } : null;
}

export default class RepetitionDetector {
  private buffer: string;
  private readonly windowSize: number;
  private readonly shortNgramFrequencyThreshold: number;
  private readonly longNgramFrequencyThreshold: number;
  private readonly uniqueRatioThreshold: number;
  private readonly minimumBufferSizeForDetection: number;

  constructor(options?: RepetitionDetectorOptions) {
    this.buffer = "";
    this.windowSize = options?.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.shortNgramFrequencyThreshold =
      options?.shortNgramFrequencyThreshold ??
      DEFAULT_SHORT_NGRAM_FREQUENCY_THRESHOLD;
    this.longNgramFrequencyThreshold =
      options?.longNgramFrequencyThreshold ??
      DEFAULT_LONG_NGRAM_FREQUENCY_THRESHOLD;
    this.uniqueRatioThreshold =
      options?.uniqueRatioThreshold ?? DEFAULT_UNIQUE_RATIO_THRESHOLD;
    this.minimumBufferSizeForDetection =
      options?.minimumBufferSizeForDetection ?? DEFAULT_MINIMUM_BUFFER_SIZE;
  }

  /**
   * Append a chunk of text to the detector buffer and check for
   * degenerate repetition. Returns a verdict after each append.
   *
   * This is designed to be called on every streaming chunk — it is
   * cheap when the buffer is below the activation threshold and
   * performs analysis only when enough text has accumulated.
   */
  append(text: string): RepetitionVerdict {
    if (!text) {
      return { isDegenerate: false, confidence: 0, metric: "none" };
    }

    this.buffer += text;

    // Trim buffer to sliding window size (keep the trailing portion)
    if (this.buffer.length > this.windowSize) {
      this.buffer = this.buffer.slice(this.buffer.length - this.windowSize);
    }

    // Don't analyze until we have enough content to avoid false positives
    if (this.buffer.length < this.minimumBufferSizeForDetection) {
      return { isDegenerate: false, confidence: 0, metric: "buffer_too_small" };
    }

    return this.analyze();
  }

  /** Reset the detector state for a new stream. */
  reset(): void {
    this.buffer = "";
  }

  /** Get the current buffer length (for diagnostics). */
  get bufferLength(): number {
    return this.buffer.length;
  }

  /**
   * Run the full analysis pipeline on the current buffer.
   * Checks 4-gram frequency, 6-gram frequency, and unique ratio.
   */
  private analyze(): RepetitionVerdict {
    const words = tokenizeIntoWords(this.buffer);

    // Need enough words to form at least a few n-grams
    if (words.length < LONG_NGRAM_SIZE + 2) {
      return {
        isDegenerate: false,
        confidence: 0,
        metric: "insufficient_words",
      };
    }

    // ── Check 1: Short n-gram (4-gram) frequency ────────────
    const shortNgramVerdict = this.checkNgramFrequency(
      words,
      SHORT_NGRAM_SIZE,
      this.shortNgramFrequencyThreshold,
    );
    if (shortNgramVerdict.isDegenerate) {
      return shortNgramVerdict;
    }

    // ── Check 2: Long n-gram (6-gram) frequency ─────────────
    const longNgramVerdict = this.checkNgramFrequency(
      words,
      LONG_NGRAM_SIZE,
      this.longNgramFrequencyThreshold,
    );
    if (longNgramVerdict.isDegenerate) {
      return longNgramVerdict;
    }

    // ── Check 3: Unique n-gram ratio (global diversity) ─────
    const uniqueRatioVerdict = this.checkUniqueRatio(words);
    if (uniqueRatioVerdict.isDegenerate) {
      return uniqueRatioVerdict;
    }

    return { isDegenerate: false, confidence: 0, metric: "clean" };
  }

  /**
   * Check if any single n-gram of the given size exceeds the
   * frequency threshold. Returns the most frequent offender.
   */
  private checkNgramFrequency(
    words: string[],
    ngramSize: number,
    frequencyThreshold: number,
  ): RepetitionVerdict {
    const ngrams = extractNgrams(words, ngramSize);
    if (ngrams.length === 0) {
      return { isDegenerate: false, confidence: 0, metric: "no_ngrams" };
    }

    const frequencyMap = buildFrequencyMap(ngrams);
    const mostFrequent = findMostFrequent(frequencyMap);

    if (mostFrequent && mostFrequent.count >= frequencyThreshold) {
      // Confidence scales from 0.5 (at threshold) to 1.0 (at 2× threshold)
      const confidence = Math.min(
        1.0,
        0.5 + (mostFrequent.count - frequencyThreshold) / (frequencyThreshold * 2),
      );

      return {
        isDegenerate: true,
        confidence,
        pattern: mostFrequent.ngram,
        metric: `ngram_frequency_${ngramSize}`,
      };
    }

    return { isDegenerate: false, confidence: 0, metric: "ngram_frequency" };
  }

  /**
   * Check the unique n-gram ratio — the ratio of distinct n-grams
   * to total n-grams. A low ratio indicates high repetition even
   * when no single n-gram dominates.
   */
  private checkUniqueRatio(words: string[]): RepetitionVerdict {
    const ngrams = extractNgrams(words, SHORT_NGRAM_SIZE);
    if (ngrams.length < 10) {
      return {
        isDegenerate: false,
        confidence: 0,
        metric: "insufficient_ngrams_for_ratio",
      };
    }

    const uniqueNgrams = new Set(ngrams);
    const uniqueRatio = uniqueNgrams.size / ngrams.length;

    if (uniqueRatio < this.uniqueRatioThreshold) {
      // Confidence inversely proportional to uniqueRatio
      // At ratio=0.0 → confidence=1.0, at ratio=threshold → confidence=0.5
      const confidence = Math.min(
        1.0,
        0.5 + (this.uniqueRatioThreshold - uniqueRatio) / (this.uniqueRatioThreshold * 2),
      );

      // Find the most common pattern for logging
      const frequencyMap = buildFrequencyMap(ngrams);
      const mostFrequent = findMostFrequent(frequencyMap);

      return {
        isDegenerate: true,
        confidence,
        pattern: mostFrequent?.ngram,
        metric: "unique_ratio",
      };
    }

    return { isDegenerate: false, confidence: 0, metric: "unique_ratio" };
  }
}
