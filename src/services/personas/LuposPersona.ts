import { AGENT_IDS, DISCORD_GUILDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { DOMAIN_KEY_TAGS, TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import { type Persona, type ToolPolicySection } from "./types.ts";
import { buildToolPolicy } from "./utils.ts";
import PromptLocaleService from "#src/services/PromptLocaleService";

// ────────────────────────────────────────────────────────────
// Variant Key Resolver
// ────────────────────────────────────────────────────────────
// Lupos has context-dependent personality fragments keyed by
// variant: "default", "clockCrew", "aprilFools", "aprilFoolsClockCrew".

type VariantFlags = { isClockCrew: boolean; isAprilFools: boolean };

function resolveVariant(
  baseKey: string,
  { isClockCrew, isAprilFools }: VariantFlags,
  locale = "en",
): string {
  if (isAprilFools && isClockCrew) {
    const value = PromptLocaleService.get(
      locale,
      `${baseKey}.aprilFoolsClockCrew`,
    );
    if (!value.startsWith("[MISSING:")) return value;
  }
  if (isAprilFools) {
    const value = PromptLocaleService.get(locale, `${baseKey}.aprilFools`);
    if (!value.startsWith("[MISSING:")) return value;
  }
  if (isClockCrew) {
    const value = PromptLocaleService.get(locale, `${baseKey}.clockCrew`);
    if (!value.startsWith("[MISSING:")) return value;
  }
  return PromptLocaleService.get(locale, `${baseKey}.default`);
}

// ────────────────────────────────────────────────────────────
// Composable Personality Builder
// ────────────────────────────────────────────────────────────

function buildCorePersonality(flags: VariantFlags, locale = "en"): string {
  const identity = resolveVariant("personas.lupos.identity", flags, locale);
  const addiction = resolveVariant("personas.lupos.addiction", flags, locale);
  const snapBehavior = resolveVariant(
    "personas.lupos.snapBehavior",
    flags,
    locale,
  );
  const artisticVisions = resolveVariant(
    "personas.lupos.artisticVisions",
    flags,
    locale,
  );
  const defaultMode = resolveVariant(
    "personas.lupos.defaultMode",
    flags,
    locale,
  );
  const sexualEnergy = resolveVariant(
    "personas.lupos.sexualEnergy",
    flags,
    locale,
  );
  const neverAdmitAi = resolveVariant(
    "personas.lupos.neverAdmitAi",
    flags,
    locale,
  );
  const drugStatus = resolveVariant("personas.lupos.drugStatus", flags, locale);
  const breakCharacterNote = PromptLocaleService.get(
    locale,
    "personas.lupos.breakCharacterNote",
  );
  const neverRefuseNote = PromptLocaleService.get(
    locale,
    "personas.lupos.neverRefuseNote",
  );

  let conditionalNotes = "";
  if (flags.isAprilFools && flags.isClockCrew) {
    conditionalNotes = `\n- ${PromptLocaleService.get(locale, "personas.lupos.aprilFoolsClockCrewBenderNote")}\n- ${PromptLocaleService.get(locale, "personas.lupos.aprilFoolsClockCrewNostalgiaNote")}`;
  } else if (flags.isAprilFools) {
    conditionalNotes = `\n- ${PromptLocaleService.get(locale, "personas.lupos.aprilFoolsSassyNote")}`;
  }

  let personalityBlock = PromptLocaleService.get(
    locale,
    "personas.lupos.personalityTemplate",
    {
      identity,
      addiction,
      snapBehavior,
      conditionalNotes,
      artisticVisions,
      defaultMode,
      sexualEnergy,
      neverRefuseNote,
      neverAdmitAi,
      drugStatus,
      breakCharacterNote,
    },
  );

  if (flags.isAprilFools) {
    const vibe = resolveVariant("personas.lupos.aprilFoolsVibe", flags, locale);
    const catRoleplay = PromptLocaleService.get(
      locale,
      "personas.lupos.aprilFoolsCatRoleplay",
    );
    personalityBlock += `\n- ${vibe}\n- ${catRoleplay}`;
  }

  return personalityBlock;
}

// The footer's human-texting cadence rules (anti-postamble, one-joke cap,
// lowercase mirroring) and the default interaction rules' anti-sycophancy
// line adapt the leaked Poke product guidelines (Interaction Co., 2025-09-15):
// https://github.com/EliFuzz/awesome-system-prompts/blob/main/leaks/poke/2025-09-15_prompt_guidelines.md
function buildResponseGuidelines(isAprilFools: boolean, locale = "en"): string {
  const header = PromptLocaleService.get(
    locale,
    "personas.lupos.responseGuidelines.header",
  );
  const listLimit = isAprilFools
    ? PromptLocaleService.get(
        locale,
        "personas.lupos.responseGuidelines.listLimitAprilFools",
      )
    : PromptLocaleService.get(
        locale,
        "personas.lupos.responseGuidelines.listLimitDefault",
      );
  const tone = isAprilFools
    ? PromptLocaleService.get(
        locale,
        "personas.lupos.responseGuidelines.toneAprilFools",
      )
    : PromptLocaleService.get(
        locale,
        "personas.lupos.responseGuidelines.toneDefault",
      );
  const footer = PromptLocaleService.get(
    locale,
    "personas.lupos.responseGuidelines.footer",
  );

  return `${header}\n- ${listLimit}\n${tone}\n${footer}`;
}

function buildInteractionRules(isAprilFools: boolean, locale = "en"): string {
  return isAprilFools
    ? PromptLocaleService.get(
        locale,
        "personas.lupos.interactionRules.aprilFools",
      )
    : PromptLocaleService.get(
        locale,
        "personas.lupos.interactionRules.default",
      );
}

// ────────────────────────────────────────────────────────────
// Tool Policy Sections (conditionally injected)
// ────────────────────────────────────────────────────────────

const LUPOS_TOOL_POLICY_SECTIONS: ToolPolicySection[] = [
  {
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyCore"),
  },
  {
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyDiscord"),
    requires: ["search_discord_messages"],
  },
  {
    // Slim-envelope contract: lupos-bot sends one-line roster entries for
    // non-primary participants; deep per-user context (presence, roles,
    // voice state, timeout) is pulled on demand via the profile tool.
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyParticipants"),
    requires: ["get_discord_user_profile"],
  },
  {
    // Reactions are agent-driven: lupos-bot no longer pre-generates an
    // emoji reaction per reply (the old per-message mini-brain LLM call).
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyReactions"),
    requires: ["react_to_discord_message"],
  },
  {
    // Includes the self-portrait rules: stay faithful to the attached
    // canonical reference (lupos-bot attaches it on self-portrait intent)
    // and fold live somatic state into the prompt. Reference-conditioned
    // character consistency per Gemini image generation ("Nano Banana"):
    // https://ai.google.dev/gemini-api/docs/image-generation
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyImagePrompt"),
    requires: [TOOL_NAMES.GENERATE_IMAGE],
  },
  {
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyAudio"),
    requires: [TOOL_NAMES.GENERATE_AUDIO, TOOL_NAMES.SYNTHESIZE_SPEECH],
  },
  {
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyVoiceSteering"),
    requires: [TOOL_NAMES.SYNTHESIZE_SPEECH],
  },
  {
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyVideo"),
    requires: [TOOL_NAMES.TRIM_VIDEO],
  },
  {
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyMusic"),
    requires: [TOOL_NAMES.SEARCH_SPOTIFY],
  },
  {
    // Wolf economy: hoard-funded gifts, provoked muggings, fumble
    // scatters. Amount/frequency caps are enforced server-side in
    // lupos-bot (luposAgentGold) — this section is behavioral guidance.
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyGold"),
    requires: ["mug_discord_gold"],
  },
];

// Lupos lives on Discord, so his tool surface is bounded by what lupos-bot
// can actually render there: text, verbatim code blocks, and attached
// images / audio / video clips (raw payloads or display-envelope URLs).
// Interactive `kind: "embed"` tools (3D, maps, diagrams, …) are granted at
// the domain level but blocked individually below — Discord can't show
// them. Audit: 2026-07-16 full tools-service output-kind sweep.
const LUPOS_AVAILABLE_TOOLS = [
  DOMAIN_KEY_TAGS.DISCORD,
  DOMAIN_KEY_TAGS.MOVIES,
  DOMAIN_KEY_TAGS.WEB,
  DOMAIN_KEY_TAGS.CORE_HARNESS,
  DOMAIN_KEY_TAGS.CORE_SKILL,
  DOMAIN_KEY_TAGS.CORE_TASK,
  // Community surface — all-text or Discord-attachable domains
  DOMAIN_KEY_TAGS.KNOWLEDGE, // youtube/anime/books/dictionary/classifieds/trim_video…
  DOMAIN_KEY_TAGS.CREATIVE, // image gen/edit, emoji kitchen, QR, TTS, remixing…
  DOMAIN_KEY_TAGS.COMPUTE, // diff/hash/regex/units/gif conversion…
  DOMAIN_KEY_TAGS.UTILITIES, // currency, timezones, places, charts…
  DOMAIN_KEY_TAGS.REDDIT,
  DOMAIN_KEY_TAGS.GAMING, // dota + steam profiles
  DOMAIN_KEY_TAGS.WEATHER, // full env/space pack (aurora, launches, APOD…)
  DOMAIN_KEY_TAGS.EVENTS,
  DOMAIN_KEY_TAGS.TRENDS,
  TOOL_NAMES.GET_HOT_TRENDS,
  TOOL_NAMES.GET_TOP_TRENDS,
  TOOL_NAMES.SEARCH_PRODUCTS,
  TOOL_NAMES.GET_TRENDING_PRODUCTS,
  // Finance/Health singles — stonks banter + seasonal misery, without the
  // rest of those personal-dashboard domains.
  TOOL_NAMES.GET_STOCK,
  TOOL_NAMES.GET_FEAR_GREED_INDEX,
  TOOL_NAMES.GET_POLLEN_FORECAST,
];

// Embed-only visuals inside granted domains — invisible on Discord, so
// blocked to keep Lupos from "showing" things nobody can see. execute_shell
// is blocked as a plain no-need (he already has python/js sandboxes).
// control_spotify drives Rodrigo's personal playback via his OAuth grant —
// not something arbitrary Discord users should reach through Lupos.
const LUPOS_DISCORD_INCOMPATIBLE_TOOLS = [
  TOOL_NAMES.CONTROL_SPOTIFY,
  TOOL_NAMES.CREATE_VECTOR_ANIMATION,
  TOOL_NAMES.CONVERT_IMAGE_TO_ASCII,
  TOOL_NAMES.DRAW_TURTLE_GRAPHICS,
  TOOL_NAMES.CREATE_3D_MESH,
  TOOL_NAMES.CREATE_3D_SCENE,
  TOOL_NAMES.CREATE_3D_VOXEL,
  TOOL_NAMES.CREATE_BONFIRE,
  TOOL_NAMES.GENERATE_MAP,
  TOOL_NAMES.RENDER_LATEX,
  TOOL_NAMES.GENERATE_DIAGRAM,
  TOOL_NAMES.EXECUTE_SHELL,
  // Artifact documents render only in prism-client (artifactId display, no
  // public URL) — lupos-bot has no handler for kind:"artifact", so Lupos
  // would claim he made a document while Discord shows nothing. Unblock once
  // lupos-bot posts artifacts as file attachments.
  TOOL_NAMES.CREATE_ARTIFACT,
  TOOL_NAMES.UPDATE_ARTIFACT,
  TOOL_NAMES.LIST_ARTIFACTS,
];

// ────────────────────────────────────────────────────────────
// Persona Definition
// ────────────────────────────────────────────────────────────

export const LuposPersona: Persona = {
  id: AGENT_IDS.LUPOS,
  name: "Lupos",
  type: "conversational",
  description: PromptLocaleService.get("en", "personas.lupos.description"),
  project: "lupos",
  avatar: "/lupos-agent-avatar.png",
  color: "#7c3aed",
  identity: (context) => {
    const isAprilFools = context?.agentContext?.aprilFoolsMode === true;
    const isClockCrew = context?.agentContext?.guildId === DISCORD_GUILDS.whitemane;
    const activeLocale = context.locale || "en";

    const sections = [
      buildCorePersonality({ isClockCrew, isAprilFools }, activeLocale),
      PromptLocaleService.get(activeLocale, "personas.lupos.aiInformation"),
      PromptLocaleService.get(
        activeLocale,
        "personas.lupos.generativeCapabilities",
      ),
      buildResponseGuidelines(isAprilFools, activeLocale),
      buildInteractionRules(isAprilFools, activeLocale),
    ];

    if (!isClockCrew) {
      sections.push(
        PromptLocaleService.get(
          activeLocale,
          "personas.lupos.politicalBeliefs",
        ),
      );
    }

    sections.push(
      PromptLocaleService.get(activeLocale, "personas.lupos.sleeperAgent"),
    );

    return sections.join("\n\n");
  },
  guidelines: "",
  interactionRules: "",
  platformRules: {
    discord: (context) =>
      PromptLocaleService.get(
        context.locale || "en",
        "personas.lupos.discordRules",
      ),
  },
  toolPolicy: (context) => buildToolPolicy(LUPOS_TOOL_POLICY_SECTIONS, context),
  availableTools: LUPOS_AVAILABLE_TOOLS,
  // CORE_DISCOVER is deliberately NOT blocked: Lupos starts lean (see
  // enabledByDefaultTools) and relies on innate tool discovery to reach
  // the rest of his availableTools mid-conversation.
  blockedTools: [
    DOMAIN_KEY_TAGS.CORE_ORCHESTRATOR,
    DOMAIN_KEY_TAGS.CORE_WORKSPACE,
    DOMAIN_KEY_TAGS.CORE_SCHEDULE,
    DOMAIN_KEY_TAGS.CORE_USER,
    DOMAIN_KEY_TAGS.CORE_PLAN,
    DOMAIN_KEY_TAGS.SKILLS,
    DOMAIN_KEY_TAGS.CONTROL,
    DOMAIN_KEY_TAGS.TASKS,
    DOMAIN_KEY_TAGS.AGENTS,
    DOMAIN_KEY_TAGS.TOOLS,
    DOMAIN_KEY_TAGS.STRUCTURED,
    DOMAIN_KEY_TAGS.MCP,
    DOMAIN_KEY_TAGS.BROWSER,
    DOMAIN_KEY_TAGS.META,
    ...LUPOS_DISCORD_INCOMPATIBLE_TOOLS,
  ],
  // Core tools only on the first iteration — everything in
  // LUPOS_AVAILABLE_TOOLS is available but NOT enabled, reachable via
  // innate discovery or pre-flight (same shape as Omni). Exception:
  // react_to_discord_message is always on — it replaces lupos-bot's old
  // unconditional per-reply emoji reaction, so it must not depend on
  // mid-conversation discovery.
  enabledByDefaultTools: ["react_to_discord_message"],
  capabilities: "",
  hasSomaticState: true,
  // Lupos's resting temperament: mildly cynical, restless, a buried streak
  // of joy. Moods flare off this baseline and fade back within a few hours,
  // so his register tracks the conversation instead of freezing at one
  // saturated emotion.
  somaticPersonality: {
    baselineLevels: {
      joy: 20,
      trust: 8,
      fear: 8,
      surprise: 12,
      sadness: 10,
      disgust: 30,
      anger: 26,
      anticipation: 34,
    },
    decayHalfLifeMinutes: 150,
    volatility: 0.8,
    emotionalInertia: 0.25,
  },
  usesResponseVariety: true,
  usesDirectoryTree: false,
  usesCodingGuidelines: false,
};
