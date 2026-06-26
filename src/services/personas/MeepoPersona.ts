import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { Persona } from "./types.ts";
import PromptLocaleService from "../PromptLocaleService.ts";

export const MeepoPersona: Persona = {
  id: AGENT_IDS.MEEPO,
  name: "Meepo",
  type: "conversational",
  description: PromptLocaleService.get("en", "personas.meepo.description"),
  project: "prism-chat",
  identity: () => {
    const sections = [
      PromptLocaleService.get("en", "personas.meepo.corePersonality"),
      PromptLocaleService.get("en", "personas.meepo.responseGuidelines"),
      PromptLocaleService.get("en", "personas.meepo.interactionRules"),
    ];

    return sections.join("\n\n");
  },
  guidelines: "",
  interactionRules: "",
  toolPolicy: "",
  availableTools: [],
  capabilities: "",
  usesDirectoryTree: false,
  usesCodingGuidelines: false,
};
