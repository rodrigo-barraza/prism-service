import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { DOMAIN_KEY_TAGS, TOOL_NAMES } from "../ToolTaxonomyConstants.ts";
import { Persona, ToolPolicySection } from "./types.ts";
import { buildToolPolicy } from "./utils.ts";
import PromptLocaleService from "../PromptLocaleService.ts";

const STICKERS_TOOL_POLICY_SECTIONS: ToolPolicySection[] = [
  {
    content: (locale) => PromptLocaleService.get(locale, "personas.stickers.toolPolicyBase"),
  },
  {
    content: (locale) => PromptLocaleService.get(locale, "personas.stickers.toolPolicyImage"),
    requires: [TOOL_NAMES.GENERATE_IMAGE],
  },
];

const STICKERS_AVAILABLE_TOOLS = [
  DOMAIN_KEY_TAGS.CREATIVE,
  DOMAIN_KEY_TAGS.WEB,
];

export const StickersPersona: Persona = {
  id: AGENT_IDS.STICKERS,
  name: "Clankerbox",
  type: "",
  description: PromptLocaleService.get("en", "personas.stickers.description"),
  project: "prism-chat",
  avatar: "/clankerbox-agent-avatar.png",
  identity: (context) => {
    const activeLocale = context.locale || "en";
    const sections = [
      PromptLocaleService.get(activeLocale, "personas.stickers.corePersonality"),
      PromptLocaleService.get(activeLocale, "personas.stickers.physicalDescription"),
      PromptLocaleService.get(activeLocale, "personas.stickers.abilities"),
      PromptLocaleService.get(activeLocale, "personas.stickers.languageRules"),
      PromptLocaleService.get(activeLocale, "personas.stickers.behaviourPatterns"),
      PromptLocaleService.get(activeLocale, "personas.stickers.grammarRules"),
      PromptLocaleService.get(activeLocale, "personas.stickers.objectDetectionRules"),
      PromptLocaleService.get(activeLocale, "personas.stickers.interactionProtocol"),
      PromptLocaleService.get(activeLocale, "personas.stickers.interactionRules"),
    ];

    return sections.join("\n\n");
  },
  guidelines: "",
  interactionRules: "",
  toolPolicy: (context) =>
    buildToolPolicy(STICKERS_TOOL_POLICY_SECTIONS, context),
  availableTools: STICKERS_AVAILABLE_TOOLS,
  capabilities: "",
  usesDirectoryTree: false,
  usesCodingGuidelines: false,
};
