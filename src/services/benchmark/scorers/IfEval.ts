/**
 * IfEval — verifiable instruction following (Zhou et al. 2023, "Instruction-
 * Following Evaluation for Large Language Models", arXiv 2311.07911).
 *
 * A port of the 25 checkers of google-research/instruction_following_eval
 * (instructions.py), same rules and thresholds. Two places are
 * approximations of Python libraries the original leans on: sentence
 * counting (its regex splitter) and language identification (langdetect —
 * here a script + stop-word detector, LanguageDetect.ts). Strict mode checks
 * the reply as written; loose mode also accepts it with the first and/or
 * last line removed and with asterisks stripped (evaluation_lib's
 * `test_instruction_following_loose`).
 */
import { detectLanguage } from "#src/services/benchmark/scorers/LanguageDetect";

export interface IfEvalInstruction {
  id: string;
  kwargs?: Record<string, unknown> | null;
}

export interface IfEvalResult {
  id: string;
  followed: boolean;
  /** Unknown instruction id or malformed kwargs. */
  error?: string;
}

type Checker = (response: string, kwargs: Record<string, unknown>) => boolean;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const number = (value: unknown) => (typeof value === "number" ? value : Number(value));
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compare(actual: number, relation: unknown, expected: number): boolean {
  return text(relation) === "less than" ? actual < expected : actual >= expected;
}

/** Python's str.isupper(): at least one cased character and none lower-case. */
const isUpper = (value: string) => value !== value.toLowerCase() && value === value.toUpperCase();
const isLower = (value: string) => value !== value.toUpperCase() && value === value.toLowerCase();

/** nltk RegexpTokenizer(r"\w+") word count. */
export const countWords = (value: string) => (value.match(/[\p{L}\p{N}_]+/gu) ?? []).length;

const ABBREVIATIONS =
  /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|Inc|Ltd|Co|Corp|Mt|No|Fig|approx|U\.S|a\.m|p\.m)\.$/i;

