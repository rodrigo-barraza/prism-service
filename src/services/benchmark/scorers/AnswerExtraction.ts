/**
 * AnswerExtraction — reading the final answer out of free text.
 *
 * Models answer in every format, so extraction is a chain from the most to
 * the least explicit signal, the way simple-evals and lm-eval-harness do
 * it: an "Answer: …" line, a \boxed{…}, GSM8K's "#### …", and only then the
 * last candidate in the text. Normalisation makes "$1,234.50", "1234.5"
 * and "\frac{2469}{2}" comparable.
 */

/** The text after the LAST "answer:" / "final answer:" marker, up to the line's end. */
export function extractAnswerLine(text: string): string | null {
  const pattern = /(?:final\s+answer|answer)\s*(?:is)?\s*[:：]\s*(.+)/gi;
  let last: string | null = null;
  for (const match of text.matchAll(pattern)) last = match[1].trim();
  return last;
}

/** The content of the last \boxed{…} (balanced braces), or null. */
export function extractBoxed(text: string): string | null {
  const marker = /\\(?:boxed|fbox)\s*\{/g;
  let start = -1;
  for (const match of text.matchAll(marker)) start = (match.index ?? 0) + match[0].length;
  if (start < 0) return null;
  let depth = 1;
  for (let index = start; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, index).trim();
    }
  }
  return null;
}

