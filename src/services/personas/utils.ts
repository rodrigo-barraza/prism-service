import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { PersonaContext, ToolPolicySection } from "./types.ts";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";

// ────────────────────────────────────────────────────────────
// Tool Catalog Introspection Helpers
// ────────────────────────────────────────────────────────────
// Derive domain lists, representative keywords, and trigger examples
// from the live tool catalog at runtime. Used by the persona system
// prompt and the discover_and_enable_tools schema to stay in sync
// with the actual tools-service catalog — no hardcoded lists.

/**
 * Whether a domain represents always-on system tooling (not discoverable).
 * Core domains are excluded from discovery prompts since they're always enabled.
 */
function isDiscoverableDomain(domain: string): boolean {
  return !domain.startsWith("Core ");
}

/**
 * Extract unique discoverable domain names from the tool catalog.
 * Filters out always-on system domains (Core Workspace, Core Harness, etc.)
 * Returns a sorted array of domain display names.
 */
export function extractDiscoverableDomains(): string[] {
  const schemas = ToolOrchestratorService.getClientToolSchemas();
  const domainSet = new Set<string>();
  for (const schema of schemas) {
    const domain = (schema as Record<string, unknown>).domain as
      | string
      | undefined;
    if (domain && isDiscoverableDomain(domain)) {
      domainSet.add(domain);
    }
  }
  return [...domainSet].sort();
}

/**
 * Build a map of domain → representative humanized tool keywords.
 * Takes up to `maxPerDomain` keywords per domain for concise display.
 * Keywords are derived from tool names with verb prefixes stripped.
 */
export function extractDomainKeywords(maxPerDomain = 4): Map<string, string[]> {
  const schemas = ToolOrchestratorService.getClientToolSchemas();
  const domainToolKeywords = new Map<string, string[]>();
  for (const schema of schemas) {
    const domain = (schema as Record<string, unknown>).domain as
      | string
      | undefined;
    const toolName = schema.name as string;
    if (domain && isDiscoverableDomain(domain) && toolName) {
      if (!domainToolKeywords.has(domain)) {
        domainToolKeywords.set(domain, []);
      }
      const keywords = domainToolKeywords.get(domain)!;
      if (keywords.length < maxPerDomain) {
        keywords.push(toolName.replace(/_/g, " "));
      }
    }
  }
  return domainToolKeywords;
}

// ────────────────────────────────────────────────────────────
// Tool Discovery System Prompt Section
// ────────────────────────────────────────────────────────────

/**
 * Build the tool discovery system prompt section at runtime.
 * Domain list, tool count, and trigger examples are all derived
 * from the live catalog — nothing is hardcoded.
 */
function buildToolDiscoveryContent(): string {
  const totalToolCount = ToolOrchestratorService.getClientToolSchemas().length;
  const discoverableDomains = extractDiscoverableDomains();
  const domainList = discoverableDomains.join(", ");

  const domainKeywords = extractDomainKeywords(4);
  const triggerExampleLines = [...domainKeywords.entries()]
    .map(([domain, keywords]) => {
      const quotedKeywords = keywords
        .map((keyword) => `"${keyword}"`)
        .join(", ");
      return `- ${quotedKeywords} → search for ${domain} tools`;
    })
    .join("\n");

  return `## Tool Discovery (CRITICAL)
You have access to ${totalToolCount} tools, but only a small subset is enabled by default. The rest span dozens of specialized domains and MUST be discovered and activated before use.

**Available Tool Domains:**
${domainList}

**RULE: When the user asks for ANY capability and you do NOT see a matching tool in your current enabled set — ALWAYS search before responding.**
1. Call \`discover_and_enable_tools\` with a relevant query — this searches the full catalog AND enables matches in one step
2. Alternatively, call \`search_tools\` to browse available tools, then call \`enable_tools\` to activate the ones you need
3. After enabling, the tools become available on your next iteration — call them directly

**NEVER fall back to writing raw code, scripts, or manual API calls when a dedicated tool may exist.** Always search first.

**How to decide when to search — match by CAPABILITY INTENT, not just keywords:**
- User mentions a domain, protocol, or data type you don't have a tool for → search for it
- User asks about something that sounds like it could be a specialized API → search for it
- User asks to "look up", "check", "scan", "analyze", "convert", "generate", or "get info about" anything beyond basic text/code → search for it
- When in doubt, search — it costs nothing and takes one call

**Trigger examples (derived from tool catalog, not exhaustive):**
${triggerExampleLines}`;
}