/** Sentences, splitting on . ! ? followed by space and not after an abbreviation or inside a number. */
export function countSentences(value: string): number {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return 0;
  const sentences: string[] = [];
  let current = "";
  for (let index = 0; index < cleaned.length; index++) {
    const character = cleaned[index];
    current += character;
    if (!/[.!?]/.test(character)) continue;
    // Keep runs like "?!" or "..." together.
    while (index + 1 < cleaned.length && /[.!?"')\]]/.test(cleaned[index + 1])) current += cleaned[++index];
    const next = cleaned[index + 1];
    if (next !== undefined && next !== " ") continue;
    if (character === "." && ABBREVIATIONS.test(current.trimEnd())) continue;
    if (character === "." && /\d\.$/.test(current) && /\d/.test(cleaned[index + 2] ?? "")) continue;
    sentences.push(current.trim());
    current = "";
  }
  if (current.trim()) sentences.push(current.trim());
  return sentences.filter(Boolean).length;
}

/** nltk.word_tokenize, approximately: words, and punctuation split off. */
const wordTokens = (value: string) =>
  value.split(/\s+/).flatMap((token) => token.split(/(?<=[\p{L}\p{N}])(?=[^\p{L}\p{N}'-])|(?<=[^\p{L}\p{N}'-])(?=[\p{L}\p{N}])/u)).filter(Boolean);

const CHECKERS: Record<string, Checker> = {
  "keywords:existence": (response, kwargs) => {
    const keywords = Array.isArray(kwargs.keywords) ? kwargs.keywords.map(text) : [];
    return keywords.every((keyword) => new RegExp(escapeRegex(keyword), "i").test(response));
  },
  "keywords:frequency": (response, kwargs) => {
    const keyword = text(kwargs.keyword);
    const occurrences = (response.match(new RegExp(escapeRegex(keyword), "gi")) ?? []).length;
    return compare(occurrences, kwargs.relation, number(kwargs.frequency));
  },
  "keywords:forbidden_words": (response, kwargs) => {
    const words = Array.isArray(kwargs.forbidden_words) ? kwargs.forbidden_words.map(text) : [];
    return words.every((word) => !new RegExp(`\\b${escapeRegex(word)}\\b`, "i").test(response));
  },
  "keywords:letter_frequency": (response, kwargs) => {
    const letter = text(kwargs.letter).toLowerCase();
    const count = [...response.toLowerCase()].filter((character) => character === letter).length;
    return compare(count, kwargs.let_relation, number(kwargs.let_frequency));
  },
  "language:response_language": (response, kwargs) => {
    const detected = detectLanguage(response);
    // langdetect's LangDetectException counts as followed in the original.
    return detected === null || detected === text(kwargs.language);
  },
  "length_constraints:number_sentences": (response, kwargs) =>
    compare(countSentences(response), kwargs.relation, number(kwargs.num_sentences)),
  "length_constraints:number_paragraphs": (response, kwargs) => {
    const paragraphs = response.split(/\s?\*\*\*\s?/);
    let count = paragraphs.length;
    for (let index = 0; index < paragraphs.length; index++) {
      if (paragraphs[index].trim()) continue;
      if (index === 0 || index === paragraphs.length - 1) count--;
      else return false;
    }
    return count === number(kwargs.num_paragraphs);
  },
  "length_constraints:number_words": (response, kwargs) =>
    compare(countWords(response), kwargs.relation, number(kwargs.num_words)),
  "length_constraints:nth_paragraph_first_word": (response, kwargs) => {
    const paragraphs = response.split(/\n\n/);
    let count = paragraphs.length;
    for (const paragraph of paragraphs) if (!paragraph.trim()) count--;
    const nth = number(kwargs.nth_paragraph);
    if (!(nth <= count)) return false;
    const paragraph = (paragraphs[nth - 1] ?? "").trim();
    if (!paragraph) return false;
    const word = (paragraph.split(/\s+/)[0] ?? "").trim().replace(/^['"]+/, "");
    let firstWord = "";
    for (const letter of word) {
      if (".,?!'\"".includes(letter)) break;
      firstWord += letter.toLowerCase();
    }
    return count === number(kwargs.num_paragraphs) && firstWord === text(kwargs.first_word).toLowerCase();
  },
  "detectable_content:number_placeholders": (response, kwargs) =>
    (response.match(/\[.*?\]/g) ?? []).length >= number(kwargs.num_placeholders),
  "detectable_content:postscript": (response, kwargs) => {
    const marker = text(kwargs.postscript_marker);
    const lower = response.toLowerCase();
    const pattern =
      marker === "P.P.S"
        ? /\s*p\.\s?p\.\s?s.*$/m
        : marker === "P.S."
          ? /\s*p\.\s?s\..*$/m
          : new RegExp(`\\s*${escapeRegex(marker.toLowerCase())}.*$`, "m");
    return pattern.test(lower);
  },
  "detectable_format:number_bullet_lists": (response, kwargs) => {
    const stars = (response.match(/^\s*\*[^*].*$/gm) ?? []).length;
    const dashes = (response.match(/^\s*-.*$/gm) ?? []).length;
    return stars + dashes === number(kwargs.num_bullets);
  },
  "detectable_format:constrained_response": (response) => {
    const value = response.trim();
    return ["My answer is yes.", "My answer is no.", "My answer is maybe."].some((option) => value.includes(option));
  },
  "detectable_format:number_highlighted_sections": (response, kwargs) => {
    let highlights = 0;
    for (const highlight of response.match(/\*[^\n*]*\*/g) ?? []) {
      if (highlight.replace(/^\*+|\*+$/g, "").trim()) highlights++;
    }
    for (const highlight of response.match(/\*\*[^\n*]*\*\*/g) ?? []) {
      if (highlight.slice(2, -2).trim()) highlights++;
    }
    return highlights >= number(kwargs.num_highlights);
  },
  "detectable_format:multiple_sections": (response, kwargs) => {
    const splitter = text(kwargs.section_spliter);
    const sections = response.split(new RegExp(`\\s?${escapeRegex(splitter)}\\s?\\d+\\s?`));
    return sections.length - 1 >= number(kwargs.num_sections);
  },
  "detectable_format:json_format": (response) => {
    const value = response
      .trim()
      .replace(/^```(?:json|Json|JSON)?/, "")
      .replace(/```$/, "")
      .trim();
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  },
  "detectable_format:title": (response) =>
    (response.match(/<<[^\n]+>>/g) ?? []).some((title) => title.replace(/^<+|>+$/g, "").trim().length > 0),
  "combination:two_responses": (response) => {
    const parts = response.split("******");
    const valid: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      if (!parts[index].trim()) {
        if (index !== 0 && index !== parts.length - 1) return false;
      } else valid.push(parts[index]);
    }
    return valid.length === 2 && valid[0].trim() !== valid[1].trim();
  },
  "combination:repeat_prompt": (response, kwargs) =>
    response.trim().toLowerCase().startsWith(text(kwargs.prompt_to_repeat).trim().toLowerCase()),
  "startend:end_checker": (response, kwargs) =>
    response.trim().replace(/^"+|"+$/g, "").toLowerCase().endsWith(text(kwargs.end_phrase).trim().toLowerCase()),
  "startend:quotation": (response) => {
    const value = response.trim();
    return value.length > 1 && value[0] === '"' && value[value.length - 1] === '"';
  },
  "change_case:capital_word_frequency": (response, kwargs) => {
    const capitals = wordTokens(response).filter(isUpper).length;
    return compare(capitals, kwargs.capital_relation, number(kwargs.capital_frequency));
  },
  "change_case:english_capital": (response) => {
    const language = detectLanguage(response);
    return isUpper(response) && (language === null || language === "en");
  },
  "change_case:english_lowercase": (response) => {
    const language = detectLanguage(response);
    return isLower(response) && (language === null || language === "en");
  },
  "punctuation:no_comma": (response) => !response.includes(","),
};

export const IFEVAL_INSTRUCTION_IDS = Object.keys(CHECKERS);

/** The reply variants loose mode accepts (first/last line removed, asterisks stripped). */
function looseVariants(response: string): string[] {
  const lines = response.split("\n");
  const removeFirst = lines.slice(1).join("\n").trim();
  const removeLast = lines.slice(0, -1).join("\n").trim();
  const removeBoth = lines.slice(1, -1).join("\n").trim();
  return [
    response,
    response.replace(/\*/g, ""),
    removeFirst,
    removeLast,
    removeBoth,
    removeFirst.replace(/\*/g, ""),
    removeLast.replace(/\*/g, ""),
    removeBoth.replace(/\*/g, ""),
  ];
}

/** Drop null/empty kwargs, as the original builder does (`{k: v for k, v in kwargs.items() if v}`). */
function presentKwargs(kwargs: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const present: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(kwargs ?? {})) {
    if (value !== null && value !== undefined && value !== "") present[key] = value;
  }
  return present;
}

/** Check every instruction against the reply. */
export function evaluateIfEval(
  response: string,
  instructions: IfEvalInstruction[],
  mode: "strict" | "loose" = "strict",
): IfEvalResult[] {
  const variants = mode === "loose" ? looseVariants(response) : [response];
  return instructions.map(({ id, kwargs }) => {
    const checker = CHECKERS[id];
    if (!checker) return { id, followed: false, error: `unknown instruction "${id}"` };
    const present = presentKwargs(kwargs);
    try {
      const followed = variants.some((variant) => variant.trim().length > 0 && checker(variant, present));
      return { id, followed };
    } catch (error) {
      return { id, followed: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** The instructions a case carries (`metadata.ifeval`), or null when it has none. */
export function instructionsOf(metadata: Record<string, unknown> | null | undefined): IfEvalInstruction[] | null {
  const raw = metadata?.ifeval;
  if (!Array.isArray(raw)) return null;
  const instructions = raw
    .filter((entry): entry is { id: string; kwargs?: Record<string, unknown> } =>
      !!entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string",
    )
    .map((entry) => ({ id: entry.id, kwargs: entry.kwargs ?? {} }));
  return instructions.length > 0 ? instructions : null;
}
