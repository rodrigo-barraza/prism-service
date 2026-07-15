import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { Persona } from "./types.ts";
import { buildToolPolicy } from "./utils.ts";
import PromptLocaleService from "#src/services/PromptLocaleService";

export const BenderPersona: Persona = {
  id: AGENT_IDS.BENDER,
  name: "Bender",
  type: "universal",
  description: PromptLocaleService.get("en", "personas.bender.description"),
  avatar: "/bender-agent-avatar.jpg",
  project: "prism-chat",
  displayOrder: 5,
  identity: (context) => {
    const activeLocale = context.locale || "en";
    const sections = [
      PromptLocaleService.get(activeLocale, "personas.bender.coreIdentity"),
      PromptLocaleService.get(
        activeLocale,
        "personas.bender.responseGuidelines",
      ),
    ];

    return sections.join("\n\n");
  },
  guidelines: "",
  interactionRules: "",
  toolPolicy: (context) => buildToolPolicy([], context),
  availableTools: ["*"],
  enabledByDefaultTools: [],
  capabilities: "",
  usesDirectoryTree: true,
  usesCodingGuidelines: true,
};
