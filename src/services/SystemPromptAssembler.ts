import ToolOrchestratorService from "./ToolOrchestratorService.ts";
import MemoryService from "./MemoryService.ts";
import AgentPersonaRegistry from "./AgentPersonaRegistry.ts";
import EmbeddingService from "./EmbeddingService.ts";
import InternalToolRegistry from "./local-tools/InternalToolRegistry.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { TOOLS_SERVICE_URL, MONGO_DB_NAME } from "../../config.ts";
import logger from "../utils/logger.ts";
import { cosineSimilarity } from "../utils/math.ts";
import {
  getCoordinatorPromptAddendum,
  COORDINATOR_ONLY_TOOLS,
} from "./CoordinatorPrompt.ts";
import { createAbortController } from "../utils/AbortController.ts";
import { DIRECTORY_CACHE_TTL_MS, DIRECTORY_FETCH_TIMEOUT_MS } from "../constants.ts";

const SKILL_RELEVANCE_THRESHOLD = 0.3;

// ── Types ───────────────────────────────────────────────────

interface DirectoryEntry {
  name?: string;
  path?: string;
  type: string;
  children?: DirectoryEntry[];
}

interface DirectoryData {
  entries: DirectoryEntry[];
}

interface ScoredSkill {
  name: string;
  content: string;
  description: string;
  score: number;
}

interface AssemblerContext {
  agent?: string | null;
  project?: string | null;
  username?: string;
  messages?: Array<{ role: string; content?: string; [key: string]: unknown }>;
  enabledTools?: string[];
  agentContext?: Record<string, unknown>;
  traceId?: string | null;
  agentSessionId?: string | null;
  clientIp?: string | null;
  requestId?: string;
  options?: Record<string, unknown>;
  _injectedSkills?: string[];
  _currentMessages?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface MemoryFetchOptions {
  traceId?: string | null;
  agentSessionId?: string | null;
  endpoint?: string;
  _username?: string;
  guildId?: string;
  userIds?: string[];
}

interface SkillFetchOptions {
  traceId?: string | null;
  agentSessionId?: string | null;
  endpoint?: string;
  agent?: string | null;
}

/**
 * SystemPromptAssembler — sole owner of the agent's system prompt.
 *
 * Assembles identity, coding guidelines, tool descriptions, project
 * structure, environment info, and session memory into a single coherent
 * system message. Registered as a `beforePrompt` hook in AgentHooks.
 *
 * When an `agent` identifier is present in the request context, the
 * assembler loads the matching persona from AgentPersonaRegistry and
 * uses its identity, guidelines, tool policy, and capabilities instead
 * of the default coding agent sections.
 */
export default class SystemPromptAssembler {
  workspaceRoot: string;
  private _directoryCache: string | null = null;
  private _directoryCacheTime = 0;
  private _directoryCacheTTL: number;

  constructor(options: { workspaceRoot?: string } = {}) {
    this.workspaceRoot =
      options.workspaceRoot ||
      ToolOrchestratorService.getWorkspaceRoot() ||
      process.env.HOME ||
      "/home";
    this._directoryCacheTTL = DIRECTORY_CACHE_TTL_MS;
  }

