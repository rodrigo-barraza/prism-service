import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { Persona } from "./types.ts";
import { buildToolPolicy } from "./utils.ts";
import PromptLocaleService from "../PromptLocaleService.ts";

export const OmniPersona: Persona = {
  id: AGENT_IDS.OMNI,
  name: "Omni",
  type: "universal",
  description: PromptLocaleService.get("en", "personas.omni.description"),
  project: "prism-chat",
  displayOrder: 1,
  identity: () => {
    const sections = [
      PromptLocaleService.get("en", "personas.omni.coreIdentity"),
      PromptLocaleService.get("en", "personas.omni.responseGuidelines"),
    ];

    return sections.join("\n\n");
  },
  guidelines: PromptLocaleService.get("en", "personas.omni.guidelines"),
  interactionRules: "",
  toolPolicy: (context) => buildToolPolicy([], context),
  availableTools: ["*"],
  enabledByDefaultTools: [],
  capabilities: "",
  usesDirectoryTree: true,
  usesCodingGuidelines: true,
};
