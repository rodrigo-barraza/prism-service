import ToolOrchestratorService from "./ToolOrchestratorService.js";
import MemoryService from "./MemoryService.js";
import AgentPersonaRegistry from "./AgentPersonaRegistry.js";
import EmbeddingService from "./EmbeddingService.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { TOOLS_SERVICE_URL, MONGO_DB_NAME } from "../../config.js";
import logger from "../utils/logger.js";
import { cosineSimilarity } from "../utils/math.js";
import { getCoordinatorPromptAddendum, COORDINATOR_ONLY_TOOLS, } from "./CoordinatorPrompt.js";
import { createAbortController } from "../utils/AbortController.js";
import { DIRECTORY_CACHE_TTL_MS, DIRECTORY_FETCH_TIMEOUT_MS } from "../constants.js";
const SKILL_RELEVANCE_THRESHOLD = 0.3;
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
    constructor(options = {}) {
        this.workspaceRoot =
            options.workspaceRoot ||
                ToolOrchestratorService.getWorkspaceRoot() ||
                process.env.HOME ||
                "/home";
        this._directoryCache = null;
        this._directoryCacheTime = 0;
        this._directoryCacheTTL = DIRECTORY_CACHE_TTL_MS;
    }
    /**
     * Fetch project directory tree from tools-api.
     * Cached for 1 minute to avoid hammering the API.
     *
     * @returns {Promise<string>} Formatted directory tree
     */
    async fetchDirectoryTree() {
        const now = Date.now();
        if (this._directoryCache &&
            now - this._directoryCacheTime < this._directoryCacheTTL) {
            return this._directoryCache;
        }
        try {
            const controller = createAbortController();
            const timeout = setTimeout(() => controller.abort(), DIRECTORY_FETCH_TIMEOUT_MS);
            const url = `${TOOLS_SERVICE_URL}/filesystem/list?path=${encodeURIComponent(this.workspaceRoot)}&depth=2`;
            const response = await fetch(url, { signal: controller.signal });
            clearTimeout(timeout);
            if (!response.ok) {
                logger.warn(`[SystemPromptAssembler] Directory fetch failed: ${response.status}`);
                return "";
            }
            const data = await response.json();
            const tree = this._formatDirectoryTree(data);
            this._directoryCache = tree;
            this._directoryCacheTime = now;
            return tree;
        }
        catch (error) {
            logger.warn(`[SystemPromptAssembler] Directory fetch error: ${error.message}`);
            return this._directoryCache || "";
        }
    }
    /**
     * Format directory listing into a readable tree string.
  
  
     */
    _formatDirectoryTree(data) {
        if (!data || !data.entries)
            return "";
        const lines = [];
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
     *
  
  
     */
    buildToolDescriptions(enabledTools) {
        const schemas = ToolOrchestratorService.getToolSchemas();
        const enabledSet = enabledTools ? new Set(enabledTools) : null;
        const filtered = enabledSet
            ? schemas.filter((t) => enabledSet.has(t.name))
            : schemas;
        if (filtered.length === 0)
            return "";
        // Group by domain
        const groups = new Map();
        for (const tool of filtered) {
            const domain = (tool.domain || "Other").replace(/^Agentic:\s*/i, "");
            if (!groups.has(domain))
                groups.set(domain, []);
            groups.get(domain).push(tool);
        }
        // Build categorised sections with parameter details
        const sections = [];
        for (const [domain, domainTools] of groups) {
            const entries = domainTools.map((tool) => {
                const desc = tool.description || "";
                const params = tool.parameters?.properties || {};
                const paramNames = Object.keys(params);
                const required = tool.parameters?.required || [];
                const paramStr = paramNames
                    .map((p) => {
                    const isReq = required.includes(p);
                    const paramDesc = params[p].description || "";
                    return `  - ${p}${isReq ? " (required)" : ""}: ${paramDesc}`;
                })
                    .join("\n");
                return `### ${tool.name}\n${desc}\n${paramStr}`;
            });
            sections.push(`**${domain}**\n${entries.join("\n\n")}`);
        }
        return sections.join("\n\n");
    }
    /**
     * Fetch relevant memories via embedding similarity search.
     * Queries the unified `memories` collection using cosine similarity,
     * scoped by agent and project.
     *
  
  
     * @returns {Promise<string>} Formatted memory sections for the system prompt
     */
    async fetchMemories(agent, project, queryText, { traceId, agentSessionId, endpoint, _username } = {}) {
        try {
            const memories = await MemoryService.search({
                agent,
                project,
                queryText,
                limit: 10,
                traceId: traceId || null,
                agentSessionId: agentSessionId || null,
                endpoint: endpoint || "/agent",
            });
            if (!memories || memories.length === 0)
                return "";
            logger.info(`[SystemPromptAssembler] Memory search returned ${memories.length} results for ${agent}`);
            return MemoryService.formatForPrompt(memories);
        }
        catch (error) {
            logger.warn(`[SystemPromptAssembler] Memory fetch error: ${error.message}`);
            return "";
        }
    }
    /**
     * Fetch enabled skills relevant to the user's query via embedding similarity.
     *
  
  
     * @returns {Promise<Array<{ name: string, content: string, score: number }>>}
     */
    async fetchSkills(project, username, queryText, { traceId, agentSessionId, endpoint, agent } = {}) {
        try {
            const db = MongoWrapper.getDb(MONGO_DB_NAME);
            if (!db)
                return [];
            const skills = await db
                .collection("agent_skills")
                .find({ project, username, enabled: true })
                .project({ name: 1, content: 1, description: 1, embedding: 1 })
                .toArray();
            if (skills.length === 0)
                return [];
            // If no query or no skills have embeddings, return all (graceful fallback)
            const hasEmbeddings = skills.some((s) => s.embedding?.length > 0);
            if (!queryText || !hasEmbeddings) {
                logger.info(`[SystemPromptAssembler] Returning all ${skills.length} skills (no query or no embeddings)`);
                return skills.map((s) => ({
                    name: s.name,
                    content: s.content,
                    description: s.description,
                    score: 1,
                }));
            }
            // Generate query embedding
            let queryEmbedding;
            try {
                queryEmbedding = await EmbeddingService.embed(queryText, {
                    source: "skill-relevance",
                    project,
                    endpoint: endpoint || "/agent",
                    traceId: traceId || null,
                    agentSessionId: agentSessionId || null,
                    agent: agent || null,
                });
            }
            catch (error) {
                logger.warn(`[SystemPromptAssembler] Query embedding failed: ${error.message} — returning all skills`);
                return skills.map((s) => ({
                    name: s.name,
                    content: s.content,
                    description: s.description,
                    score: 1,
                }));
            }
            // Score and filter by relevance threshold
            const scored = skills
                .map((s) => ({
                name: s.name,
                content: s.content,
                description: s.description,
                score: s.embedding
                    ? cosineSimilarity(queryEmbedding, s.embedding)
                    : 0,
            }))
                .filter((s) => s.score >= SKILL_RELEVANCE_THRESHOLD)
                .sort((a, b) => b.score - a.score);
            logger.info(`[SystemPromptAssembler] Skills: ${scored.length}/${skills.length} above threshold (${scored.map((s) => `${s.name}:${s.score.toFixed(2)}`).join(", ")})`);
            return scored;
        }
        catch (error) {
            logger.warn(`[SystemPromptAssembler] Skills fetch error: ${error.message}`);
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
     *
  
     * @param {string} context.project - Project identifier
     * @param {string} context.username - Username
  
  
     * @param {Array} context.messages - Current messages array
  
     * @returns {Promise<{ prompt: string, skillNames: string[] }>} Complete system prompt + skill names for UI emission
     */
    async assemble(context) {
        const sections = [];
        // null/undefined agent = direct chat mode (no persona)
        const isDirectMode = !context.agent;
        const agentId = context.agent || "CODING";
        const persona = isDirectMode ? null : AgentPersonaRegistry.get(agentId);
        // If no persona found, fall back to CODING defaults (unless direct mode)
        const codingFallback = !isDirectMode && (!persona || persona.id === "CODING");
        // ── 1. Agent Identity ────────────────────────────────────────
        if (isDirectMode) {
            sections.push(`You are a helpful AI assistant with access to a comprehensive suite of real-time data and utility tools. Present data clearly with relevant formatting. For questions that don't require API data, respond naturally without tool calls.`);
        }
        else if (persona) {
            const identityText = typeof persona.identity === "function"
                ? persona.identity(context)
                : persona.identity;
            sections.push(identityText);
        }
        else {
            sections.push(`You are a highly capable coding agent with access to file system, git, command execution, and web tools.`);
        }
        // ── 2. Agent Context (runtime data from caller) ──────────────
        // Only injected when the caller provides agentContext (e.g. Lupos
        // sends Discord server/channel/participant info, trending data, etc.)
        if (context.agentContext) {
            const ac = context.agentContext;
            // Structured context blocks — each is a pre-formatted text block
            // assembled by the caller (Lupos/Prism Client/etc.)
            if (ac.discordContext) {
                sections.push(ac.discordContext);
            }
            if (ac.serverContext) {
                sections.push(ac.serverContext);
            }
            if (ac.imageContext) {
                sections.push(ac.imageContext);
            }
            if (ac.clockCrewContext) {
                sections.push(ac.clockCrewContext);
            }
            // Stickers kiosk context — stage flow, emotion state, visual context
            if (ac.stickersContext) {
                sections.push(ac.stickersContext);
            }
            if (ac.emotionContext) {
                sections.push(ac.emotionContext);
            }
            if (ac.visualContext) {
                sections.push(ac.visualContext);
            }
            // Discord IDs — explicitly inject so discord tools get the correct IDs
            // (the LLM cannot infer these from guild/channel names alone)
            if (ac.guildId) {
                let idsBlock = `# Discord IDs\n- Guild ID: ${ac.guildId}`;
                if (ac.channelId)
                    idsBlock += `\n- Channel ID: ${ac.channelId}`;
                sections.push(idsBlock);
            }
            // Lights context — current light states, night lock, automation mode
            if (ac.lightsContext) {
                sections.push(ac.lightsContext);
            }
        }
        // ── 3. Tool Policy (persona-specific) ────────────────────────
        if (persona?.toolPolicy) {
            const policyText = typeof persona.toolPolicy === "function"
                ? persona.toolPolicy(context)
                : persona.toolPolicy;
            if (policyText)
                sections.push(policyText);
        }
        // ── 4. Available Tools (domain-grouped) ──────────────────────
        // Always inject tool descriptions for any agent that has enabled tools.
        // This ensures every persona (CODING, LUPOS, future agents) gets the
        // same domain-grouped tool documentation in its system prompt.
        {
            const toolDescs = this.buildToolDescriptions(context.enabledTools);
            if (toolDescs) {
                const schemas = ToolOrchestratorService.getToolSchemas();
                const count = context.enabledTools
                    ? schemas.filter((t) => new Set(context.enabledTools).has(t.name))
                        .length
                    : schemas.length;
                sections.push(`## Available Tools (${count})\n` + toolDescs);
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
            }
            else if (codingFallback || persona?.usesCodingGuidelines) {
                sections.push(`## Coding Guidelines\n` +
                    `- Always read relevant files before making edits to understand context\n` +
                    `- After making changes, verify them by reading the modified section\n` +
                    `- Keep your explanations concise and technical\n` +
                    `\n## Command Execution\n` +
                    `- For dev servers and long-running processes (npm run dev, next dev, vite, nodemon, etc.), ALWAYS set run_in_background: true. These commands never terminate on their own.\n` +
                    `- You will receive the first ~2.5 seconds of output to confirm the server started correctly.\n` +
                    `- Do NOT use run_in_background for one-shot commands (npm install, npm test, git status, eslint, prettier, tsc, etc.) — let them complete normally.`);
            }
        }
        // ── 5b. Coordinator Mode Addendum (when coordinator tools available) ──
        if (!isDirectMode && (codingFallback || persona?.usesCodingGuidelines)) {
            const enabledSet = context.enabledTools ? new Set(context.enabledTools) : null;
            const coordinatorAvailable = enabledSet
                ? COORDINATOR_ONLY_TOOLS.some(((t) => enabledSet.has(t)))
                : true; // No filter = all tools available including coordinator
            if (coordinatorAvailable) {
                const allSchemas = ToolOrchestratorService.getToolSchemas();
                const coordinatorSet = new Set(COORDINATOR_ONLY_TOOLS);
                const workerTools = allSchemas
                    .map(((t) => t.name))
                    .filter((name) => !coordinatorSet.has(name));
                sections.push(getCoordinatorPromptAddendum({ workerTools }));
            }
        }
        // ── 6. Environment ───────────────────────────────────────────
        sections.push(`## Environment\n` +
            `- Date/Time: ${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" })}\n` +
            `- OS: Linux (WSL2)\n` +
            `- Workspace: ${this.workspaceRoot}`);
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
        const queryText = lastUserMsg?.content || "";
        const skills = await this.fetchSkills(context.project, context.username, queryText, {
            traceId: context.traceId,
            agentSessionId: context.agentSessionId,
            endpoint: "/agent",
            agent: agentId,
        });
        const skillNames = [];
        if (skills.length > 0) {
            const skillBlocks = skills.map((s) => {
                skillNames.push(s.name);
                return `### ${s.name}\n${s.content}`;
            });
            sections.push(`## Project Skills (${skills.length})\n` + skillBlocks.join("\n\n"));
        }
        // ── 9. Session Memory (embedding search) ────────────────────
        const memoryQuery = queryText || context.project || "";
        if (memoryQuery) {
            const memories = await this.fetchMemories(agentId, context.project, memoryQuery, {
                traceId: context.traceId,
                agentSessionId: context.agentSessionId,
                endpoint: "/agent",
                username: context.username,
            });
            if (memories) {
                sections.push(`## Agent Memory\n` + memories);
            }
        }
        return { prompt: sections.join("\n\n"), skillNames };
    }
    /**
     * Create a beforePrompt hook handler for AgentHooks.
     *
     * Replaces or creates the system message with the fully assembled prompt.
     * Any existing system message content from the client is ignored — the
     * backend is the single source of truth for the agent system prompt.
     *
  
     */
    createHook() {
        return async (context) => {
            try {
                const { prompt: systemPrompt, skillNames } = await this.assemble(context);
                if (!systemPrompt)
                    return;
                // Expose skill names on ctx for downstream emission
                context._injectedSkills = skillNames;
                // Replace existing system message or prepend a new one
                const systemIdx = context.messages?.findIndex((m) => m.role === "system");
                if (systemIdx !== undefined && systemIdx >= 0) {
                    context.messages[systemIdx].content = systemPrompt;
                }
                else {
                    context.messages?.unshift({ role: "system", content: systemPrompt });
                }
                logger.info(`[SystemPromptAssembler] Assembled ${systemPrompt.length} char system prompt for agent="${context.agent || "DIRECT"}" (${skillNames.length} skills)`);
            }
            catch (error) {
                logger.error(`[SystemPromptAssembler] Assembly failed: ${error.message}`);
            }
        };
    }
}
//# sourceMappingURL=SystemPromptAssembler.js.map