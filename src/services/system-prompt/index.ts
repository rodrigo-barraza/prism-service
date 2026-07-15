import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  getOrchestratorPromptAddendum,
  ORCHESTRATOR_ONLY_TOOLS,
} from "#src/services/OrchestratorPrompt";
import { resolveToolEntriesToSet } from "#src/utils/resolveToolEntriesToSet";
import { resolveLockedOffToolNames } from "#src/utils/resolveLockedOffToolNames";
import SettingsService from "#src/services/SettingsService";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import {
  AGENT_IDS,
  DEFAULT_TOPOLOGY,
  DOMAINS,
  CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST,
  isCoreDomain,
} from "@rodrigo-barraza/utilities-library/taxonomy";

const CORE_AGENTIC_TOOLS = new Set<string>(CORE_AGENTIC_TOOLS_LIST);

import { DirectoryTreeFormatter } from "./DirectoryTreeFormatter.ts";
import { ToolDocFormatter, type ToolDocMode } from "./ToolDocFormatter.ts";
import { SkillMemoryScorer } from "./SkillMemoryScorer.ts";
import { AssemblerContext } from "./types.ts";
import SomaticStateService, {
  type SomaticStateEvent,
} from "#src/services/somatic/SomaticStateService";
import ResponseVarietyService from "#src/services/ResponseVarietyService";
import WorkflowMemoryService from "#src/services/WorkflowMemoryService";
import { SYSTEM_PROMPT_SECTIONS, COLLECTIONS } from "#src/constants";
import PromptLocaleService from "#src/services/PromptLocaleService";
import {
  SYSTEM_MESSAGE_TAGS,
  wrapSystemMessage,
  wrapTag,
} from "#src/utils/SystemMessageTags";

/**
 * Wrap a system prompt section in XML semantic tags.
 *
 * XML delimiters give models explicit structural boundaries for attention,
 * reducing "instruction bleed" where the model confuses which section a
 * constraint belongs to. The content inside the tags is preserved verbatim,
 * so existing substring assertions in tests continue to pass.
 *
 * Delegates to wrapTag so system prompt sections and mid-conversation
 * system messages share one canonical tag format.
 */
function wrapSection(tagName: string, content: string): string {
  return wrapTag(tagName, content);
}


/**
 * Retrieve the memory IDs already injected into this conversation across
 * all prior turns. Uses a targeted single-field projection so we never
 * load the full messages array. Returns an empty Set when the conversation
 * doesn't exist yet or has no injected memories recorded.
 */
/**
 * Fetch the enabled rules matching the names the client pinned to this
 * turn. Scoped to project + username like RulesRoutes; only `enabled`
 * rules are injected regardless of what the client claims.
 */
async function fetchActiveRules(
  project: string | null | undefined,
  username: string | undefined,
  names: string[],
): Promise<Array<{ name: string; content: string }>> {
  try {
    const collection = MongoWrapper.getCollection(
      MONGO_DB_NAME,
      COLLECTIONS.AGENT_RULES,
    );
    const rules = await collection
      .find(
        {
          project: project || "any",
          username: username || "any",
          name: { $in: names },
          enabled: true,
        },
        { projection: { name: 1, content: 1, _id: 0 } },
      )
      .toArray();
    return rules as unknown as Array<{ name: string; content: string }>;
  } catch (error: unknown) {
    logger.warn(
      `[SystemPromptAssembler] Could not load active rules [${names.join(", ")}]: ${getErrorMessage(error)}`,
    );
    return [];
  }
}

async function fetchAlreadyInjectedMemoryIds(
  conversationId: string | null | undefined,
): Promise<Set<string>> {
  if (!conversationId) return new Set();
  try {
    const collection = MongoWrapper.getCollection(
      MONGO_DB_NAME,
      COLLECTIONS.AGENT_CONVERSATIONS,
    );
    const document = await collection.findOne(
      { id: conversationId },
      { projection: { injectedMemoryIds: 1, _id: 0 } },
    );
    const storedIds = document?.injectedMemoryIds;
    if (!Array.isArray(storedIds) || storedIds.length === 0) return new Set();
    return new Set<string>(storedIds as string[]);
  } catch (error: unknown) {
    logger.warn(
      `[SystemPromptAssembler] Could not load injectedMemoryIds for conversation ${conversationId}: ${getErrorMessage(error)}`,
    );
    return new Set();
  }
}

