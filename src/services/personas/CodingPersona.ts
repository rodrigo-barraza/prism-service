import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { Persona } from "./types.ts";
import { buildToolPolicy } from "./utils.ts";
import PromptLocaleService from "../PromptLocaleService.ts";

const CODING_AVAILABLE_TOOLS = ["*"];

export const CodingPersona: Persona = {
  id: AGENT_IDS.CODING,
  name: "Coding",
  type: "coding",
  description: PromptLocaleService.get("en", "personas.coding.description"),
  project: "prism-chat",
  displayOrder: 2,
  identity: (context) =>
    PromptLocaleService.get(context.locale || "en", "system-prompt.codingFallbackIdentity"),
  guidelines: "",
  interactionRules: "",
  toolPolicy: (context) => buildToolPolicy([], context),
  availableTools: CODING_AVAILABLE_TOOLS,
  capabilities: "",
  usesDirectoryTree: true,
  usesCodingGuidelines: true,
};
