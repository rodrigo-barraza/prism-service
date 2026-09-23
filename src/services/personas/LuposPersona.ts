import { AGENT_IDS, DISCORD_GUILDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import {
  DOMAIN_KEY_TAGS,
  LOCAL_TOOL_NAMES,
  TOOL_NAMES,
} from "#src/services/ToolTaxonomyConstants";
import { ASYNC_TASK_TOOL_NAMES } from "#src/services/AsyncTaskConstants";
import { allow, deny, type PolicyRule } from "#src/services/PolicyEngine";
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

export const LUPOS_TOOL_POLICY_SECTIONS: ToolPolicySection[] = [
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
    // All three tools are listed because `requires` is an OR: the rules
    // name every one of them, so any one reaching the model must render
    // them. They are enabled by default (see enabledByDefaultTools), so
    // this gate passes on the first iteration rather than waiting for a
    // discovery round that the wolf has no reason to run.
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyGold"),
    requires: [
      "get_discord_gold_balance",
      "give_discord_gold",
      "mug_discord_gold",
    ],
  },
  {
    // Discord actions: polls, threads, reminders, his own nickname —
    // tools-service definitions that act through lupos-bot. Discoverable,
    // not enabled by default, so the rules render once any of them reaches
    // the model (pre-flight on "should we…", "remind me…"). `requires` is
    // an OR, and the section names all six, so every one is listed. The
    // hard limits (one poll/thread per channel per 10 min, 5 pending
    // reminders per member, reminders pinging only the asker) are enforced
    // in lupos-bot; this is when to reach for them.
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.lupos.toolPolicyDiscordActions"),
    requires: [
      "create_discord_poll",
      "create_discord_thread",
      "schedule_discord_reminder",
      "list_discord_reminders",
      "cancel_discord_reminder",
      "set_discord_nickname",
    ],
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

// Core harness tools a Discord reply never uses. coreToolsLocked hands every
// system:true core tool to the first iteration, so before this list his
// iteration 1 carried ~45 tools — the handful of defaults plus ~40 core
// harness/skill/task/discovery schemas, ≈13K tokens re-sent on every reply.
// Each reply is a fresh one-shot conversation, and 30 days of his traffic
// (2026-08-23 → 09-22) called exactly one of them: execute_python, 10 times.
// save_memory, datastores, skills, tasks, goals, programs and async tasks:
// zero. What stays is what a chat answer can use — read_url, search_web,
// the python/js sandboxes, evaluate_expression, retrieve_offloaded_content,
// think (dropped by the resolver under native thinking) and discovery.
const LUPOS_UNUSED_CORE_HARNESS_TOOLS = [
  TOOL_NAMES.SAVE_MEMORY,
  TOOL_NAMES.SLEEP,
  TOOL_NAMES.EMIT_STRUCTURED_OUTPUT,
  LOCAL_TOOL_NAMES.WRITE_DATASTORE,
  LOCAL_TOOL_NAMES.QUERY_DATASTORE,
  LOCAL_TOOL_NAMES.DELETE_DATASTORE,
  TOOL_NAMES.WRITE_TODO,
  TOOL_NAMES.SUMMARIZE_CONVERSATION,
  TOOL_NAMES.SEARCH_CONVERSATIONS,
  TOOL_NAMES.COMPACT_CONTEXT,
  LOCAL_TOOL_NAMES.CHECKPOINT,
  LOCAL_TOOL_NAMES.REWIND,
  ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
  ASYNC_TASK_TOOL_NAMES.LIST_ASYNC_TASKS,
  ASYNC_TASK_TOOL_NAMES.CANCEL_ASYNC_TASK,
  ASYNC_TASK_TOOL_NAMES.WAIT_FOR_TASKS,
  LOCAL_TOOL_NAMES.READ_PROJECT_INSTRUCTIONS,
  LOCAL_TOOL_NAMES.UPDATE_PROJECT_INSTRUCTIONS,
  LOCAL_TOOL_NAMES.EDIT_PROJECT_INSTRUCTIONS,
  LOCAL_TOOL_NAMES.RUN_TOOL_PROGRAM,
  LOCAL_TOOL_NAMES.SET_GOAL,
  LOCAL_TOOL_NAMES.UPDATE_GOAL,
  LOCAL_TOOL_NAMES.CLEAR_GOAL,
];

// ────────────────────────────────────────────────────────────
// Tool Policies — deny list (defence in depth)
// ────────────────────────────────────────────────────────────
// A Discord reply acts for whoever pinged the wolf, and nobody in the
// channel can answer an approval card. availableTools/blockedTools already
// keep every tool below out of his resolved set; these DENY rules hold if
// some future path makes one reachable anyway (a client toggle, an explicit
// enabledTools, a tool program or async dispatcher re-checking an inner
// call). A DENY is final in the approval stack — full auto, every
// permission mode and sub-agents included (AutoApprovalEngine.explain), and
// it beats any APPROVE below (PolicyEngine: specific DENY first). Names are
// the live catalog's (tools-service ToolSchemaService / Prism's
// InternalToolRegistry, 2026-09-22); tools-service names absent from the
// shared TOOL_NAMES are spelled out.
const LUPOS_DENIED_TOOLS = [
  // Shell and command execution — the python/js sandboxes are his.
  TOOL_NAMES.EXECUTE_SHELL,
  TOOL_NAMES.EXECUTE_COMMAND,
  // Dispatchers that run other tools out of sight.
  ASYNC_TASK_TOOL_NAMES.RUN_ASYNC_TASK,
  LOCAL_TOOL_NAMES.RUN_TOOL_PROGRAM,
  // Sub-agents and the agent definitions they would run as.
  TOOL_NAMES.CREATE_SUBAGENT,
  TOOL_NAMES.CREATE_SUBAGENTS,
  TOOL_NAMES.SEND_SUBAGENT_MESSAGE,
  TOOL_NAMES.RESUME_SUBAGENT,
  TOOL_NAMES.CREATE_CUSTOM_AGENT,
  TOOL_NAMES.UPDATE_CUSTOM_AGENT,
  // Skills — stored, then executed with the owner's tools.
  TOOL_NAMES.CREATE_SKILL,
  TOOL_NAMES.EXECUTE_SKILL,
  TOOL_NAMES.DELETE_SKILL,
  // Persistent writes to the owner's project state.
  LOCAL_TOOL_NAMES.WRITE_DATASTORE,
  LOCAL_TOOL_NAMES.DELETE_DATASTORE,
  LOCAL_TOOL_NAMES.UPDATE_PROJECT_INSTRUCTIONS,
  LOCAL_TOOL_NAMES.EDIT_PROJECT_INSTRUCTIONS,
  // Timers and schedules wake the owner's Prism later; a Discord reminder
  // is schedule_discord_reminder, which pings only the asker.
  TOOL_NAMES.SET_TIMER,
  TOOL_NAMES.CANCEL_TIMER,
  TOOL_NAMES.CREATE_CRON_JOB,
  TOOL_NAMES.DELETE_CRON_JOB,
  TOOL_NAMES.TRIGGER_CRON_JOB,
  // Its question card would park the turn in prism-client, where nobody
  // in the channel can answer it.
  TOOL_NAMES.ASK_USER,
  // The owner's own accounts and home (Communication, Music, Smart Home).
  "send_email",
  "send_sms",
  "send_push_notification",
  "send_webhook",
  TOOL_NAMES.CONTROL_SPOTIFY,
  "set_light_state",
  "set_light_states",
  "adjust_light_state",
  "toggle_light_power",
  TOOL_NAMES.LIFX_BREATHE_EFFECT,
  TOOL_NAMES.LIFX_PULSE_EFFECT,
  "start_light_move_effect",
  "start_light_flame_effect",
  "start_light_morph_effect",
  "stop_light_effects",
  "paint_lights_from_image",
  "activate_light_scene",
  "enable_light_night_lock",
];

// ────────────────────────────────────────────────────────────
// Tool Policies — allow list (least privilege)
// ────────────────────────────────────────────────────────────
// His turns are pinned to `dontAsk` (pinnedPermissionMode below): a request's
// autoApprove or permissionMode no longer widens them, and a call runs
// without a person only when its tier is AUTO or an APPROVE rule here names
// it. Anything else his tier would put on an approval card is refused with
// the don't-ask message, which the model reads and answers around.
//
// Every tools-service tool AutoApprovalEngine does not map is WRITE tier,
// so this is most of his reachable universe: enabledByDefaultTools plus
// what discovery may activate (availableTools minus blockedTools) — 160
// tools on the 2026-09-22 catalog, of which only search_web, read_web_page,
// retrieve_offloaded_content and the four discovery tools are AUTO. Left
// out, so refused:
//   - get_ip_info — with no argument it looks up the server's own IP: the
//     owner's address, city and ISP, handed to anyone in a channel.
// A tool tools-service later files under one of his domains is refused
// until it is listed here — new reach for a public bot is a decision, not
// a side effect of a catalog sync.
const LUPOS_ALLOWED_TOOLS = [
  // Discord — his own reach into the channel. Reads are scoped by
  // tools-service to the conversation's guild and the channels the
  // requester can see; actions carry lupos-bot's caps (round-1 contract).
  "react_to_discord_message",
  "search_discord_messages",
  "get_discord_user_profile",
  "get_discord_guild_members",
  "get_discord_guild_channels",
  "get_discord_guild_emojis",
  "get_discord_voice_channel_members",
  "get_discord_channel_activity_stats",
  "get_discord_server_activity",
  "get_discord_message_analytics",
  "get_discord_message_leaderboard",
  "get_discord_mention_leaderboard",
  "get_discord_user_heatmap_data",
  "get_discord_word_frequencies",
  "get_bot_guilds",
  "get_bot_stats",
  "get_bot_activity_timeline",
  "create_discord_poll",
  "create_discord_thread",
  "schedule_discord_reminder",
  "list_discord_reminders",
  "cancel_discord_reminder",
  "set_discord_nickname",
  // Gold — the hoard (capped per requester and per day by lupos-bot).
  "get_discord_gold_balance",
  "give_discord_gold",
  "mug_discord_gold",
  // Sandboxes and scratch reasoning (DANGER / WRITE tier by default).
  TOOL_NAMES.EXECUTE_PYTHON,
  TOOL_NAMES.EXECUTE_JAVASCRIPT,
  TOOL_NAMES.CALCULATE_PRECISE,
  TOOL_NAMES.THINK,
  // Web reads beyond the AUTO-tier search_web / read_web_page.
  TOOL_NAMES.READ_URL,
  "search_news",
  "search_images",
  "search_videos",
  "read_pdf",
  "read_docx",
  "read_csv",
  "read_spreadsheet",
  "read_image_text",
  "read_rss_feed",
  "get_wayback_snapshot",
  // Images, audio and video — making and editing what Discord can attach.
  TOOL_NAMES.GENERATE_IMAGE,
  "manipulate_image",
  "remove_background",
  "describe_image",
  "detect_objects",
  "scan_barcode",
  "generate_qr_code",
  "generate_avatar",
  "generate_ascii_banner",
  "render_code",
  "convert_color",
  "get_emoji_combination",
  "get_emoji_combinations",
  "generate_chart",
  TOOL_NAMES.GENERATE_AUDIO,
  "remix_audio",
  TOOL_NAMES.SYNTHESIZE_SPEECH,
  "synthesize_speech_local",
  "transcribe_audio",
  TOOL_NAMES.TRIM_VIDEO,
  "download_video",
  "convert_video_to_gif",
  // Pure computation.
  "analyze_csv",
  "compare_json",
  "convert_encoding",
  "convert_units",
  "diff_text",
  "generate_csv",
  "generate_hash",
  "parse_cron_expression",
  "parse_datetime",
  "test_regex",
  "transform_json",
  "validate_json_schema",
  // Read-only lookups across his granted domains: knowledge, film and TV,
  // music, Reddit, games, weather and space, events, trends, shopping,
  // markets, places and time.
  "get_anime",
  "get_country",
  "get_element",
  "get_exoplanet",
  "get_music",
  "get_on_this_day",
  "get_package_info",
  "get_pypi_package",
  "get_spotify",
  TOOL_NAMES.SEARCH_SPOTIFY,
  "get_stackoverflow_questions",
  "get_wikipedia_summary",
  "get_word_definition",
  "get_youtube_video",
  "search_youtube",
  "list_development_indicators",
  "search_books",
  "search_library_docs",
  "search_papers",
  "search_patents",
  "search_autotrader",
  "search_craigslist",
  "search_kijiji",
  "browse_media",
  "search_media",
  "search_person",
  "get_media_details",
  "get_media_credits",
  "get_media_genres",
  "get_media_recommendations",
  "get_now_playing_media",
  "get_trending_media",
  "get_watch_providers",
  "search_reddit",
  "search_reddit_subreddits",
  "get_reddit_subreddit_feed",
  "get_reddit_subreddit_info",
  "get_reddit_subreddit_rules",
  "get_reddit_subreddit_wiki_page",
  "get_reddit_subreddit_wiki_pages",
  "get_reddit_user_history",
  "get_reddit_user_profile",
  "get_dota",
  "get_steam_profile",
  "get_weather",
  "get_weather_forecast",
  "get_local_environment",
  "get_detailed_air_quality",
  "get_canada_weather_warnings",
  "get_canada_avalanche_forecast",
  "get_earthquakes",
  "get_wildfires",
  "get_tides",
  "get_twilight",
  "get_moon_phase",
  "get_aurora_forecast",
  "get_solar_activity",
  "get_solar_wind",
  "get_satellite_imagery",
  "get_iss_location",
  "get_near_earth_objects",
  "get_space_launches",
  "get_nasa_apod",
  "get_events",
  "get_trends",
  "get_github_trending",
  TOOL_NAMES.SEARCH_PRODUCTS,
  TOOL_NAMES.GET_TRENDING_PRODUCTS,
  TOOL_NAMES.GET_STOCK,
  TOOL_NAMES.GET_FEAR_GREED_INDEX,
  TOOL_NAMES.GET_POLLEN_FORECAST,
  "convert_currency",
  "get_time_in_timezone",
  "search_places",
  "search_nearby_places",
  "search_airports",
  "get_public_webcams",
];

const LUPOS_POLICIES: PolicyRule[] = [
  ...LUPOS_DENIED_TOOLS.map((toolName) => deny(toolName)),
  ...LUPOS_ALLOWED_TOOLS.map((toolName) => allow(toolName)),
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
    // Skills and tasks: coding-agent scaffolding, 0 calls in 30 days of
    // Discord replies (see LUPOS_UNUSED_CORE_HARNESS_TOOLS).
    DOMAIN_KEY_TAGS.CORE_SKILL,
    DOMAIN_KEY_TAGS.CORE_TASK,
    ...LUPOS_UNUSED_CORE_HARNESS_TOOLS,
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
  // innate discovery or pre-flight (same shape as Omni). The exceptions
  // are the tools pre-flight cannot find in time: it matches the catalog
  // against the user's message text, so a tool that fires on being
  // insulted or charmed — words that never name it — is unreachable in
  // exactly the moments it exists for, and a tool his own prompt tells him
  // to call should not cost a discovery round to obey.
  //   - react_to_discord_message replaces lupos-bot's old unconditional
  //     per-reply emoji reaction.
  //   - The gold trio backs the Gold Rules policy section: mugging keys
  //     off rudeness, gifting off kindness. That section is the only
  //     place the wolf is told the economy exists at all, and it is
  //     `requires`-gated on these three, so leaving them to discovery
  //     left him unaware of his own hoard on every turn.
  //   - generate_image is half his traffic, and the commonest request —
  //     an edit of an image already in the channel ("now make it gay",
  //     "switch the weapon") — never names a drawing verb for pre-flight
  //     to match. Left to discovery, 73% of image turns (2026-08-23 →
  //     09-22) spent a whole model call on discover_and_enable_tools
  //     first: 18% of his iteration cost, several seconds each.
  //   - get_discord_user_profile is what his own Discord IDs block and
  //     Participant Context section tell him to call for anyone beyond the
  //     one-line roster; left to discovery, following that instruction
  //     cost a discovery round first.
  //   - search_discord_messages answers "what did X say" / "who said Y",
  //     the channel's commonest lookup, and gates the Discord History
  //     section that teaches its count/compact modes.
  enabledByDefaultTools: [
    "react_to_discord_message",
    "get_discord_gold_balance",
    "give_discord_gold",
    "mug_discord_gold",
    "generate_image",
    "get_discord_user_profile",
    "search_discord_messages",
  ],
  policies: LUPOS_POLICIES,
  // Least privilege (see the allow list above): no request widens his turns,
  // and nothing he calls waits on a card nobody in the channel can answer.
  pinnedPermissionMode: "dontAsk",
  // A reaction sent with the reply ends the turn: nothing in the reaction's
  // `{ ok: true }` is worth another model call (EndTurnAfterTools). His
  // Emoji Reactions section tells him to write the reply in that response.
  endTurnAfterTools: ["react_to_discord_message"],
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