export default class SystemPromptAssembler {
  workspaceRoot: string;
  private directoryFormatter: DirectoryTreeFormatter;
  private docFormatter: ToolDocFormatter;
  private scorer: SkillMemoryScorer;

  constructor(options: { workspaceRoot?: string } = {}) {
    this.workspaceRoot =
      options.workspaceRoot ||
      ToolOrchestratorService.getWorkspaceRoot() ||
      process.env.HOME ||
      "/home";
    this.directoryFormatter = new DirectoryTreeFormatter(this.workspaceRoot);
    this.docFormatter = new ToolDocFormatter();
    this.scorer = new SkillMemoryScorer();
  }

  async fetchDirectoryTree(): Promise<string> {
    return this.directoryFormatter.fetchDirectoryTree();
  }

  buildToolDescriptions(
    enabledTools?: string[],
    agentId?: string | null,
    defaultTopology?: string,
    resolvedToolNames?: string[],
    lockedOffToolNames?: Set<string>,
    mode?: boolean | ToolDocMode,
    locale = "en",
    workspaceEnabled = true,
  ): string {
    return this.docFormatter.buildToolDescriptions(
      enabledTools,
      agentId,
      defaultTopology,
      resolvedToolNames,
      lockedOffToolNames,
      mode,
      locale,
      workspaceEnabled,
    );
  }