  /**
   * Fetch project directory tree from tools-api.
   * Cached for 1 minute to avoid hammering the API.
   */
  async fetchDirectoryTree(): Promise<string> {
    const now = Date.now();
    if (
      this._directoryCache &&
      now - this._directoryCacheTime < this._directoryCacheTTL
    ) {
      return this._directoryCache;
    }

    try {
      const controller = createAbortController();
      const timeout = setTimeout(() => controller.abort(), DIRECTORY_FETCH_TIMEOUT_MS);

      const url = `${TOOLS_SERVICE_URL}/filesystem/list?path=${encodeURIComponent(this.workspaceRoot)}&depth=2`;
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn(
          `[SystemPromptAssembler] Directory fetch failed: ${response.status}`,
        );
        return "";
      }

      const data = await response.json() as DirectoryData;
      const tree = this._formatDirectoryTree(data);
      this._directoryCache = tree;
      this._directoryCacheTime = now;
      return tree;
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Directory fetch error: ${(error as Error).message}`,
      );
      return this._directoryCache || "";
    }
  }
  _formatDirectoryTree(data: DirectoryData): string {
    if (!data || !data.entries) return "";

    const lines: string[] = [];
    for (const entry of data.entries) {
      const prefix = entry.type === "directory" ? "📁" : "📄";
      const name = entry.name || entry.path;
      lines.push(`${prefix} ${name}`);

      // Include first-level children for directories
      if (entry.children && Array.isArray(entry.children)) {
        for (const child of entry.children.slice(0, 20)) {
          const childPrefix = child.type === "directory" ? "📁" : "📄";
          lines.push(`  ${childPrefix} ${child.name || child.path}`);
        }
        if (entry.children.length > 20) {
          lines.push(`  ... and ${entry.children.length - 20} more`);
        }
      }
    }

    return lines.join("\n");
  }

  /**
   * Build domain-grouped tool descriptions from current schemas.
   *
   * Groups tools by their `domain` field, then for each tool shows:
   *   - Name + first sentence of description (capability summary)
   *   - Full parameter listing with required markers
   */
  buildToolDescriptions(enabledTools?: string[], agentId?: string | null): string {
    const schemas = ToolOrchestratorService.getClientToolSchemas();
    if (!enabledTools) {
      return this._formatToolDescriptions(schemas);
    }

    const hasPrefixed = enabledTools.some(
      (enabledTool) => enabledTool.startsWith("label:") || enabledTool.startsWith("domain:"),
    );

    const enabledSet = new Set<string>();
    if (hasPrefixed) {
      for (const entry of enabledTools) {
        if (entry.startsWith("label:")) {
          const label = entry.slice(6);
          for (const toolSchema of schemas) {
            if (toolSchema.labels?.includes(label)) enabledSet.add(toolSchema.name);
          }
        } else if (entry.startsWith("domain:")) {
          const domain = entry.slice(7);
          for (const toolSchema of schemas) {
            if (toolSchema.domain === domain) enabledSet.add(toolSchema.name);
          }
        } else {
          enabledSet.add(entry);
        }
      }
    } else {
      for (const entry of enabledTools) {
        enabledSet.add(entry);
      }
    }

    // Define the core system, coordinator, and local tools
    const CORE_SYSTEM_TOOLS = new Set([
      "upsert_memory",
      "task_create",
      "task_list",
      "task_update",
      "precise_calculator",
      "execute_javascript",
      "search_tools",
      "web_search",
    ]);
    const COORDINATOR_TOOL_NAMES = new Set(COORDINATOR_ONLY_TOOLS);
    const PRISM_LOCAL_TOOL_NAMES = InternalToolRegistry.getNames();

    const filteredSchemas = schemas.filter(
      (toolSchema) =>
        enabledSet.has(toolSchema.name as string) ||
        (agentId !== "LUPOS" && (
          CORE_SYSTEM_TOOLS.has(toolSchema.name as string) ||
          COORDINATOR_TOOL_NAMES.has(toolSchema.name as string) ||
          PRISM_LOCAL_TOOL_NAMES.has(toolSchema.name as string)
        ))
    );

    return this._formatToolDescriptions(filteredSchemas);
  }

  _formatToolDescriptions(filteredSchemas: Record<string, unknown>[]): string {
    if (filteredSchemas.length === 0) return "";

    // Group by domain
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const tool of filteredSchemas) {
      const domain = ((tool.domain as string) || "Other").replace(/^Agentic:\s*/i, "");
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain)!.push(tool);
    }

    // Build categorised sections with parameter details
    const sections: string[] = [];
    for (const [domain, domainTools] of groups) {
      const entries = domainTools.map((tool) => {
        const description = (tool.description as string) || "";

        const parameters = (tool.parameters as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>> || {};
        const parameterNames = Object.keys(parameters);
        const required = ((tool.parameters as Record<string, unknown>)?.required || []) as string[];
        const parameterString = parameterNames
          .map((parameterName) => {
            const isRequired = required.includes(parameterName);
            const parameterDescription = (parameters[parameterName].description as string) || "";
            return `  - ${parameterName}${isRequired ? " (required)" : ""}: ${parameterDescription}`;
          })
          .join("\n");

        return `### ${tool.name}\n${description}\n${parameterString}`;
      });

