import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { DOMAIN_KEY_TAGS, TOOL_NAMES } from "../ToolTaxonomyConstants.ts";
import { Persona, ToolPolicySection } from "./types.ts";
import { buildToolPolicy } from "./utils.ts";
import PromptLocaleService from "../PromptLocaleService.ts";

const LIGHTS_TOOL_POLICY_SECTIONS: ToolPolicySection[] = [
  {
    content: (locale) => PromptLocaleService.get(locale, "personas.lights.toolPolicyCore"),
    requires: ["list_lights"],
  },
  {
    content: (locale) => PromptLocaleService.get(locale, "personas.lights.toolPolicyEffects"),
    requires: [TOOL_NAMES.LIFX_BREATHE_EFFECT, TOOL_NAMES.LIFX_PULSE_EFFECT],
  },
  {
    content: (locale) => PromptLocaleService.get(locale, "personas.lights.toolPolicyNotes"),
    requires: ["list_lights"],
  },
];

const LIGHTS_AVAILABLE_TOOLS = [
  DOMAIN_KEY_TAGS.SMART_HOME,
  DOMAIN_KEY_TAGS.WEB,
  TOOL_NAMES.GET_WEATHER,
];

export const LightsPersona: Persona = {
  id: AGENT_IDS.LIGHTS,
  name: "Lights",
  type: "home",
  description: PromptLocaleService.get("en", "personas.lights.description"),
  project: "prism-chat",
  identity: (context) => {
    const activeLocale = context.locale || "en";
    const sections = [
      PromptLocaleService.get(activeLocale, "personas.lights.coreIdentity"),
      PromptLocaleService.get(activeLocale, "personas.lights.colorReference"),
      PromptLocaleService.get(activeLocale, "personas.lights.responseGuidelines"),
    ];

    return sections.join("\n\n");
  },
  guidelines: "",
  interactionRules: "",
  toolPolicy: (context) =>
    buildToolPolicy(LIGHTS_TOOL_POLICY_SECTIONS, context),
  availableTools: LIGHTS_AVAILABLE_TOOLS,
  capabilities: "",
  usesDirectoryTree: false,
  usesCodingGuidelines: false,
};
