import { VOICES, DEFAULT_VOICES } from "../config.ts";
import { PROVIDERS } from "../constants.ts";

type VoiceEntry = { name: string; gender: string; description: string };

const TTS_VOICE_CATALOG_PLACEHOLDER = "{{TTS_VOICE_CATALOG}}";

const VOICE_CATALOGS: Record<string, string> = {
  [PROVIDERS.INWORLD]: buildInworldCatalog(),
  [PROVIDERS.OPENAI]: buildOpenAICatalog(),
  [PROVIDERS.GOOGLE]: buildGoogleCatalog(),
  [PROVIDERS.ELEVENLABS]: buildElevenLabsCatalog(),
};

function genderLabel(gender: string): string {
  return gender === "Male" ? "M" : "F";
}

function buildInworldCatalog(): string {
  const voices = (VOICES[PROVIDERS.INWORLD] || []) as VoiceEntry[];
  const defaultVoice = DEFAULT_VOICES[PROVIDERS.INWORLD] || "Dennis";
  const entries = voices
    .map((voice) => {
      const isDefault = voice.name === defaultVoice;
      const shortDescription = voice.description
        .split(",")[0]
        .replace(/^(A |An )/i, "")
        .trim();
      return `${voice.name} (${shortDescription}, ${genderLabel(voice.gender)}${isDefault ? " — DEFAULT" : ""})`;
    });

  const steeringInstructions = [
    "This provider uses inworld-tts-2 which supports instruction tags — natural language directions in square brackets placed before the text they apply to.",
    "Use instruction tags to match delivery to the content:",
    "Emotion: [say excitedly], [sound sad], [sound concerned], [sound terrified]",
    "Articulation: [say with force], [articulate clearly], [say with deliberate pauses]",
    "Intonation: [say with a falling pitch], [say with a rising pitch]",
    "Volume: [very quiet], [very loud]",
    "Pitch: [say in a low tone], [say in a high pitch]",
    "Range: [say playfully], [say with no pitch variation]",
    "Speed: [very fast], [very slow]",
    "Vocal style: [whisper in a hushed style], [give a nasal quality], [sing joyfully]",
    "Non-verbals (inline): [laugh], [sigh], [clear throat], [breathe], [cough], [yawn]",
    "For maximum control, combine qualities: [say sadly with deliberate pauses in a low voice and hushed style].",
    "Place the tag at the start of the text it applies to. Capitalize words for emphasis: 'I told you NOT to do that.'",
    "Include filler words (uh, um, well) for naturalness. Use contractions. Write numbers in spoken form.",
    "Never use markdown, bullet points, emojis, or structured text — write everything as natural spoken sentences.",
  ].join(" ");

  return `Available Inworld voices (${entries.length}): ${entries.join(", ")}. ${steeringInstructions}`;
}

function buildOpenAICatalog(): string {
  const voiceDescriptions: Record<string, string> = {
    alloy: "neutral balanced — versatile default",
    ash: "clear approachable M",
    ballad: "melodic smooth M",
    coral: "warm polished F — business/education",
    echo: "resonant deep authoritative M — narration, DEFAULT",
    fable: "animated energetic M — audiobooks",
    nova: "bright upbeat F — tutorials",
    onyx: "bold deep M — announcements",
    sage: "calm thoughtful F — meditation/instructional",
    shimmer: "soft intimate cheerful F",
    verse: "versatile expressive M",
    marin: "warm relaxed F",
    cedar: "bright energetic M",
  };
  const entries = Object.entries(voiceDescriptions).map(
    ([name, description]) => `${name} (${description})`,
  );
  return `Available OpenAI voices: ${entries.join(", ")}.`;
}

function buildGoogleCatalog(): string {
  const voiceDescriptions: Record<string, string> = {
    Kore: "firm strong F — DEFAULT",
    Charon: "calm professional informative M",
    Fenrir: "passionate excitable M",
    Puck: "upbeat lively M",
    Aoede: "relaxed natural F",
    Leda: "youthful energetic F",
    Orus: "calm firm M",
    Achernar: "soft warm F",
    Zephyr: "bright clear F",
    Despina: "smooth gentle F",
    Enceladus: "soft breathy M",
    Sulafat: "warm approachable F",
  };
  const entries = Object.entries(voiceDescriptions).map(
    ([name, description]) => `${name} (${description})`,
  );
  return `Available Google voices: ${entries.join(", ")}.`;
}

function buildElevenLabsCatalog(): string {
  const voiceDescriptions: Record<string, string> = {
    Rachel: "warm conversational young F — DEFAULT",
    Bella: "soft soothing intimate F — meditation",
    Antoni: "deep authoritative M — news/presentations",
    Josh: "young clear M",
    Arnold: "strong deep M",
    Adam: "clear mid-range M",
    Sam: "articulate M",
  };
  const entries = Object.entries(voiceDescriptions).map(
    ([name, description]) => `${name} (${description})`,
  );
  return `Available ElevenLabs voices: ${entries.join(", ")}.`;
}

export function getVoiceCatalogForProvider(provider: string): string {
  return VOICE_CATALOGS[provider] || VOICE_CATALOGS[PROVIDERS.ELEVENLABS];
}

export function injectVoiceCatalog(
  description: string,
  provider: string,
): string {
  if (!description.includes(TTS_VOICE_CATALOG_PLACEHOLDER)) return description;
  return description.replace(
    TTS_VOICE_CATALOG_PLACEHOLDER,
    getVoiceCatalogForProvider(provider),
  );
}

export { TTS_VOICE_CATALOG_PLACEHOLDER };
