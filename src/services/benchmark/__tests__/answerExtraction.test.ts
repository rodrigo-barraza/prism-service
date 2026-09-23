import { describe, it, expect } from "vitest";
import {
  extractBoxed,
  extractChoice,
  extractMathAnswer,
  extractNumber,
  mathEquivalent,
  normaliseText,
  numbersMatch,
  parseNumber,
} from "#src/services/benchmark/scorers/AnswerExtraction";
import { countSentences, evaluateIfEval } from "#src/services/benchmark/scorers/IfEval";
import { detectLanguage } from "#src/services/benchmark/scorers/LanguageDetect";

describe("multiple choice", () => {
  it.each([
    ["The answer is clearly B because…\n\nAnswer: B", "B"],
    ["**Answer:** (C)", "C"],
    ["D", "D"],
    ["(A)", "A"],
    ["Let me think.\nOption A is wrong, option C is right.\nC) Iron rusting", "C"],
    ["\\boxed{E}", "E"],
    ["Final answer: J", "J"],
  ])("reads %j as %s", (text, expected) => {
    expect(extractChoice(text)).toBe(expected);
  });

  it("returns null when nothing looks like a choice", () => {
    expect(extractChoice("I am not sure about this one.", 4)).toBeNull();
  });

  it("limits the letters to the option count", () => {
    expect(extractChoice("Answer: E", 4)).toBeNull();
  });
});

describe("numbers", () => {
  it.each([
    ["$1,234.50", 1234.5],
    ["12%", 0.12],
    ["-3", -3],
    ["\\frac{1}{4}", 0.25],
    ["3/4", 0.75],
    ["2.5e3", 2500],
    ["18.", 18],
  ])("parses %s", (raw, value) => {
    expect(parseNumber(raw)).toBeCloseTo(value, 10);
  });

  it("prefers explicit markers over the last number", () => {
    expect(extractNumber("She sells 9 eggs at $2 each.\n#### 18")?.value).toBe(18);
    expect(extractNumber("Total: 5 + 7 = 12. Answer: 12 apples")?.value).toBe(12);
    expect(extractNumber("so the result is \\boxed{1,024}")?.value).toBe(1024);
    expect(extractNumber("There were 3 cats and 4 dogs, so 7 animals.")?.value).toBe(7);
    expect(extractNumber("no digits here")).toBeNull();
  });

  it("compares with a relative tolerance", () => {
    expect(numbersMatch(0.3333333, 1 / 3, 1e-6)).toBe(true);
    expect(numbersMatch(18, 18.5)).toBe(false);
  });
});

describe("math answers", () => {
  it("extracts nested boxed content", () => {
    expect(extractBoxed("x = \\boxed{\\frac{\\sqrt{3}}{2}} done")).toBe("\\frac{\\sqrt{3}}{2}");
    expect(extractMathAnswer("We get $x=5$. Final answer: 5.")).toBe("5");
  });

  it.each([
    ["\\dfrac{1}{2}", "\\frac12"],
    ["0.5", "\\frac{1}{2}"],
    ["x = 3", "3"],
    ["90^\\circ", "90"],
    ["\\left( 3, 4 \\right)", "(3,4)"],
    ["10\\%", "10"],
    ["\\text{(B)}", "(B)"],
    ["5 \\text{ cm}", "5"],
  ])("treats %s as %s", (actual, expected) => {
    expect(mathEquivalent(actual, expected)).toBe(true);
  });

  it("does not equate different answers", () => {
    expect(mathEquivalent("\\frac{1}{3}", "0.34")).toBe(false);
    expect(mathEquivalent("2\\sqrt{2}", "\\sqrt{2}")).toBe(false);
  });
});

describe("text normalisation", () => {
  it("drops case, punctuation and articles", () => {
    expect(normaliseText("The Eiffel Tower!")).toBe("eiffel tower");
    expect(normaliseText("Marie Curie.", { ignoreCase: false })).toBe("Marie Curie");
  });
});