  async assemble(context: AssemblerContext) {
    const sections: string[] = [];
    const isDirectMode = !context.agent;
    const agentId = context.agent || AGENT_IDS.CODING;
    const persona = isDirectMode ? null : AgentPersonaRegistry.get(agentId);
    const isSubAgent = !!context.parentAgentConversationId;

    const codingFallback =
      !isDirectMode && (!persona || persona.id === AGENT_IDS.CODING);

    const settings = await SettingsService.getSection("agents");
    const defaultTopology = settings?.topology || DEFAULT_TOPOLOGY;
    const locale =
      context.locale ||
      settings?.locale ||
      PromptLocaleService.getDefaultLocale();

    // ── 1. Agent Identity ────────────────────────────────────────
    if (isDirectMode) {
      sections.push(
        wrapSection(
          SYSTEM_PROMPT_SECTIONS.IDENTITY,
          PromptLocaleService.get(locale, "system-prompt.directModeIdentity"),
        ),
      );
    } else if (persona) {
      const identityText =
        typeof persona.identity === "function"
          ? persona.identity({ ...context, locale })
          : persona.identity;
      sections.push(wrapSection(SYSTEM_PROMPT_SECTIONS.IDENTITY, identityText));
    } else {
      sections.push(
        wrapSection(
          SYSTEM_PROMPT_SECTIONS.IDENTITY,
          PromptLocaleService.get(locale, "system-prompt.codingFallbackIdentity"),
        ),
      );
    }

    // ── 1b. Platform-Specific Rules ──────────────────────────────
    if (persona?.platformRules && context.agentContext?.platform) {
      const platformKey = context.agentContext.platform;
      const platformSection = persona.platformRules[platformKey];
      if (platformSection) {
        const platformText =
          typeof platformSection === "function"
            ? platformSection({ ...context, locale })
            : platformSection;
        if (platformText) sections.push(wrapSection(SYSTEM_PROMPT_SECTIONS.PLATFORM_RULES, platformText));
      }
    }

    // ── 2. Runtime Context (from caller) ──────────────────────────
    // Platform context and self context are collected into separate
    // arrays — they become distinct role:"system" messages instead of
    // being concatenated into the main system prompt.
    const platformContextSections: string[] = [];
    const selfContextSections: string[] = [];

    if (context.agentContext) {
      const agentContext = context.agentContext;

      // ── 2a. Platform Context (separate SYSTEM message) ──────────
      // Runtime platform data (server/channel/participant info, matched
      // knowledge, image captions, IDs). Injected as its own system
      // message so the LLM sees it as a distinct instruction block.
      const platformContext = agentContext.platformContext;
      if (platformContext) {
        if (platformContext.description) {
          platformContextSections.push(platformContext.description);
        }
        if (platformContext.serverContext) {
          platformContextSections.push(platformContext.serverContext);
        }
        if (platformContext.imageContext) {
          platformContextSections.push(platformContext.imageContext);
        }
        if (platformContext.ids) {
          platformContextSections.push(platformContext.ids);
        }
      }

      // Agent-specific runtime context (non-platform, non-self)
      // These remain in the main system prompt for now
      if (agentContext.clockCrewContext) {
        sections.push(agentContext.clockCrewContext);
      }
      if (agentContext.stickersContext) {
        sections.push(agentContext.stickersContext);
      }
      if (agentContext.emotionContext) {
        sections.push(agentContext.emotionContext);
      }
      if (agentContext.visualContext) {
        sections.push(agentContext.visualContext);
      }
      if (agentContext.lightsContext) {
        sections.push(agentContext.lightsContext);
      }
    }

    // ── 2b. Self Context (separate SYSTEM message) ──────────────
    // Somatic state is agent-level (not platform-level). Runs for any
    // agent with hasSomaticState, regardless of whether agentContext
    // is present. This ensures prism-client Lupos gets somatic state
    // even though only Discord sends agentContext.
    // Sub-agents are ephemeral workers — they don't maintain emotional
    // continuity, so somatic adaptation is skipped entirely.
    if (persona?.hasSomaticState && agentId && !isSubAgent) {
      let somaticEvents: SomaticStateEvent[] = [];
      const userMessages =
        context.messages?.filter((message) => message.role === "user") || [];
      const latestUserMessage = userMessages[userMessages.length - 1];
      if (latestUserMessage && typeof latestUserMessage.content === "string") {
        somaticEvents =
          (await SomaticStateService.adaptFromMessage(
            agentId,
            latestUserMessage.content,
            {
              traceId: context.traceId,
              agentConversationId: context.agentConversationId,
              endpoint: context.agentContext?.endpoint || "/agent",
              project: context.project,
              username: context.username,
            },
          )) || [];
      }

      const somaticMessage = await SomaticStateService.renderSystemMessage(
        agentId,
        locale,
        somaticEvents,
      );
      if (somaticMessage) {
        selfContextSections.push(somaticMessage);
      }
    }

    // ── 2c. Response Variety (separate SELF-CONTEXT section) ─────
    // Conversational personas hold a separate conversation per user, so
    // without this they never see what they just said to other people and
    // every reply converges on the same openers and jokes.
    if (persona?.usesResponseVariety && agentId && !isSubAgent) {
      const varietyBlock = await ResponseVarietyService.renderBlock({
        agentId,
        project: context.project || persona.project || null,
        currentConversationId:
          (context.conversationId as string | null) ||
          context.agentConversationId ||
          null,
        locale,
      });
      if (varietyBlock) {
        selfContextSections.push(varietyBlock);
      }
    }

    // ── 3. Tool Policy (persona-specific) ────────────────────────
    if (persona?.toolPolicy) {
      // _persona lets shared policy builders (buildToolPolicy) scope
      // catalog-derived content (discovery tool counts/domains) to the
      // persona's reachable universe without a registry lookup.
      const policyText =
        typeof persona.toolPolicy === "function"
          ? persona.toolPolicy({ ...context, locale, _persona: persona })
          : persona.toolPolicy;
      if (policyText) sections.push(wrapSection(SYSTEM_PROMPT_SECTIONS.TOOL_POLICY, policyText));
    }

    // Resolve once — used by sections 4 through 8 to skip workspace-specific
    // content when the client has workspace mode disabled.
    const isWorkspaceEnabled = context.workspaceEnabled !== false;

    // ── 4. Enabled Tools (domain-grouped) ──────────────────────
    {
      // Guarantee locale-specific remote tool schemas are cached
      // before the synchronous buildToolDescriptions() reads them.
      await ToolOrchestratorService.ensureSchemas(locale);
      const lockedOffToolNames = await resolveLockedOffToolNames();
      // Two-tier tool docs: the system prompt carries a one-line selection
      // index by default; full parameter schemas travel in the native tool
      // definitions, and full docs are injected on-demand when tools are
      // enabled mid-conversation. Personas can opt back into heavier
      // rendering via toolDocMode ("full" | "compact") or the legacy
      // compactToolDocs flag.
      const toolDocMode: boolean | ToolDocMode =
        persona?.toolDocMode ??
        (persona?.compactToolDocs === true ? "compact" : "index");

      // Defense-in-depth: strip workspace-domain tools from the lists
      // passed to buildToolDescriptions regardless of upstream filtering.
      // The AgenticToolResolver handles this for the harness path, but
      // the preview path (ConfigRoutes) builds its own resolvedToolNames
      // from all schemas without workspace filtering.
      let effectiveResolvedToolNames = context.resolvedToolNames;
      let effectiveEnabledTools = context.enabledTools;
      if (!isWorkspaceEnabled) {
        const workspaceDomainName = DOMAINS.CORE_WORKSPACE.displayName;
        const clientSchemas = ToolOrchestratorService.getClientToolSchemas(
          defaultTopology,
          locale,
        );
        const workspaceToolNames = new Set(
          clientSchemas
            .filter(
              (toolSchema) =>
                (toolSchema as Record<string, unknown>).domain ===
                workspaceDomainName,
            )
            .map((toolSchema) => toolSchema.name as string),
        );

        if (effectiveResolvedToolNames?.length) {
          effectiveResolvedToolNames = effectiveResolvedToolNames.filter(
            (toolName) => !workspaceToolNames.has(toolName),
          );
        }
        if (effectiveEnabledTools?.length) {
          effectiveEnabledTools = effectiveEnabledTools.filter(
            (toolName) => !workspaceToolNames.has(toolName),
          );
        }
      }

      const toolDescriptions = this.buildToolDescriptions(
        effectiveEnabledTools,
        agentId,
        defaultTopology,
        effectiveResolvedToolNames,
        lockedOffToolNames,
        toolDocMode,
        locale,
        isWorkspaceEnabled,
      );
      if (toolDescriptions) {
        let count: number;
        if (effectiveResolvedToolNames?.length) {
          count =
            lockedOffToolNames.size > 0
              ? effectiveResolvedToolNames.filter(
                  (toolName) => !lockedOffToolNames.has(toolName),
                ).length
              : effectiveResolvedToolNames.length;
        } else {
          const schemas = ToolOrchestratorService.getClientToolSchemas(
            defaultTopology,
            locale,
          );
          count =
            lockedOffToolNames.size > 0
              ? schemas.filter(
                  (toolSchema) =>
                    !lockedOffToolNames.has(toolSchema.name as string),
                ).length
              : schemas.length;
          if (effectiveEnabledTools) {
            const hasPrefixed = effectiveEnabledTools.some(
              (enabledTool) =>
                enabledTool.startsWith("domain:") ||
                enabledTool.startsWith("domainKey:"),
            );
            const enabledSet = hasPrefixed
              ? resolveToolEntriesToSet(effectiveEnabledTools, schemas)
              : new Set(effectiveEnabledTools);

            const countPersona = agentId
              ? AgentPersonaRegistry.get(agentId)
              : null;
            const isCoreToolsLockedForCount =
              countPersona?.coreToolsLocked ?? true;

            let filteredSchemas = schemas.filter(
              (toolSchema) =>
                enabledSet.has(toolSchema.name as string) ||
                (isCoreToolsLockedForCount &&
                  (isCoreDomain(
                    ((toolSchema as Record<string, unknown>)
                      .domain as string) || "",
                  ) ||
                    CORE_AGENTIC_TOOLS.has(toolSchema.name as string))),
            );

            if (agentId) {
              const assemblerPersona = AgentPersonaRegistry.get(agentId);
              if (assemblerPersona?.blockedTools?.length) {
                const disabledSet = resolveToolEntriesToSet(
                  assemblerPersona.blockedTools,
                  schemas,
                );
                filteredSchemas = filteredSchemas.filter(
                  (toolSchema) =>
                    !disabledSet.has(toolSchema.name as string) ||
                    enabledSet.has(toolSchema.name as string),
                );
              }
            }

            if (lockedOffToolNames.size > 0) {
              filteredSchemas = filteredSchemas.filter(
                (toolSchema) =>
                  !lockedOffToolNames.has(toolSchema.name as string),
              );
            }

            count = filteredSchemas.length;
          }
        }
        const header = PromptLocaleService.get(
          locale,
          "system-prompt.enabledToolsHeader",
          { count: String(count) },
        );
        const indexNote =
          toolDocMode === "index"
            ? PromptLocaleService.get(locale, "system-prompt.toolIndexNote") +
              "\n"
            : "";
        sections.push(
          wrapSection(
            SYSTEM_PROMPT_SECTIONS.ENABLED_TOOLS,
            header + "\n" + indexNote + toolDescriptions,
          ),
        );
      }
    }

    // ── 5. Guidelines ─────────────────────────────────────────────
    // Coding guidelines reference workspace tools (replace_in_file,
    // patch_file, write_file, run_in_background) so they must be
    // excluded when workspace is off to avoid confusing the LLM.
    if (!isDirectMode && isWorkspaceEnabled) {
      if (persona?.guidelines) {
        sections.push(wrapSection(SYSTEM_PROMPT_SECTIONS.GUIDELINES, persona.guidelines));
      } else if (codingFallback || persona?.usesCodingGuidelines) {
        sections.push(
          wrapSection(
            SYSTEM_PROMPT_SECTIONS.GUIDELINES,
            PromptLocaleService.get(locale, "system-prompt.codingGuidelines") +
              PromptLocaleService.get(
                locale,
                "system-prompt.commandExecutionGuidelines",
              ),
          ),
        );
      }
    }

    // ── 5c. Active Rules (user-pinned per-turn directives) ────────
    // The client sends the names of the slash-command rules pinned to
    // this turn; the rule CONTENT is resolved here from the rules
    // collection so prompt assembly stays server-owned.
    if (
      Array.isArray(context.activeRuleNames) &&
      context.activeRuleNames.length > 0
    ) {
      const activeRules = await fetchActiveRules(
        context.project,
        context.username,
        context.activeRuleNames,
      );
      if (activeRules.length > 0) {
        const rulesText = activeRules
          .map((rule) => `## /${rule.name}\n${rule.content}`)
          .join("\n\n");
        sections.push(
          wrapSection(SYSTEM_PROMPT_SECTIONS.ACTIVE_RULES, rulesText),
        );
        logger.info(
          `[SystemPromptAssembler] Injected ${activeRules.length} active rule(s): ${activeRules.map((rule) => rule.name).join(", ")}`,
        );
      }
    }

    // ── 5b. Orchestrator Mode Addendum (when orchestrator tools available) ──
    // Sub-agent orchestration is workspace-scoped — skip when disabled.
    if (!isDirectMode && isWorkspaceEnabled && (codingFallback || persona?.usesCodingGuidelines)) {
      const resolvedEnabledSet = (() => {
        if (!context.enabledTools) return null;
        const hasPrefixed = context.enabledTools.some(
          (entry) =>
            entry.startsWith("domain:") || entry.startsWith("domainKey:"),
        );
        if (hasPrefixed) {
          const schemas = ToolOrchestratorService.getClientToolSchemas(
            defaultTopology,
            locale,
          );
          return resolveToolEntriesToSet(context.enabledTools, schemas);
        }
        return new Set(context.enabledTools);
      })();
      const orchestratorAvailable = resolvedEnabledSet
        ? ORCHESTRATOR_ONLY_TOOLS.some((toolName: string) =>
            resolvedEnabledSet.has(toolName),
          )
        : true;

      if (orchestratorAvailable) {
        const allSchemas = ToolOrchestratorService.getToolSchemas(
          defaultTopology,
          locale,
        );
        const orchestratorSet = new Set(ORCHESTRATOR_ONLY_TOOLS);
        const lockedOffSet = await resolveLockedOffToolNames();

        // Build the sub-agent tool list from only the enabled tools
        // (not the full catalog). Sub-agents inherit the parent's
        // enabled set minus orchestrator-only tools.
        let enabledToolNames: string[];
        if (context.resolvedToolNames?.length) {
          enabledToolNames = context.resolvedToolNames;
        } else if (context.enabledTools?.length) {
          const hasPrefixed = context.enabledTools.some(
            (entry) =>
              entry.startsWith("domain:") || entry.startsWith("domainKey:"),
          );
          const clientSchemas = ToolOrchestratorService.getClientToolSchemas(
            defaultTopology,
            locale,
          );
          const enabledSet = hasPrefixed
            ? resolveToolEntriesToSet(context.enabledTools, clientSchemas)
            : new Set(context.enabledTools);
          enabledToolNames = allSchemas
            .map((tool) => tool.name as string)
            .filter(
              (toolName) =>
                enabledSet.has(toolName) || CORE_AGENTIC_TOOLS.has(toolName),
            );
        } else {
          enabledToolNames = allSchemas.map((tool) => tool.name as string);
        }

        const subAgentTools = enabledToolNames.filter(
          (toolName) =>
            !orchestratorSet.has(toolName) && !lockedOffSet.has(toolName),
        );
        sections.push(
          wrapSection(
            SYSTEM_PROMPT_SECTIONS.ORCHESTRATOR,
            getOrchestratorPromptAddendum({
              subAgentTools,
              defaultTopology,
              locale,
            }),
          ),
        );
      }
    }

    // ── 5b. Negative Constraints (persona-specific) ──────────────
    // Explicit "thou shalt not" rules that LLMs respond to more reliably
    // than positive-only instructions. Standardized as a dedicated section
    // so every persona benefits from the pattern without ad-hoc formatting.
    if (persona?.negativeConstraints && persona.negativeConstraints.length > 0) {
      const constraintItems = persona.negativeConstraints
        .map((constraint, index) => `${index + 1}. ${constraint}`)
        .join("\n");
      const constraintsHeader = PromptLocaleService.get(
        locale,
        "system-prompt.constraintsHeader",
      );
      sections.push(
        wrapSection(
          SYSTEM_PROMPT_SECTIONS.CONSTRAINTS,
          constraintsHeader + "\n" + constraintItems,
        ),
      );
    }

    // ── 6. Environment ───────────────────────────────────────────
    const environmentLines = [
      PromptLocaleService.get(locale, "system-prompt.environmentOsLine"),
    ];
    if (isWorkspaceEnabled) {
      environmentLines.push(
        PromptLocaleService.get(
          locale,
          "system-prompt.environmentWorkspaceLine",
          {
            workspaceRoot: this.workspaceRoot,
          },
        ),
      );
    }
    sections.push(
      wrapSection(
        SYSTEM_PROMPT_SECTIONS.ENVIRONMENT,
        PromptLocaleService.get(locale, "system-prompt.environmentHeader") +
          `\n` +
          environmentLines.join(`\n`),
      ),
    );

    // ── 7. Project Structure (cached) ────────────────────────────
    if (isWorkspaceEnabled && (codingFallback || persona?.usesDirectoryTree)) {
      const dirTree = await this.fetchDirectoryTree();
      if (dirTree) {
        const header = PromptLocaleService.get(
          locale,
          "system-prompt.projectStructureHeader",
        );
        // Fence the tree so markdown renderers preserve line breaks and indentation
        sections.push(
          wrapSection(
            SYSTEM_PROMPT_SECTIONS.PROJECT_STRUCTURE,
            header + "\n```\n" + dirTree + "\n```",
          ),
        );
      }
    }

    // ── 8. Project Skills (relevance-filtered) ────────────────────
    // Skills are workspace-scoped context — skip entirely when workspace
    // is disabled to avoid injecting irrelevant coding/project instructions.
    const lastUserMessage = [...(context.messages || [])]
      .reverse()
      .find((message) => message.role === "user");
    const queryText = (lastUserMessage?.content as string) || "";

    const skillNames: string[] = [];
    let skillsText = "";
    if (isWorkspaceEnabled) {
      const skills = await this.scorer.fetchSkills(
        context.project || null,
        context.username || "",
        queryText,
        {
          traceId: context.traceId,
          agentConversationId: context.agentConversationId,
          endpoint: "/agent",
          agent: agentId,
        },
      );
      if (skills.length > 0) {
        const skillBlocks = skills.map((s) => {
          skillNames.push(s.name);
          return `### ${s.name}\n${s.content}`;
        });
        skillsText = wrapSystemMessage(
          SYSTEM_MESSAGE_TAGS.PROJECT_SKILLS,
          skillBlocks.join("\n\n"),
        );
      }
    }

    // ── 9. Conversation Memory (embedding search) ────────────────────
    // Sub-agents are ephemeral workers with isolated context windows.
    // They receive only the task prompt from the orchestrator — injecting
    // the parent user's long-term memory would add irrelevant noise and
    // waste tokens. This aligns with the industry-standard pattern used
    // by LangGraph, CrewAI, AutoGen, Google ADK, and OpenAI Agents SDK.
    const memoryQuery = queryText || context.project || "";
    let memoriesText = "";
    let injectedMemoryIds: string[] = [];

    if (memoryQuery && !isSubAgent) {
      const agentContextForMemory = context.agentContext || {};
      const memoryGuildId = agentContextForMemory.guildId;
      const memoryUserIds = agentContextForMemory.participantUserIds;

      // Load the set of memory IDs already injected in prior turns for this
      // conversation. A targeted projection keeps the read cost minimal —
      // we only fetch the single array field, not the full document.
      const alreadyInjectedMemoryIds = await fetchAlreadyInjectedMemoryIds(
        context.conversationId as string | null | undefined,
      );

      const memoryResult = await this.scorer.fetchMemories(
        agentId,
        context.project || null,
        memoryQuery,
        {
          traceId: context.traceId,
          agentConversationId: context.agentConversationId,
          conversationId: context.conversationId as string | null,
          endpoint: "/agent",
          _username: context.username,
          guildId: memoryGuildId,
          userIds: memoryUserIds,
          excludeMemoryIds: alreadyInjectedMemoryIds,
          conversationalStyle: persona?.type === "conversational",
        },
      );
      if (memoryResult.memoriesText) {
        memoriesText = wrapSystemMessage(
          SYSTEM_MESSAGE_TAGS.AGENT_MEMORY,
          memoryResult.memoriesText,
        );
        injectedMemoryIds = memoryResult.injectedMemoryIds;
      }
    }

    // ── 10. Workflow Memory (cross-conversation procedural learning) ──
    // Same rationale as Step 9 — sub-agents don't need cross-conversation
    // procedural workflows. They execute a single task and are destroyed.
    let workflowsText = "";
    if (memoryQuery && !isDirectMode && !isSubAgent) {
      try {
        const workflows = await WorkflowMemoryService.retrieveRelevantWorkflows(
          agentId,
          context.project || null,
          memoryQuery,
          {
            traceId: context.traceId,
            agentConversationId: context.agentConversationId,
            conversationId: context.conversationId as string | null,
            endpoint: "/agent",
            username: context.username,
          },
        );
        if (workflows) {
          workflowsText = wrapSystemMessage(
            SYSTEM_MESSAGE_TAGS.PAST_WORKFLOWS,
            workflows,
          );
        }
      } catch (error: unknown) {
        logger.error(
          `[SystemPromptAssembler] Workflow memory retrieval failed: ${getErrorMessage(error)}`,
        );
      }
    }

    return {
      prompt: sections.join("\n\n"),
      platformContextMessage:
        platformContextSections.length > 0
          ? platformContextSections.join("\n\n")
          : null,
      selfContextMessage:
        selfContextSections.length > 0
          ? selfContextSections.join("\n\n")
          : null,
      skillNames,
      skillsText,
      memoriesText,
      workflowsText,
      injectedMemoryIds,
    };
  }

