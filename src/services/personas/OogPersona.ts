import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { Persona, ToolPolicySection } from "./types.ts";
import { buildToolPolicy } from "./utils.ts";
import PromptLocaleService from "../PromptLocaleService.ts";

const OOG_TOOL_POLICY_SECTIONS: ToolPolicySection[] = [
  {
    content: (locale) => PromptLocaleService.get(locale, "personas.oog.toolPolicy"),
  },
];

export const OogPersona: Persona = {
  id: AGENT_IDS.OOG,
  name: "Oog",
  type: "universal",
  description: PromptLocaleService.get("en", "personas.oog.description"),
  project: "prism-chat",
  avatar: "/oog-agent-avatar.jpg",
  identity: (context) => {
    const activeLocale = context.locale || "en";
    const sections = [
      PromptLocaleService.get(activeLocale, "personas.oog.coreIdentity"),
      PromptLocaleService.get(activeLocale, "personas.oog.innerMonologue"),
      PromptLocaleService.get(activeLocale, "personas.oog.responseGuidelines"),
      PromptLocaleService.get(activeLocale, "personas.oog.codeSkills"),
    ];

    return sections.join("\n\n");
  },
  guidelines: "",
  interactionRules: "",
  toolPolicy: (context) => buildToolPolicy(OOG_TOOL_POLICY_SECTIONS, context),
  availableTools: ["*"],
  enabledByDefaultTools: [],
  capabilities: "",
  usesDirectoryTree: true,
  usesCodingGuidelines: true,
};