describe("IFEval checkers", () => {
  const check = (response: string, id: string, kwargs: Record<string, unknown> = {}, mode: "strict" | "loose" = "strict") =>
    evaluateIfEval(response, [{ id, kwargs }], mode)[0];

  it("checks keywords, frequencies and forbidden words", () => {
    expect(check("Paris is lovely in spring", "keywords:existence", { keywords: ["paris", "spring"] }).followed).toBe(true);
    expect(check("Paris", "keywords:existence", { keywords: ["paris", "rome"] }).followed).toBe(false);
    expect(check("cat cat cat", "keywords:frequency", { keyword: "cat", frequency: 3, relation: "at least" }).followed).toBe(true);
    expect(check("cat cat cat", "keywords:frequency", { keyword: "cat", frequency: 3, relation: "less than" }).followed).toBe(false);
    expect(check("a scathing review", "keywords:forbidden_words", { forbidden_words: ["cat"] }).followed).toBe(true);
    expect(check("a cat review", "keywords:forbidden_words", { forbidden_words: ["cat"] }).followed).toBe(false);
    expect(check("banana", "keywords:letter_frequency", { letter: "a", let_frequency: 3, let_relation: "at least" }).followed).toBe(true);
  });

  it("counts words, sentences and *** paragraphs", () => {
    expect(check("one two three four", "length_constraints:number_words", { num_words: 5, relation: "less than" }).followed).toBe(true);
    expect(countSentences("Dr. Smith arrived. He paid $3.50 for tea! Was it good? Yes.")).toBe(4);
    expect(check("First.\n***\nSecond.\n***\nThird.", "length_constraints:number_paragraphs", { num_paragraphs: 3 }).followed).toBe(true);
    expect(check("First.\n***\n\n***\nThird.", "length_constraints:number_paragraphs", { num_paragraphs: 2 }).followed).toBe(false);
  });

  it("checks the nth paragraph's first word", () => {
    const response = "Intro here.\n\n\"Summer is warm.\n\nEnd.";
    expect(check(response, "length_constraints:nth_paragraph_first_word", { num_paragraphs: 3, nth_paragraph: 2, first_word: "summer" }).followed).toBe(true);
  });

  it("checks formats: bullets, highlights, sections, JSON, title, placeholders, postscript", () => {
    expect(check("* one\n* two\n- three", "detectable_format:number_bullet_lists", { num_bullets: 3 }).followed).toBe(true);
    expect(check("*a* and **b** and *c*", "detectable_format:number_highlighted_sections", { num_highlights: 3 }).followed).toBe(true);
    expect(check("SECTION 1\nx\nSECTION 2\ny", "detectable_format:multiple_sections", { section_spliter: "SECTION", num_sections: 2 }).followed).toBe(true);
    expect(check('```json\n{"a": 1}\n```', "detectable_format:json_format").followed).toBe(true);
    expect(check("{a: 1}", "detectable_format:json_format").followed).toBe(false);
    expect(check("<<My Poem>>\nRoses…", "detectable_format:title").followed).toBe(true);
    expect(check("Dear [name], at [address]", "detectable_content:number_placeholders", { num_placeholders: 2 }).followed).toBe(true);
    expect(check("Hi.\n\nP.S. see you", "detectable_content:postscript", { postscript_marker: "P.S." }).followed).toBe(true);
    expect(check("My answer is maybe.", "detectable_format:constrained_response").followed).toBe(true);
  });

  it("checks case, commas, quotes, endings, two responses and repetition", () => {
    expect(check("THIS IS ALL CAPS ENGLISH TEXT HERE", "change_case:english_capital").followed).toBe(true);
    expect(check("this is all lower case english text here", "change_case:english_lowercase").followed).toBe(true);
    expect(check("WOW, SO MUCH NASA AND USA", "change_case:capital_word_frequency", { capital_frequency: 3, capital_relation: "at least" }).followed).toBe(true);
    expect(check("no commas at all", "punctuation:no_comma").followed).toBe(true);
    expect(check('"quoted"', "startend:quotation").followed).toBe(true);
    expect(check("… Is there anything else I can help with?", "startend:end_checker", { end_phrase: "Is there anything else I can help with?" }).followed).toBe(true);
    expect(check("First answer\n******\nSecond answer", "combination:two_responses").followed).toBe(true);
    expect(check("Write a poem. Here it is…", "combination:repeat_prompt", { prompt_to_repeat: "Write a poem." }).followed).toBe(true);
  });

  it("loose mode forgives a preamble line and markdown asterisks", () => {
    const response = "Sure! Here you go:\n\"all quoted\"";
    expect(check(response, "startend:quotation").followed).toBe(false);
    expect(check(response, "startend:quotation", {}, "loose").followed).toBe(true);
  });

  it("flags an unknown instruction instead of passing it", () => {
    const [result] = evaluateIfEval("x", [{ id: "made:up" }]);
    expect(result.followed).toBe(false);
    expect(result.error).toMatch(/unknown instruction/);
  });
});

describe("language detection", () => {
  it.each([
    ["The quick brown fox jumps over the lazy dog and the cat is sleeping.", "en"],
    ["El perro de la casa es muy grande y los niños juegan con él en el parque.", "es"],
    ["Le chat est sur la table et les enfants jouent dans le jardin avec des amis.", "fr"],
    ["Der Hund ist nicht im Haus und die Kinder spielen mit dem Ball auf der Straße.", "de"],
    ["Я не знаю, что это такое, но это очень интересно и как всегда красиво.", "ru"],
    ["यह एक बहुत अच्छी किताब है और मैं इसे पढ़ना चाहता हूं।", "hi"],
    ["これは日本語の文章です。とても面白いですね。", "ja"],
    ["이것은 한국어 문장입니다. 정말 재미있어요.", "ko"],
    ["Tôi không biết điều này là gì nhưng nó rất thú vị và đẹp.", "vi"],
    ["Hii ni kitabu kizuri sana na watoto wa shule wanapenda kusoma kwa furaha.", "sw"],
  ])("detects %j", (text, language) => {
    expect(detectLanguage(text)).toBe(language);
  });

  it("returns null for too little text", () => {
    expect(detectLanguage("ok")).toBeNull();
  });
});
