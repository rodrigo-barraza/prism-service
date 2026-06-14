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
  return `Available Inworld voices (${entries.length}): ${entries.join(", ")}.`;
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