const TOOL_DISCOVERY_POLICY_SECTION: ToolPolicySection & {
  dynamicContent?: () => string;
} = {
  content: "",
  dynamicContent: buildToolDiscoveryContent,
  requires: [TOOL_NAMES.SEARCH_TOOLS],
};
// ────────────────────────────────────────────────────────────
// Shared Tool Policy Sections (auto-injected for all personas)
// ────────────────────────────────────────────────────────────

const GENERAL_TOOL_PRINCIPLES_SECTION: ToolPolicySection = {
  content: `# Tool Use Principles
- Chain tools when a question requires multiple data sources
- Prefer specific tools over generic web search when available
- Use the right granularity: don't use heavy tools for simple questions`,
};

const TASK_MANAGEMENT_POLICY_SECTION: ToolPolicySection = {
  content: `## Task Management
You have persistent task tools (create_task, list_tasks, update_task) that survive across conversations.
Use them proactively:
- At the START of a session, call list_tasks to check for in-progress or pending tasks from prior sessions
- When starting complex multi-step work (3+ files, multi-phase refactors, migrations), create a task with create_task to track progress
- ONLY mark a task as completed when you have FULLY accomplished it — if blocked or encountering errors, keep it as in_progress
- Always set activeForm when creating or updating to "in_progress" — a present-continuous phrase shown as a spinner (e.g. "Running tests", "Refactoring auth module")
- After completing a task, call list_tasks to find your next task
- To delete a task that is no longer relevant or was created in error, set its status to "deleted" via update_task
- Break large tasks into subtasks — use metadata to link related tasks
- Do NOT create tasks for simple, single-step requests — only for work that benefits from tracking`,
  requires: [
    TOOL_NAMES.CREATE_TASK,
    TOOL_NAMES.LIST_TASKS,
    TOOL_NAMES.UPDATE_TASK,
  ],
};

const PROACTIVE_MEMORY_POLICY_SECTION: ToolPolicySection = {
  content: `## Proactive Memory
You have a persistent memory tool (save_memory) that stores facts across sessions.
Use it **proactively** — do NOT wait for the user to say "remember":
- When the user states a preference: "I like X", "I hate Y", "I prefer Z", "I always do W"
- When the user reveals personal info: allergies, habits, identity traits, opinions
- When the user corrects you: save the correction so you don't repeat the mistake
- When you learn a project convention or workflow pattern worth preserving
- **When in doubt, save it** — over-remembering is better than forgetting
- Set type to "user" for personal preferences, "feedback" for corrections, "project" for codebase conventions`,
  requires: [TOOL_NAMES.SAVE_MEMORY],
};

// ────────────────────────────────────────────────────────────
// Shared Tool Policy Builder
// ────────────────────────────────────────────────────────────

/**
 * Shared conditional tool policy builder used by all agent personas.
 *
 * Iterates over a declarative section list and only includes sections
 * whose `requires` tools are present in the resolved `enabledTools`.
 * This ensures the system prompt never references tools the model
 * cannot actually call, saving tokens and preventing hallucinated
 * tool calls.
 *
 * Automatically prepends shared innate sections so every agent gets
 * them without per-persona opt-in:
 * - Tool Discovery (how to search for and enable tools)
 * - Task Management (proactive task tracking)
 * - Proactive Memory (auto-save user preferences)
 */
export function buildToolPolicy(
  sections: ToolPolicySection[],
  context: PersonaContext,
): string {
  const allSections = [
    GENERAL_TOOL_PRINCIPLES_SECTION,
    TOOL_DISCOVERY_POLICY_SECTION,
    TASK_MANAGEMENT_POLICY_SECTION,
    PROACTIVE_MEMORY_POLICY_SECTION,
    ...sections,
  ];
  const enabled = new Set(context.enabledTools || []);
  const enabledArray = [...enabled];

  const filtered = allSections.filter((section) => {
    if (!section.requires || section.requires.length === 0) return true;
    return section.requires.some((requirement) => {
      if (requirement.endsWith("*")) {
        const prefix = requirement.slice(0, -1);
        return enabledArray.some((toolName) => toolName.startsWith(prefix));
      }
      return enabled.has(requirement);
    });
  });

  return filtered
    .map((section) => {
      const dynamicSection = section as ToolPolicySection & {
        dynamicContent?: () => string;
      };
      if (dynamicSection.dynamicContent) return dynamicSection.dynamicContent();
      return section.content;
    })
    .join("\n\n");
}
