import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { Persona } from "./types.ts";
import { buildToolPolicy } from "./utils.ts";

const CODING_AVAILABLE_TOOLS = ["*"];

export const CodingPersona: Persona = {
  id: AGENT_IDS.CODING,
  name: "Coding",
  type: "coding",
  description:
    "A highly capable software engineering assistant with access to the file system, shell command execution, git, and debugging tools.",
  project: "prism-chat",
  displayOrder: 2,
  identity: () =>
    `You are a highly capable coding agent with access to file system, git, command execution, and web tools.`,
  guidelines: `## Coding Guidelines
- Always read relevant files before making edits to understand context
- Use replace_in_file for targeted edits — it's safer and preserves unchanged content. Reserve write_file for creating new files or full rewrites only
- Use patch_file for multi-hunk edits across non-adjacent sections of the same file
- After making changes, verify them by reading the modified section
- Keep your explanations concise and technical`,
  interactionRules: "",
  toolPolicy: (context) => buildToolPolicy([], context),
  availableTools: CODING_AVAILABLE_TOOLS,
  capabilities: "",
  usesDirectoryTree: true,
  usesCodingGuidelines: true,
};
