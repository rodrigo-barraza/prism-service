import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import AgentPersonaRegistry from "../AgentPersonaRegistry.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import {
  getOrchestratorPromptAddendum,
  ORCHESTRATOR_ONLY_TOOLS,
} from "../OrchestratorPrompt.ts";
import { resolveToolEntriesToSet } from "../../utils/resolveToolEntriesToSet.ts";
import { resolveLockedOffToolNames } from "../../utils/resolveLockedOffToolNames.ts";
import SettingsService from "../SettingsService.ts";
import { AGENT_IDS, DOMAINS, DEFAULT_TOPOLOGY, CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST, isCoreDomain } from "@rodrigo-barraza/utilities-library/taxonomy";

const CORE_AGENTIC_TOOLS = new Set<string>(CORE_AGENTIC_TOOLS_LIST);

import { DirectoryTreeFormatter } from "./DirectoryTreeFormatter.ts";
import { ToolDocFormatter } from "./ToolDocFormatter.ts";
import { SkillMemoryScorer } from "./SkillMemoryScorer.ts";
import { AssemblerContext } from "./types.ts";
import SomaticStateService from "../somatic/SomaticStateService.ts";
import { PROMPT_DELIMITERS } from "../../constants.ts";

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

  buildToolDescriptions(enabledTools?: string[], agentId?: string | null, defaultTopology?: string, resolvedToolNames?: string[], lockedOffToolNames?: Set<string>, compact?: boolean): string {
    return this.docFormatter.buildToolDescriptions(enabledTools, agentId, defaultTopology, resolvedToolNames, lockedOffToolNames, compact);
  }

  async assemble(context: AssemblerContext) {
    const sections: string[] = [];
    const isDirectMode = !context.agent;
    const agentId = context.agent || AGENT_IDS.CODING;
    const persona = isDirectMode ? null : AgentPersonaRegistry.get(agentId);

    const codingFallback =
      !isDirectMode && (!persona || persona.id === AGENT_IDS.CODING);

    const settings = await SettingsService.getSection("agents");
    const defaultTopology = settings?.topology || DEFAULT_TOPOLOGY;

    // ── 1. Agent Identity ────────────────────────────────────────
    if (isDirectMode) {
      sections.push(
        `You are a helpful AI assistant with access to a comprehensive suite of real-time data and utility tools. Present data clearly with relevant formatting. For questions that don't require API data, respond naturally without tool calls.`,
      );
    } else if (persona) {
      const identityText =
        typeof persona.identity === "function"
          ? persona.identity(context)
          : persona.identity;
      sections.push(identityText);
    } else {
      sections.push(
        `You are a highly capable coding agent with access to file system, git, command execution, and web tools.`,
      );
    }

    // ── 1b. Platform-Specific Rules ──────────────────────────────
    if (persona?.platformRules && context.agentContext?.platform) {
      const platformKey = context.agentContext.platform as string;
      const platformSection = persona.platformRules[platformKey];
      if (platformSection) {
        const platformText = typeof platformSection === 'function'
          ? platformSection(context)
          : platformSection;
        if (platformText) sections.push(platformText);
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
      const platformContext = agentContext.platformContext as Record<string, unknown> | undefined;
      if (platformContext) {
        if (platformContext.description) {
          platformContextSections.push(platformContext.description as string);
        }
        if (platformContext.serverContext) {
          platformContextSections.push(platformContext.serverContext as string);
        }
        if (platformContext.imageContext) {
          platformContextSections.push(platformContext.imageContext as string);
        }
        if (platformContext.ids) {
          platformContextSections.push(platformContext.ids as string);
        }
      } else {
        // Legacy flat fields — backward compatible
        if (agentContext.discordContext) {
          platformContextSections.push(agentContext.discordContext as string);
        }
        if (agentContext.serverContext) {
          platformContextSections.push(agentContext.serverContext as string);
        }
        if (agentContext.imageContext) {
          platformContextSections.push(agentContext.imageContext as string);
        }
        if (agentContext.guildId) {
          let idsBlock = `# Discord IDs\n- Guild ID: ${agentContext.guildId}`;
          if (agentContext.channelId) idsBlock += `\n- Channel ID: ${agentContext.channelId}`;
          platformContextSections.push(idsBlock);
        }
      }

      // Agent-specific runtime context (non-platform, non-self)
      // These remain in the main system prompt for now
      if (agentContext.clockCrewContext) {
        sections.push(agentContext.clockCrewContext as string);
      }
      if (agentContext.stickersContext) {
        sections.push(agentContext.stickersContext as string);
      }
      if (agentContext.emotionContext) {
        sections.push(agentContext.emotionContext as string);
      }
      if (agentContext.visualContext) {
        sections.push(agentContext.visualContext as string);
      }
      if (agentContext.lightsContext) {
        sections.push(agentContext.lightsContext as string);
      }
    }

    // ── 2b. Self Context (separate SYSTEM message) ──────────────
    // Somatic state is agent-level (not platform-level). Runs for any
    // agent with hasSomaticState, regardless of whether agentContext
    // is present. This ensures prism-client Lupos gets somatic state
    // even though only Discord sends agentContext.
    if (persona?.hasSomaticState && agentId) {
      const userMessages = context.messages?.filter((message) => message.role === "user") || [];
      const latestUserMessage = userMessages[userMessages.length - 1];
      if (latestUserMessage && typeof latestUserMessage.content === "string") {
        await SomaticStateService.adaptFromMessage(agentId, latestUserMessage.content);
      }

      const somaticMessage = await SomaticStateService.renderSystemMessage(agentId);
      if (somaticMessage) {
        selfContextSections.push(somaticMessage);
      }
    }

    // ── 3. Tool Policy (persona-specific) ────────────────────────
    if (persona?.toolPolicy) {
      const policyText =
        typeof persona.toolPolicy === "function"
          ? persona.toolPolicy(context)
          : persona.toolPolicy;
      if (policyText) sections.push(policyText);
    }

    // ── 4. Enabled Tools (domain-grouped) ──────────────────────
    {
      const lockedOffToolNames = await resolveLockedOffToolNames();
      const isCompactToolDocs = persona?.compactToolDocs === true;
      const toolDescriptions = this.buildToolDescriptions(context.enabledTools, agentId, defaultTopology, context.resolvedToolNames, lockedOffToolNames, isCompactToolDocs);
      if (toolDescriptions) {
        let count: number;
        if (context.resolvedToolNames?.length) {
          count = lockedOffToolNames.size > 0
            ? context.resolvedToolNames.filter((toolName) => !lockedOffToolNames.has(toolName)).length
            : context.resolvedToolNames.length;
        } else {
          const schemas = ToolOrchestratorService.getClientToolSchemas(defaultTopology);
          count = lockedOffToolNames.size > 0
            ? schemas.filter((toolSchema) => !lockedOffToolNames.has(toolSchema.name as string)).length
            : schemas.length;
          if (context.enabledTools) {
            const hasPrefixed = context.enabledTools.some(
              (enabledTool) => enabledTool.startsWith("domain:") || enabledTool.startsWith("domainKey:"),
            );
            const enabledSet = hasPrefixed
              ? resolveToolEntriesToSet(context.enabledTools, schemas)
              : new Set(context.enabledTools);

            const countPersona = agentId ? AgentPersonaRegistry.get(agentId) : null;
            const isCoreToolsLockedForCount = countPersona?.coreToolsLocked ?? true;

            let filteredSchemas = schemas.filter(
              (toolSchema) =>
                enabledSet.has(toolSchema.name as string) ||
                (isCoreToolsLockedForCount && (
                  isCoreDomain((toolSchema as Record<string, unknown>).domain as string || "") ||
                  CORE_AGENTIC_TOOLS.has(toolSchema.name as string)
                ))
            );

            if (agentId) {
              const assemblerPersona = AgentPersonaRegistry.get(agentId);
              if (assemblerPersona?.blockedTools?.length) {
                const disabledSet = resolveToolEntriesToSet(assemblerPersona.blockedTools, schemas);
                filteredSchemas = filteredSchemas.filter(
                  (toolSchema) => !disabledSet.has(toolSchema.name as string) || enabledSet.has(toolSchema.name as string),
                );
              }
            }

            if (lockedOffToolNames.size > 0) {
              filteredSchemas = filteredSchemas.filter(
                (toolSchema) => !lockedOffToolNames.has(toolSchema.name as string),
              );
            }

            count = filteredSchemas.length;
          }
        }
        sections.push(`## Enabled Tools (${count})\n` + toolDescriptions);
      }
    }

    // ── 5. Guidelines ─────────────────────────────────────────────
    if (!isDirectMode) {
      if (persona?.guidelines) {
        sections.push(persona.guidelines);
      } else if (codingFallback || persona?.usesCodingGuidelines) {
        sections.push(
          `## Coding Guidelines\n` +
            `- Always read relevant files before making edits to understand context\n` +
            `- After making changes, verify them by reading the modified section\n` +
            `- Keep your explanations concise and technical\n` +
            `\n## Command Execution\n` +
            `- For dev servers and long-running processes (npm run dev, next dev, vite, nodemon, etc.), ALWAYS set run_in_background: true. These commands never terminate on their own.\n` +
            `- You will receive the first ~2.5 seconds of output to confirm the server started correctly.\n` +
            `- Do NOT use run_in_background for one-shot commands (npm install, npm test, git status, eslint, prettier, tsc, etc.) — let them complete normally.`,
        );
      }
    }

    // ── 5b. Orchestrator Mode Addendum (when orchestrator tools available) ──
    if (!isDirectMode && (codingFallback || persona?.usesCodingGuidelines)) {
      const resolvedEnabledSet = (() => {
        if (!context.enabledTools) return null;
        const hasPrefixed = context.enabledTools.some(
          (entry) => entry.startsWith("domain:") || entry.startsWith("domainKey:"),
        );
        if (hasPrefixed) {
          const schemas = ToolOrchestratorService.getClientToolSchemas(defaultTopology);
          return resolveToolEntriesToSet(context.enabledTools, schemas);
        }
        return new Set(context.enabledTools);
      })();
      const orchestratorAvailable = resolvedEnabledSet
        ? ORCHESTRATOR_ONLY_TOOLS.some((toolName: string) => resolvedEnabledSet.has(toolName))
        : true;

      if (orchestratorAvailable) {
        const allSchemas = ToolOrchestratorService.getToolSchemas(defaultTopology);
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
            (entry) => entry.startsWith("domain:") || entry.startsWith("domainKey:"),
          );
          const clientSchemas = ToolOrchestratorService.getClientToolSchemas(defaultTopology);
          const enabledSet = hasPrefixed
            ? resolveToolEntriesToSet(context.enabledTools, clientSchemas)
            : new Set(context.enabledTools);
          enabledToolNames = allSchemas
            .map((tool) => tool.name as string)
            .filter((toolName) =>
              enabledSet.has(toolName) ||
              CORE_AGENTIC_TOOLS.has(toolName),
            );
        } else {
          enabledToolNames = allSchemas.map((tool) => tool.name as string);
        }

        const subAgentTools = enabledToolNames.filter(
          (toolName) => !orchestratorSet.has(toolName) && !lockedOffSet.has(toolName),
        );
        sections.push(getOrchestratorPromptAddendum({ subAgentTools, defaultTopology }));
      }
    }

    // ── 6. Environment ───────────────────────────────────────────
    sections.push(
      `## Environment\n` +
        `- OS: Linux (WSL2)\n` +
        `- Workspace: ${this.workspaceRoot}`,
    );

    // ── 7. Project Structure (cached) ────────────────────────────
    if (codingFallback || persona?.usesDirectoryTree) {
      const dirTree = await this.fetchDirectoryTree();
      if (dirTree) {
        sections.push(`## Project Structure\n` + dirTree);
      }
    }

    // ── 8. Project Skills (relevance-filtered) ────────────────────
    const lastUserMessage = [...(context.messages || [])]
      .reverse()
      .find((message) => message.role === "user");
    const queryText = (lastUserMessage?.content as string) || "";

    const skills = await this.scorer.fetchSkills(
      context.project || null,
      context.username || "",
      queryText,
      {
        traceId: context.traceId,
        agentSessionId: context.agentSessionId,
        endpoint: "/agent",
        agent: agentId,
      },
    );
    const skillNames: string[] = [];
    let skillsText = "";
    if (skills.length > 0) {
      const skillBlocks = skills.map((s) => {
        skillNames.push(s.name);
        return `### ${s.name}\n${s.content}`;
      });
      skillsText = `${PROMPT_DELIMITERS.PROJECT_SKILLS}\n` + skillBlocks.join("\n\n");
    }

    // ── 9. Session Memory (embedding search) ────────────────────
    const memoryQuery = queryText || context.project || "";
    let memoriesText = "";

    if (memoryQuery) {
      const agentContextForMemory = context.agentContext || {};
      const memoryGuildId = agentContextForMemory.guildId as string | undefined;
      const memoryUserIds = agentContextForMemory.participantUserIds as string[] | undefined;

      const memories = await this.scorer.fetchMemories(
        agentId,
        context.project || null,
        memoryQuery,
        {
          traceId: context.traceId,
          agentSessionId: context.agentSessionId,
          endpoint: "/agent",
          _username: context.username,
          guildId: memoryGuildId,
          userIds: memoryUserIds,
        },
      );
      if (memories) {
        memoriesText = `${PROMPT_DELIMITERS.AGENT_MEMORY}\n` + memories;
      }
    }

    return {
      prompt: sections.join("\n\n"),
      platformContextMessage: platformContextSections.length > 0 ? platformContextSections.join("\n\n") : null,
      selfContextMessage: selfContextSections.length > 0 ? selfContextSections.join("\n\n") : null,
      skillNames,
      skillsText,
      memoriesText,
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
        } = await this.assemble(context);
        if (!systemPrompt) return;

        context._injectedSkills = skillNames;

        injectSystemPromptContext(context.messages!, {
          systemPrompt,
          platformContextMessage,
          selfContextMessage,
          skillsText,
          memoriesText,
        });

        logger.info(
          `[SystemPromptAssembler] Assembled ${systemPrompt.length} char static system prompt for agent="${context.agent || "DIRECT"}" (${skillNames.length} skills injected into user context)`,
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
  messages: Array<any>,
  options: {
    systemPrompt: string;
    platformContextMessage?: string | null;
    selfContextMessage?: string | null;
    skillsText?: string;
    memoriesText?: string;
    localTimeText?: string;
  }
): void {
  const {
    systemPrompt,
    platformContextMessage,
    selfContextMessage,
    skillsText,
    memoriesText,
    localTimeText,
  } = options;

  // ── 1. Insert main system prompt as messages[0] ─────────────
  // Always place the identity system prompt at index 0.
  // On subsequent turns, the history may contain mid-conversation
  // system messages (somatic state, validation errors) — we must
  // NOT overwrite those. Instead, always target index 0 specifically.
  if (messages.length > 0 && messages[0].role === "system") {
    messages[0].content = systemPrompt;
    messages[0]._isIdentityPrompt = true;
  } else {
    messages.unshift({ role: "system", content: systemPrompt, _isIdentityPrompt: true });
  }

  // ── 2. Insert platform context after the main system prompt ───
  // Always insert at index 1 (right after the identity prompt at 0).
  if (platformContextMessage) {
    messages.splice(1, 0, {
      role: "system",
      content: platformContextMessage,
    });
  }

  // ── 3. Interleave self context before the last user message ───
  if (selfContextMessage) {
    const lastUserMessageIndex = messages.reduce(
      (lastIndex: number, message: { role: string }, index: number) =>
        message.role === "user" ? index : lastIndex,
      -1,
    );
    if (lastUserMessageIndex >= 0) {
      messages.splice(lastUserMessageIndex, 0, {
        role: "system",
        content: selfContextMessage,
      });
    }
  }

  // ── 4. Prepend [System Context] to last user message ───
  const userMessages = messages.filter((message) => message.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];
  if (lastUserMessage && typeof lastUserMessage.content === "string") {
    const timeText = localTimeText || new Date().toLocaleString("en-US", {
      dateStyle: "full",
      timeStyle: "long",
    });

    const contextLines = [`- Local Time: ${timeText}`];

    let systemContextBlock = `${PROMPT_DELIMITERS.SYSTEM_CONTEXT}\n${contextLines.join("\n")}\n\n`;

    if (skillsText) {
      systemContextBlock += `${skillsText}\n\n`;
    }

    if (memoriesText) {
      systemContextBlock += `${memoriesText}\n\n`;
    }

    if (!lastUserMessage.content.startsWith(PROMPT_DELIMITERS.SYSTEM_CONTEXT)) {
      const messageIndex = messages.indexOf(lastUserMessage);
      if (messageIndex !== -1) {
        const originalContent = lastUserMessage.content;
        messages[messageIndex] = {
          ...lastUserMessage,
          rawContent: originalContent,
          content: systemContextBlock + `${PROMPT_DELIMITERS.USER_MESSAGE}\n${originalContent}`,
        };
      }
    }
  }
}

export { SystemPromptAssembler };