  createHook() {
    return async (context: AssemblerContext) => {
      try {
        const {
          prompt: systemPrompt,
          platformContextMessage,
          selfContextMessage,
          skillNames,
          skillsText,
          memoriesText,
          workflowsText,
          injectedMemoryIds,
        } = await this.assemble(context);
        if (!systemPrompt) return;

        context._injectedSkills = skillNames;
        context._skillsText = skillsText;
        context._assembledSystemPrompt = systemPrompt;

        // Propagate newly injected memory IDs to the hook context so the
        // Finalizer can persist them via $addToSet on the conversation document.
        if (injectedMemoryIds.length > 0) {
          context._injectedMemoryIds = injectedMemoryIds;
        }

        const assembledLocale =
          context.locale ||
          (await SettingsService.getSection("agents"))?.locale ||
          PromptLocaleService.getDefaultLocale();
        injectSystemPromptContext(context.messages!, {
          platformContextMessage,
          selfContextMessage,
          skillsText,
          memoriesText,
          workflowsText,
          locale: assembledLocale,
        });

        logger.info(
          `[SystemPromptAssembler] Assembled ${systemPrompt.length} char static system prompt for agent="${context.agent || "DIRECT"}" (${skillNames.length} skills injected into user context, ${injectedMemoryIds.length} new memories injected)`,
        );
      } catch (error: unknown) {
        logger.error(
          `[SystemPromptAssembler] Assembly failed: ${getErrorMessage(error)}`,
        );
      }
    };
  }
}

