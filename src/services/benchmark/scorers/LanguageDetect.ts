/**
 * LanguageDetect — which language a reply is written in (ISO 639-1), for
 * IFEval's response_language / english_* checks.
 *
 * The original uses langdetect (character n-gram profiles). This covers the
 * languages IFEval asks for with two signals: the dominant SCRIPT settles
 * most of them outright (Hangul, Thai, Tamil…), and within a script shared
 * by several languages (Latin, Cyrillic, Arabic, Devanagari) the letters
 * only one of them uses and its most frequent function words decide.
 * Returns null when there is too little text to say.
 */

interface ScriptRange {
  script: string;
  test: RegExp;
}

const SCRIPTS: ScriptRange[] = [
  { script: "hangul", test: /[가-힯ᄀ-ᇿ]/ },
  { script: "kana", test: /[぀-ヿ]/ },
  { script: "han", test: /[一-鿿]/ },
  { script: "thai", test: /[฀-๿]/ },
  { script: "hebrew", test: /[֐-׿]/ },
  { script: "arabic", test: /[؀-ۿݐ-ݿ]/ },
  { script: "devanagari", test: /[ऀ-ॿ]/ },
  { script: "bengali", test: /[ঀ-৿]/ },
  { script: "gurmukhi", test: /[਀-੿]/ },
  { script: "gujarati", test: /[઀-૿]/ },
  { script: "tamil", test: /[஀-௿]/ },
  { script: "telugu", test: /[ఀ-౿]/ },
  { script: "kannada", test: /[ಀ-೿]/ },
  { script: "malayalam", test: /[ഀ-ൿ]/ },
  { script: "cyrillic", test: /[Ѐ-ӿ]/ },
  { script: "greek", test: /[Ͱ-Ͽ]/ },
  { script: "latin", test: /[A-Za-zÀ-ɏḀ-ỿ]/ },
];

const SINGLE_LANGUAGE_SCRIPTS: Record<string, string> = {
  hangul: "ko",
  kana: "ja",
  thai: "th",
  hebrew: "he",
  bengali: "bn",
  gurmukhi: "pa",
  gujarati: "gu",
  tamil: "ta",
  telugu: "te",
  kannada: "kn",
  malayalam: "ml",
  greek: "el",
  han: "zh-cn",
};

/** Frequent function words per language, for scripts several languages share. */
const STOP_WORDS: Record<string, string[]> = {
  en: ["the", "and", "is", "of", "to", "in", "that", "it", "you", "for", "with", "are", "this", "was", "be", "on", "not", "have", "as", "or"],
  es: ["el", "la", "de", "que", "y", "en", "los", "las", "es", "por", "un", "una", "para", "con", "no", "del", "se", "su", "al", "lo"],
  pt: ["o", "a", "de", "que", "e", "do", "da", "em", "um", "uma", "para", "com", "não", "os", "as", "se", "no", "na", "por", "mais"],
  fr: ["le", "la", "de", "et", "les", "des", "est", "un", "une", "du", "que", "en", "pour", "dans", "pas", "qui", "sur", "au", "avec", "ce"],
  de: ["der", "die", "und", "das", "ist", "nicht", "ein", "eine", "zu", "den", "mit", "sich", "von", "auf", "für", "es", "dem", "auch", "im", "ich"],
  it: ["il", "di", "che", "e", "la", "per", "un", "una", "non", "in", "del", "della", "sono", "con", "le", "è", "si", "da", "gli", "lo"],
  pl: ["i", "w", "nie", "na", "się", "jest", "z", "do", "to", "że", "o", "jak", "co", "ale", "po", "tak", "od", "za", "czy", "być"],
  fi: ["ja", "on", "ei", "se", "että", "oli", "ovat", "mutta", "hän", "kun", "niin", "tai", "myös", "joka", "kuin", "ole", "sen", "tämä", "vain", "olla"],
  sw: ["na", "ya", "wa", "kwa", "ni", "za", "katika", "la", "cha", "kuwa", "hii", "au", "lakini", "pia", "ili", "sana", "vya", "huo", "hiyo", "yake"],
  vi: ["và", "của", "là", "có", "không", "được", "các", "những", "một", "trong", "cho", "này", "với", "người", "đã", "để", "khi", "thì", "như", "cũng"],
  nl: ["de", "het", "een", "en", "van", "is", "dat", "niet", "zijn", "op", "te", "met", "voor", "er", "ook", "maar", "die", "als", "aan", "bij"],
  ru: ["и", "в", "не", "на", "что", "я", "с", "он", "как", "это", "по", "но", "из", "к", "у", "за", "то", "все", "так", "же"],
  uk: ["і", "в", "не", "на", "що", "з", "та", "це", "як", "до", "у", "за", "по", "але", "його", "від", "він", "так", "які", "бути"],
  bg: ["и", "в", "на", "не", "да", "се", "е", "за", "от", "с", "че", "по", "са", "това", "как", "но", "го", "ще", "към", "при"],
  hi: ["है", "के", "में", "की", "और", "का", "को", "से", "हैं", "यह", "पर", "एक", "भी", "नहीं", "था", "कि", "लिए", "हो", "तो", "गया"],
  mr: ["आहे", "आणि", "च्या", "या", "हे", "ते", "की", "मध्ये", "आहेत", "एक", "होते", "त्या", "व", "नाही", "केले", "तर", "पण", "हा", "ही", "करून"],
  ne: ["छ", "र", "को", "मा", "हो", "पनि", "गर्न", "छन्", "भने", "यो", "थियो", "एक", "लागि", "गरेको", "नै", "हुन्छ", "भएको", "गर्ने", "तथा", "छैन"],
  ar: ["في", "من", "على", "أن", "إلى", "هذا", "التي", "عن", "مع", "هو", "كان", "ما", "لا", "الذي", "هذه", "كل", "بين", "قد", "أو", "ذلك"],
  fa: ["و", "در", "به", "از", "که", "این", "را", "با", "است", "برای", "آن", "یک", "خود", "تا", "کرد", "بر", "هم", "نیز", "می", "شد"],
  ur: ["کے", "میں", "کی", "ہے", "اور", "کا", "سے", "کو", "نے", "یہ", "پر", "ہیں", "تھا", "بھی", "ایک", "کہ", "لیے", "نہیں", "گیا", "وہ"],
};

