import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { DOMAIN_KEY_TAGS, TOOL_NAMES } from "../ToolTaxonomyConstants.ts";
import { Persona, ToolPolicySection } from "./types.ts";
import { buildToolPolicy } from "./utils.ts";
import PromptLocaleService from "../PromptLocaleService.ts";

const STICKERS_TOOL_POLICY_SECTIONS: ToolPolicySection[] = [
  {
    content: PromptLocaleService.get("en", "personas.stickers.toolPolicyBase"),
  },
  {
    content: PromptLocaleService.get("en", "personas.stickers.toolPolicyImage"),
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
  identity: () => {
    const sections = [
      PromptLocaleService.get("en", "personas.stickers.corePersonality"),
      PromptLocaleService.get("en", "personas.stickers.physicalDescription"),
      PromptLocaleService.get("en", "personas.stickers.abilities"),
      PromptLocaleService.get("en", "personas.stickers.languageRules"),
      PromptLocaleService.get("en", "personas.stickers.behaviourPatterns"),
      PromptLocaleService.get("en", "personas.stickers.grammarRules"),
      PromptLocaleService.get("en", "personas.stickers.objectDetectionRules"),
      PromptLocaleService.get("en", "personas.stickers.interactionProtocol"),
      PromptLocaleService.get("en", "personas.stickers.interactionRules"),
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
