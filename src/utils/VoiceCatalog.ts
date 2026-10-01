import { VOICES, DEFAULT_VOICES, getDefaultModels, MODALITY_TYPES } from "#src/config";
import { PROVIDERS } from "#src/constants";
import PromptLocaleService from "#src/services/PromptLocaleService";

type VoiceEntry = {
  name: string;
  gender: string;
  description: string;
  label?: string;
};

const TTS_VOICE_CATALOG_PLACEHOLDER = "{{TTS_VOICE_CATALOG}}";

/** ElevenLabs models that perform inline audio tags (incl. sound effects). */
const ELEVENLABS_AUDIO_TAG_MODEL = /^eleven_v[34]/;

// Static catalogs only. Inworld and ElevenLabs are built per call: their
// text depends on the active model, and reading VOICES at import time would
// break every module that imports this one under a partial config mock.
const VOICE_CATALOGS: Record<string, string> = {
  [PROVIDERS.OPENAI]: buildOpenAICatalog(),
  [PROVIDERS.GOOGLE]: buildGoogleCatalog(),
};

function genderLabel(gender: string): string {
  if (gender === "Male") return "M";
  if (gender === "Female") return "F";
  return "N";
}

function buildInworldCatalog(model?: string): string {
  const voices = (VOICES[PROVIDERS.INWORLD] || []) as VoiceEntry[];
  const defaultVoice = DEFAULT_VOICES[PROVIDERS.INWORLD] || "Dennis";
  const entries = voices.map((voice) => {
    const isDefault = voice.name === defaultVoice;
    const shortDescription = voice.description
      .split(",")[0]
      .replace(/^(A |An )/i, "")
      .trim();
    return `${voice.name} (${shortDescription}, ${genderLabel(voice.gender)}${isDefault ? " — DEFAULT" : ""})`;
  });

  const activeModel =
    model ||
    getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.AUDIO).inworld ||
    "inworld-tts-2";
  const isTtsTwo = activeModel.startsWith("inworld-tts-2");

  if (!isTtsTwo) {
    return PromptLocaleService.get(
      "en",
      "voice-catalog.catalogFormat.inworld",
      {
        count: String(entries.length),
        voices: entries.join(", "),
      },
    );
  }

  const steeringInstructions = PromptLocaleService.get(
    "en",
    "voice-catalog.inworldTts2Steering",
  );

  return `${PromptLocaleService.get(
    "en",
    "voice-catalog.catalogFormat.inworld",
    {
      count: String(entries.length),
      voices: entries.join(", "),
    },
  )} ${steeringInstructions}`;
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
  return PromptLocaleService.get("en", "voice-catalog.catalogFormat.openai", {
    voices: entries.join(", "),
  });
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
  return PromptLocaleService.get("en", "voice-catalog.catalogFormat.google", {
    voices: entries.join(", "),
  });
}

/**
 * ElevenLabs voices by label — the provider maps a label back to the voice
 * ID the API needs. Models that perform audio tags (Eleven v3/v4) get the
 * tag guide appended, sound effects included.
 */
function buildElevenLabsCatalog(model?: string): string {
  const voices = (VOICES[PROVIDERS.ELEVENLABS] || []) as VoiceEntry[];
  const defaultVoice = DEFAULT_VOICES[PROVIDERS.ELEVENLABS];
  const entries = voices.map((voice) => {
    const isDefault = voice.name === defaultVoice;
    return `${voice.label ?? voice.name} (${voice.description}, ${genderLabel(voice.gender)}${isDefault ? " — DEFAULT" : ""})`;
  });
  const catalog = PromptLocaleService.get(
    "en",
    "voice-catalog.catalogFormat.elevenlabs",
    {
      voices: entries.join(", "),
    },
  );

  const activeModel =
    model ||
    getDefaultModels(MODALITY_TYPES.TEXT, MODALITY_TYPES.AUDIO).elevenlabs ||
    "";
  if (!ELEVENLABS_AUDIO_TAG_MODEL.test(activeModel)) return catalog;

  return `${catalog} ${PromptLocaleService.get(
    "en",
    "voice-catalog.elevenlabsAudioTags",
  )}`;
}

export function getVoiceCatalogForProvider(
  provider: string,
  model?: string,
): string {
  if (provider === PROVIDERS.INWORLD) {
    return buildInworldCatalog(model);
  }
  if (provider === PROVIDERS.ELEVENLABS) {
    return buildElevenLabsCatalog(model);
  }
  // An unknown provider falls back to ElevenLabs at its default model.
  return VOICE_CATALOGS[provider] || buildElevenLabsCatalog();
}

export function injectVoiceCatalog(
  description: string,
  provider: string,
  model?: string,
): string {
  if (!description.includes(TTS_VOICE_CATALOG_PLACEHOLDER)) return description;
  return description.replace(
    TTS_VOICE_CATALOG_PLACEHOLDER,
    getVoiceCatalogForProvider(provider, model),
  );
}

export { TTS_VOICE_CATALOG_PLACEHOLDER };