      sections.push(`**${domain}**\n${entries.join("\n\n")}`);
    }

    return sections.join("\n\n");
  }

  /**
   * Fetch relevant memories via embedding similarity search.
   * Queries the unified `memories` collection using cosine similarity,
   * scoped by agent and project.
   */
  async fetchMemories(
    agent: string,
    project: string | null,
    queryText: string,
    { traceId, agentSessionId, endpoint, _username, guildId, userIds }: MemoryFetchOptions = {},
  ): Promise<string> {
    try {
      const memories = await MemoryService.search({
        agent,
        project,
        queryText,
        limit: 10,
        traceId: traceId || undefined,
        agentSessionId: agentSessionId || undefined,
        endpoint: endpoint || "/agent",
        username: _username || undefined,
        guildId: guildId || undefined,
        userIds: userIds || undefined,
      });

      if (!memories || memories.length === 0) return "";

      logger.info(
        `[SystemPromptAssembler] Memory search returned ${memories.length} results for ${agent}`,
      );
      return MemoryService.formatForPrompt(memories);
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Memory fetch error: ${(error as Error).message}`,
      );
      return "";
    }
  }
  async fetchSkills(
    project: string | null,
    username: string,
    queryText: string,
    { traceId, agentSessionId, endpoint, agent }: SkillFetchOptions = {},
  ): Promise<ScoredSkill[]> {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) return [];

      const skills = await db
        .collection("agent_skills")
        .find({ project, username, enabled: true })
        .project({ name: 1, content: 1, description: 1, embedding: 1 })
        .toArray();

      if (skills.length === 0) return [];

      // If no query or no skills have embeddings, return all (graceful fallback)
      const hasEmbeddings = skills.some((s) => Array.isArray(s.embedding) && s.embedding.length > 0);
      if (!queryText || !hasEmbeddings) {
        logger.info(
          `[SystemPromptAssembler] Returning all ${skills.length} skills (no query or no embeddings)`,
        );
        return skills.map((s) => ({
          name: s.name as string,
          content: s.content as string,
          description: s.description as string,
          score: 1,
        }));
      }

      // Generate query embedding
      let queryEmbedding: number[];
      try {
        queryEmbedding = await EmbeddingService.embed(queryText, {
          source: "skill-relevance",
          project,
          endpoint: endpoint || "/agent",
          traceId: traceId || null,
          agentSessionId: agentSessionId || null,
          agent: agent || null,
        });
      } catch (error: unknown) {
        logger.warn(
          `[SystemPromptAssembler] Query embedding failed: ${(error as Error).message} — returning all skills`,
        );
        return skills.map((s) => ({
          name: s.name as string,
          content: s.content as string,
          description: s.description as string,
          score: 1,
        }));
      }

      // Score and filter by relevance threshold
      const scored: ScoredSkill[] = skills
        .map((s) => ({
          name: s.name as string,
          content: s.content as string,
          description: s.description as string,
          score: s.embedding
            ? cosineSimilarity(queryEmbedding, s.embedding as number[])
            : 0,
        }))
        .filter((s) => s.score >= SKILL_RELEVANCE_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      logger.info(
        `[SystemPromptAssembler] Skills: ${scored.length}/${skills.length} above threshold (${scored.map((s) => `${s.name}:${s.score.toFixed(2)}`).join(", ")})`,
      );

      return scored;
    } catch (error: unknown) {
      logger.warn(
        `[SystemPromptAssembler] Skills fetch error: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Assemble the complete agent system prompt.
   *
   * When `ctx.agent` is set, loads the matching persona from
   * AgentPersonaRegistry. Otherwise falls back to the CODING agent.
   *
   * Persona-aware sections:
   *   1. Agent identity (from persona or default)
   *   2. Agent context (runtime data from caller, e.g. Discord info)
   *   3. Tool policy (persona-specific tool use rules)
   *   4. Available tools (always injected — domain-grouped with parameters)
   *   5. Coding guidelines (CODING only)
   *   6. Environment info (date/time, OS, workspace)
   *   7. Project directory tree (CODING only)
   *   8. Project skills (relevance-filtered)
   *   9. Session memory from past conversations
   */
  async assemble(context: AssemblerContext) {
    const sections: string[] = [];
    // null/undefined agent = direct chat mode (no persona)
    const isDirectMode = !context.agent;
    const agentId = context.agent || "CODING";
    const persona = isDirectMode ? null : AgentPersonaRegistry.get(agentId);

    // If no persona found, fall back to CODING defaults (unless direct mode)
    const codingFallback =
      !isDirectMode && (!persona || persona.id === "CODING");

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

    // ── 2. Agent Context (runtime data from caller) ──────────────
    // Only injected when the caller provides agentContext (e.g. Lupos
    // sends Discord server/channel/participant info, trending data, etc.)
    if (context.agentContext) {
      const agentCtx = context.agentContext;

      // Structured context blocks — each is a pre-formatted text block
      // assembled by the caller (Lupos/Prism Client/etc.)
      if (agentCtx.discordContext) {
        sections.push(agentCtx.discordContext as string);
      }
      if (agentCtx.serverContext) {
        sections.push(agentCtx.serverContext as string);
      }
      if (agentCtx.imageContext) {
        sections.push(agentCtx.imageContext as string);
      }
      if (agentCtx.clockCrewContext) {
        sections.push(agentCtx.clockCrewContext as string);
      }

      // Stickers kiosk context — stage flow, emotion state, visual context
      if (agentCtx.stickersContext) {
        sections.push(agentCtx.stickersContext as string);
      }
      if (agentCtx.emotionContext) {
        sections.push(agentCtx.emotionContext as string);
      }
      if (agentCtx.visualContext) {
        sections.push(agentCtx.visualContext as string);
      }

      // Discord IDs — explicitly inject so discord tools get the correct IDs
      // (the LLM cannot infer these from guild/channel names alone)
      if (agentCtx.guildId) {
        let idsBlock = `# Discord IDs\n- Guild ID: ${agentCtx.guildId}`;
        if (agentCtx.channelId) idsBlock += `\n- Channel ID: ${agentCtx.channelId}`;
        sections.push(idsBlock);
      }

      // Lights context — current light states, night lock, automation mode
      if (agentCtx.lightsContext) {
        sections.push(agentCtx.lightsContext as string);
      }

      // Somatic state — Lupos's simulated physical & emotional state
      if (agentCtx.somaticState) {
        const somatic = agentCtx.somaticState as Record<string, { level: number; label?: string; name?: string }>;
        const entries = Object.entries(somatic);
        if (entries.length > 0) {
          let block = `# Your Current Physical & Emotional State`;
          for (const [key, state] of entries) {
            const display = state.label || state.name || `Level ${state.level}`;
            block += `\n- ${key.charAt(0).toUpperCase() + key.slice(1)}: ${display} (${state.level}/100)`;
          }
          sections.push(block);
        }
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

    // ── 4. Available Tools (domain-grouped) ──────────────────────
    // Always inject tool descriptions for any agent that has enabled tools.
    // This ensures every persona (CODING, LUPOS, future agents) gets the
    // same domain-grouped tool documentation in its system prompt.
    {
      const toolDescriptions = this.buildToolDescriptions(context.enabledTools, agentId);
      if (toolDescriptions) {
        const schemas = ToolOrchestratorService.getClientToolSchemas();
        let count = schemas.length;
        if (context.enabledTools) {
          const hasPrefixed = context.enabledTools.some(
            (enabledTool) => enabledTool.startsWith("label:") || enabledTool.startsWith("domain:"),
          );
          const enabledSet = new Set<string>();
          if (hasPrefixed) {
            for (const entry of context.enabledTools) {
              if (entry.startsWith("label:")) {
                const label = entry.slice(6);
                for (const toolSchema of schemas) {
                  if (toolSchema.labels?.includes(label)) enabledSet.add(toolSchema.name);
                }
              } else if (entry.startsWith("domain:")) {
                const domain = entry.slice(7);
                for (const toolSchema of schemas) {
                  if (toolSchema.domain === domain) enabledSet.add(toolSchema.name);
                }
              } else {
                enabledSet.add(entry);
              }
            }
          } else {
            for (const entry of context.enabledTools) {
              enabledSet.add(entry);
            }
          }

          const CORE_SYSTEM_TOOLS = new Set([
            "upsert_memory",
            "task_create",
            "task_list",
            "task_update",
            "precise_calculator",
            "execute_javascript",
            "search_tools",
            "web_search",
          ]);
          const COORDINATOR_TOOL_NAMES = new Set(COORDINATOR_ONLY_TOOLS);
          const PRISM_LOCAL_TOOL_NAMES = InternalToolRegistry.getNames();

          count = schemas.filter(
            (toolSchema) =>
              enabledSet.has(toolSchema.name as string) ||
              (agentId !== "LUPOS" && (
                CORE_SYSTEM_TOOLS.has(toolSchema.name as string) ||
                COORDINATOR_TOOL_NAMES.has(toolSchema.name as string) ||
                PRISM_LOCAL_TOOL_NAMES.has(toolSchema.name as string)
              ))
          ).length;
        }
        sections.push(`## Available Tools (${count})\n` + toolDescriptions);
      }
    }

    // ── 5. Guidelines ─────────────────────────────────────────────
    // Custom persona guidelines are always injected when present.
    // The usesCodingGuidelines toggle controls the generic coding
    // fallback defaults and the coordinator mode addendum.
    // Direct mode skips all persona/coding guidelines.
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

    // ── 5b. Coordinator Mode Addendum (when coordinator tools available) ──
    if (!isDirectMode && (codingFallback || persona?.usesCodingGuidelines)) {
      const enabledSet = context.enabledTools ? new Set(context.enabledTools) : null;
      const coordinatorAvailable = enabledSet
        ? COORDINATOR_ONLY_TOOLS.some((t: string) => enabledSet.has(t))
        : true; // No filter = all tools available including coordinator

      if (coordinatorAvailable) {
        const allSchemas = ToolOrchestratorService.getToolSchemas();
        const coordinatorSet = new Set(COORDINATOR_ONLY_TOOLS);
        const workerTools = allSchemas
          .map((t) => t.name as string)
          .filter((name: string) => !coordinatorSet.has(name));
        sections.push(getCoordinatorPromptAddendum({ workerTools }));
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
    const lastUserMsg = [...(context.messages || [])]
      .reverse()
      .find((m) => m.role === "user");
    const queryText = (lastUserMsg?.content as string) || "";

    const skills = await this.fetchSkills(
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
      skillsText = `[Project Skills]\n` + skillBlocks.join("\n\n");
    }

    // ── 9. Session Memory (embedding search) ────────────────────
    const memoryQuery = queryText || context.project || "";
    let memoriesText = "";

    if (memoryQuery) {
      // Extract Discord scoping from agentContext for LUPOS memory search
      const agentCtxForMemory = context.agentContext || {};
      const memoryGuildId = agentCtxForMemory.guildId as string | undefined;
      const memoryUserIds = agentCtxForMemory.participantUserIds as string[] | undefined;

      const memories = await this.fetchMemories(
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
        memoriesText = `[Agent Memory]\n` + memories;
      }
    }

    return {
      prompt: sections.join("\n\n"),
      skillNames,
      skillsText,
      memoriesText,
    };
  }

  /**
   * Create a beforePrompt hook handler for AgentHooks.
   *
   * Replaces or creates the system message with the fully assembled prompt.
   * Any existing system message content from the client is ignored — the
   * backend is the single source of truth for the agent system prompt.
   */
  createHook() {
    return async (context: AssemblerContext) => {
      try {
        const {
          prompt: systemPrompt,
          skillNames,
          skillsText,
          memoriesText,
        } = await this.assemble(context);
        if (!systemPrompt) return;

        // Expose skill names on ctx for downstream emission
        context._injectedSkills = skillNames;

        // Replace existing system message or prepend a new one
        const systemIdx = context.messages?.findIndex(
          (m) => m.role === "system",
        );
        if (systemIdx !== undefined && systemIdx >= 0) {
          context.messages![systemIdx].content = systemPrompt;
        } else {
          context.messages?.unshift({ role: "system", content: systemPrompt });
        }

        // Prepend dynamic context (time, skills, memories) directly into the latest user message
        // to keep the agent time-aware and memory-aware while preserving prefix-cache validity of the system prompt
        if (context.messages) {
          const userMessages = context.messages.filter((m) => m.role === "user");
          const lastUserMsg = userMessages[userMessages.length - 1];
          if (lastUserMsg && typeof lastUserMsg.content === "string") {
            const contextLines: string[] = [];

            // 1. Local Time
            contextLines.push(
              `- Local Time: ${new Date().toLocaleString("en-US", {
                dateStyle: "full",
                timeStyle: "long",
              })}`,
            );

            let systemContextBlock = `[System Context]\n${contextLines.join("\n")}\n\n`;

            // 3. Dynamic Skills
            if (skillsText) {
              systemContextBlock += `${skillsText}\n\n`;
            }

            // 4. Dynamic Memories
            if (memoriesText) {
              systemContextBlock += `${memoriesText}\n\n`;
            }

            // Prevent double injection if already injected
            if (!lastUserMsg.content.startsWith("[System Context]")) {
              const msgIdx = context.messages.indexOf(lastUserMsg);
              if (msgIdx !== -1) {
                const originalContent = lastUserMsg.content;
                context.messages[msgIdx] = {
                  ...lastUserMsg,
                  rawContent: originalContent,
                  content: systemContextBlock + `[User Message]\n${originalContent}`,
                };
              }
            }
          }
        }

        logger.info(
          `[SystemPromptAssembler] Assembled ${systemPrompt.length} char static system prompt for agent="${context.agent || "DIRECT"}" (${skillNames.length} skills injected into user context)`,
        );
      } catch (error: unknown) {
        logger.error(
          `[SystemPromptAssembler] Assembly failed: ${(error as Error).message}`,
        );
      }
    };
  }
}
