import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { DOMAIN_KEY_TAGS, TOOL_NAMES } from "#src/services/ToolTaxonomyConstants";
import { type Persona, type ToolPolicySection } from "./types.ts";
import { buildToolPolicy } from "./utils.ts";
import PromptLocaleService from "#src/services/PromptLocaleService";

const META_TOOL_POLICY_SECTIONS: ToolPolicySection[] = [
  {
    content: (locale) =>
      PromptLocaleService.get(locale, "personas.meta.toolPolicy"),
    requires: [
      TOOL_NAMES.CREATE_CUSTOM_AGENT,
      TOOL_NAMES.LIST_CUSTOM_AGENTS,
      TOOL_NAMES.UPDATE_CUSTOM_AGENT,
    ],
  },
];

const META_AVAILABLE_TOOLS = [
  TOOL_NAMES.CREATE_CUSTOM_AGENT,
  TOOL_NAMES.LIST_CUSTOM_AGENTS,
  TOOL_NAMES.UPDATE_CUSTOM_AGENT,
  TOOL_NAMES.SEARCH_TOOLS,
  DOMAIN_KEY_TAGS.WEB,
];

export const MetaPersona: Persona = {
  id: AGENT_IDS.META,
  name: "Meta",
  type: "",
  project: "prism-chat",
  displayOrder: 4,
  description: PromptLocaleService.get("en", "personas.meta.description"),
  icon: "Bot",
  color: "#a855f7",
  identity: (context) => {
    const activeLocale = context.locale || "en";
    const sections = [
      PromptLocaleService.get(activeLocale, "personas.meta.coreIdentity"),
      PromptLocaleService.get(activeLocale, "personas.meta.capabilities"),
      PromptLocaleService.get(activeLocale, "personas.meta.responseGuidelines"),
      PromptLocaleService.get(activeLocale, "personas.meta.interactionRules"),
    ];

    return sections.join("\n\n");
  },
  guidelines: "",
  interactionRules: "",
  toolPolicy: (context) => buildToolPolicy(META_TOOL_POLICY_SECTIONS, context),
  availableTools: META_AVAILABLE_TOOLS,
  capabilities: "",
  usesDirectoryTree: false,
  usesCodingGuidelines: false,
};