const stripMarkdown = (text: string) => text.replace(/[*_`]/g, "").trim();

// ── Multiple choice ─────────────────────────────────────────

/**
 * The chosen option letter (A–J, upper-cased) or null. Order: an answer
 * line, a boxed letter, "(X)" / "X)" / "X." at the start of the last line,
 * a single-letter reply, the last standalone capital letter of the last line.
 */
export function extractChoice(text: string, optionCount = 10): string | null {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, Math.max(2, Math.min(26, optionCount)));
  const letterClass = `[${letters}]`;
  const clean = stripMarkdown(text);
  const answerLine = extractAnswerLine(clean);
  const fromAnswer = answerLine?.match(new RegExp(`^\\(?(${letterClass})\\b\\)?`, "i"));
  if (fromAnswer) return fromAnswer[1].toUpperCase();
  const boxed = extractBoxed(clean)?.replace(/\\text\{([^}]*)\}/g, "$1").trim();
  if (boxed && new RegExp(`^\\(?${letterClass}\\)?$`, "i").test(boxed)) {
    return boxed.replace(/[()]/g, "").toUpperCase();
  }
  const trimmed = clean.trim();
  if (new RegExp(`^\\(?${letterClass}\\)?[.)]?$`).test(trimmed)) return trimmed.replace(/[().]/g, "");
  const lines = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  const leading = lastLine.match(new RegExp(`^\\(?(${letterClass})[).:]\\s`));
  if (leading) return leading[1];
  const standalone = [...lastLine.matchAll(new RegExp(`(?:^|[^A-Za-z])\\(?(${letterClass})\\)?(?=$|[^A-Za-z])`, "g"))];
  if (standalone.length > 0) return standalone[standalone.length - 1][1];
  return null;
}

// ── Numbers ─────────────────────────────────────────────────

const NUMBER_PATTERN = /-?\$?\s?\d[\d,]*(?:\.\d+)?(?:\s?%)?|-?\.\d+/g;

/** Parse "$1,234.50", "12%", "-3", "1/4", "\frac{1}{4}", "2.5e3" → a number, or null. */
export function parseNumber(raw: string): number | null {
  let text = raw
    .replace(/\\(?:text|mathrm|textbf)\{([^}]*)\}/g, "$1")
    .replace(/\\[,!;: ]/g, "")
    .replace(/\\\$/g, "")
    .replace(/[$€£¥]/g, "")
    .replace(/\s+/g, "")
    .replace(/,(?=\d{3}(?:\D|$))/g, "")
    .replace(/\.$/, "")
    .trim();
  const percent = text.endsWith("%") || text.endsWith("\\%");
  text = text.replace(/\\?%$/, "");
  const fraction = text.match(/^(-?)\\[dt]?frac\{(-?[\d.]+)\}\{(-?[\d.]+)\}$/) ?? text.match(/^(-?)(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (fraction) {
    const value = Number(fraction[2]) / Number(fraction[3]);
    if (!Number.isFinite(value)) return null;
    return (fraction[1] === "-" ? -value : value) * (percent ? 0.01 : 1);
  }
  if (!/^-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return percent ? value / 100 : value;
}

/**
 * The final numeric answer: an answer line, a \boxed{}, GSM8K's "#### x",
 * else the last number in the text.
 */
export function extractNumber(text: string): { raw: string; value: number } | null {
  const candidates = [extractAnswerLine(text), extractBoxed(text), text.match(/####\s*([^\n]+)/)?.[1] ?? null];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const whole = parseNumber(candidate);
    if (whole !== null) return { raw: candidate.trim(), value: whole };
    const inside = [...candidate.matchAll(NUMBER_PATTERN)];
    if (inside.length > 0) {
      const raw = inside[inside.length - 1][0];
      const value = parseNumber(raw);
      if (value !== null) return { raw: raw.trim(), value };
    }
  }
  const all = [...stripMarkdown(text).matchAll(NUMBER_PATTERN)];
  for (let index = all.length - 1; index >= 0; index--) {
    const value = parseNumber(all[index][0]);
    if (value !== null) return { raw: all[index][0].trim(), value };
  }
  return null;
}

/** |a − b| within `tolerance`, relative to |b| (absolute near zero). */
export function numbersMatch(actual: number, expected: number, tolerance = 1e-6): boolean {
  const scale = Math.max(1, Math.abs(expected));
  return Math.abs(actual - expected) <= tolerance * scale;
}

// ── Math expressions ────────────────────────────────────────

/**
 * Normalise a LaTeX answer the way the MATH benchmark's graders do (Hendrycks
 * et al. 2021; lm-eval-harness `is_equiv`): drop sizing, spacing, units and
 * "\text{}", unify fraction commands, strip a leading "x =" and outer $…$.
 */
export function normaliseMath(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^\$+|\$+$/g, "");
  text = text.replace(/\\left|\\right|\\!|\\,|\\;|\\:|\\ /g, "");
  text = text.replace(/\\(?:dfrac|tfrac)/g, "\\frac");
  text = text.replace(/\^\s*\{?\\circ\}?|°/g, "");
  text = text.replace(/\\(?:text|mbox|mathrm)\{\s*(?:units?|cm|m|km|inches|inch|feet|ft|degrees?|dollars?|cents?|hours?|minutes?|seconds?|days?|meters?)\s*\}/gi, "");
  text = text.replace(/\\(?:text|mbox|mathrm|textbf)\{([^}]*)\}/g, "$1");
  text = text.replace(/\\\$|\\%|%/g, "");
  text = text.replace(/^[a-zA-Z]\s*=\s*/, "");
  text = text.replace(/\s+/g, "");
  text = text.replace(/\.$/, "");
  // \frac12 → \frac{1}{2}; \sqrt2 → \sqrt{2}
  text = text.replace(/\\frac(\d)(\d)/g, "\\frac{$1}{$2}");
  text = text.replace(/\\frac\{([^{}]+)\}(\d)/g, "\\frac{$1}{$2}");
  text = text.replace(/\\sqrt(\d+)/g, "\\sqrt{$1}");
  // 0.5 → .5 style differences, and a trailing ".0"
  text = text.replace(/(\d)\.0+(?!\d)/g, "$1");
  text = text.replace(/^0\./, ".");
  // a/b as plain slash for simple numbers → \frac{a}{b}
  const slash = text.match(/^(-?\d+)\/(\d+)$/);
  if (slash) text = `\\frac{${slash[1]}}{${slash[2]}}`;
  return text;
}

/** Whether two math answers are the same after normalisation, or numerically equal. */
export function mathEquivalent(actual: string, expected: string): boolean {
  const left = normaliseMath(actual);
  const right = normaliseMath(expected);
  if (left === right) return true;
  const leftNumber = parseNumber(left.replace(/^\./, "0."));
  const rightNumber = parseNumber(right.replace(/^\./, "0."));
  if (leftNumber !== null && rightNumber !== null) return numbersMatch(leftNumber, rightNumber, 1e-6);
  // Unordered sets / tuples of simple items: "1,2" vs "2,1" only when both are sets.
  if (/^\{.*\}$/.test(left) && /^\{.*\}$/.test(right)) {
    const items = (value: string) => value.slice(1, -1).split(",").sort().join(",");
    return items(left) === items(right);
  }
  return false;
}

/** The final math answer: \boxed{} first, then an answer line, then the last $…$. */
export function extractMathAnswer(text: string): string | null {
  const boxed = extractBoxed(text);
  if (boxed) return boxed;
  const line = extractAnswerLine(text);
  if (line) return line.replace(/\.$/, "");
  const dollars = [...text.matchAll(/\$([^$]+)\$/g)];
  if (dollars.length > 0) return dollars[dollars.length - 1][1];
  return null;
}

// ── Text normalisation ──────────────────────────────────────

/** Lower-case, strip punctuation, articles and extra space (SQuAD-style normalisation). */
export function normaliseText(text: string, { ignoreCase = true } = {}): string {
  let value = text.normalize("NFKC");
  if (ignoreCase) value = value.toLowerCase();
  value = value.replace(/[\p{P}\p{S}]/gu, " ");
  if (ignoreCase) value = value.replace(/\b(a|an|the)\b/g, " ");
  return value.replace(/\s+/g, " ").trim();
}