const LANGUAGES_BY_SCRIPT: Record<string, string[]> = {
  latin: ["en", "es", "pt", "fr", "de", "it", "pl", "fi", "sw", "vi", "nl"],
  cyrillic: ["ru", "uk", "bg"],
  devanagari: ["hi", "mr", "ne"],
  arabic: ["ar", "fa", "ur"],
};

/** Letters that point to one language of a shared script. */
const DISTINCTIVE_LETTERS: Record<string, RegExp> = {
  vi: /[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđơư]/i,
  pl: /[ąęłńśźż]/i,
  de: /[äöüß]/i,
  es: /[ñ¿¡]/i,
  pt: /[ãõç]/i,
  fr: /[èêëàâçœîïùû]/i,
  uk: /[іїєґ]/i,
  ru: /[ыэё]/i,
  fa: /[گچپژ]/,
  ur: /[ٹڈڑںےھ]/,
};

export function detectLanguage(input: string): string | null {
  const sample = input.slice(0, 20_000);
  const letters = [...sample].filter((character) => /\p{L}/u.test(character));
  if (letters.length < 8) return null;
  const counts = new Map<string, number>();
  for (const character of letters) {
    const range = SCRIPTS.find((candidate) => candidate.test.test(character));
    if (range) counts.set(range.script, (counts.get(range.script) ?? 0) + 1);
  }
  // Japanese mixes kana with Han; any real share of kana means Japanese.
  if ((counts.get("kana") ?? 0) >= letters.length * 0.05) return "ja";
  const [script] = [...counts.entries()].sort((first, second) => second[1] - first[1])[0] ?? [];
  if (!script) return null;
  if (SINGLE_LANGUAGE_SCRIPTS[script]) return SINGLE_LANGUAGE_SCRIPTS[script];
  const candidates = LANGUAGES_BY_SCRIPT[script];
  if (!candidates) return null;
  const words = sample.toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
  if (words.length === 0) return null;
  const scores = new Map<string, number>();
  for (const language of candidates) {
    const stopWords = new Set(STOP_WORDS[language] ?? []);
    let hits = 0;
    for (const word of words) if (stopWords.has(word)) hits++;
    const distinctive = DISTINCTIVE_LETTERS[language];
    const distinctiveHits = distinctive ? (sample.match(new RegExp(distinctive.source, "gi")) ?? []).length : 0;
    scores.set(language, hits / words.length + Math.min(0.3, distinctiveHits / Math.max(20, words.length)));
  }
  const [best] = [...scores.entries()].sort((first, second) => second[1] - first[1]);
  return best && best[1] > 0 ? best[0] : candidates[0];
}