/**
 * Standard utility to inject system prompts and contexts (platform context, somatic state, skills, memories)
 * into a conversation message history. Exposed so that both production assembler hooks and test harnesses
 * use the identical alignment algorithm without code duplication.
 */
export function injectSystemPromptContext(
  messages: Array<{
    role: string;
    content?: string | unknown[] | null;
    _isIdentityPrompt?: boolean;
    [key: string]: unknown;
  }>,
  options: {
    systemPrompt?: string;
    platformContextMessage?: string | null;
    selfContextMessage?: string | null;
    skillsText?: string;
    memoriesText?: string;
    workflowsText?: string;
    localTimeText?: string;
    locale?: string;
  },
): void {
  const {
    systemPrompt: _systemPrompt,
    platformContextMessage,
    selfContextMessage,
    skillsText,
    memoriesText,
    workflowsText,
    localTimeText,
    locale,
  } = options;

  // ── 1. Interleave platform context before the last user message ──
  // Inserted first so that when somatic state is also spliced in (step 2),
  // the final order is: ...history → platform → somatic → last user msg.
  if (platformContextMessage) {
    const lastUserMessageIndex = messages.reduce(
      (lastIndex: number, message: { role: string }, index: number) =>
        message.role === "user" ? index : lastIndex,
      -1,
    );
    if (lastUserMessageIndex >= 0) {
      messages.splice(lastUserMessageIndex, 0, {
        role: "system",
        content: wrapSystemMessage(
          SYSTEM_MESSAGE_TAGS.PLATFORM_CONTEXT,
          platformContextMessage,
        ),
      });
    }
  }

  // ── 2. Interleave self context before the last user message ───
  // Re-scans for the last user message (which may have shifted after
  // step 1), so somatic state always sits directly before the user input.
  if (selfContextMessage) {
    const lastUserMessageIndex = messages.reduce(
      (lastIndex: number, message: { role: string }, index: number) =>
        message.role === "user" ? index : lastIndex,
      -1,
    );
    if (lastUserMessageIndex >= 0) {
      messages.splice(lastUserMessageIndex, 0, {
        role: "system",
        content: wrapSystemMessage(
          SYSTEM_MESSAGE_TAGS.SELF_CONTEXT,
          selfContextMessage,
        ),
      });
    }
  }

  // ── 3. Inject system-originated context as a dedicated system message ──
  // Local time, skills, memories, and workflows are system-injected metadata,
  // not user input. They belong in a system message so the LLM treats them as
  // authoritative grounding context rather than conversational user intent.
  // The _isInjectedContext marker prevents double-injection on the same turn
  // and is cleaned from the payload before persistence to MongoDB.
  const userMessages = messages.filter((message) => message.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];
  if (lastUserMessage) {
    const timeText =
      localTimeText ||
      new Date().toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "long",
      });

    const activeLocale = locale || PromptLocaleService.getDefaultLocale();
    const localTimeLabel = PromptLocaleService.get(
      activeLocale,
      "system-prompt.localTimeLabel",
      { time: timeText },
    );
    const contextLines = [localTimeLabel];

    // The message is a flat sequence of tagged sections — same structure as
    // the assembled system prompt. skillsText/memoriesText/workflowsText
    // arrive pre-wrapped in their own tags by assemble().
    let systemContextBlock = wrapSystemMessage(
      SYSTEM_MESSAGE_TAGS.SYSTEM_CONTEXT,
      contextLines.join("\n"),
    );

    if (skillsText) {
      systemContextBlock += `\n\n${skillsText}`;
    }

    if (memoriesText) {
      systemContextBlock += `\n\n${memoriesText}`;
    }

    if (workflowsText) {
      systemContextBlock += `\n\n${workflowsText}`;
    }

    const messageIndex = messages.indexOf(lastUserMessage);
    if (messageIndex !== -1) {
      // Check if an injected context message already exists immediately before
      // the user message (guard against double-injection on the same turn)
      const preceding = messages[messageIndex - 1];
      if (preceding?._isInjectedContext !== true) {
        messages.splice(messageIndex, 0, {
          role: "system",
          content: systemContextBlock,
          _isInjectedContext: true,
        });
      }
    }
  }
}

export { SystemPromptAssembler };
