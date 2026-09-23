import logger from "#src/utils/logger";
import type { PolicyRule, PolicyDecision } from "./PolicyEngine.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  AgentDefinitionFileCache,
  type AgentDefinitionFile,
  type AgentDefinitionFileError,
  type ShadowedAgentDefinitionFile,
} from "./agents/AgentDefinitionFiles.ts";
import { normalizeAgentDefinitionFields } from "./agents/AgentDefinitionFields.ts";
import {
  ACP_RUNTIME,
  normalizeAgentRuntime,
  type NormalizedAgentRuntime,
} from "./agents/AgentRuntime.ts";
import {
  BUILT_IN_PERSONAS,
  type Persona,
  type PersonaContext,
  type ToolPolicySection,
  type SerializedPolicy,
  buildToolPolicy,
} from "./personas/index.ts";

const PERSONAS = new Map<string, Persona>(BUILT_IN_PERSONAS);

// ── File-defined agents ──────────────────────────────────────
// `.prism/agents` / `.claude/agents` files under the workspace roots
// (agents/AgentDefinitionFiles). A layer BELOW the built-ins and the Mongo
// custom agents: those win a clash of id or name, and the clash is logged.

/** Personas from agent files, keyed by agent id. */
const FILE_PERSONAS = new Map<string, Persona>();
let fileAgentCache: AgentDefinitionFileCache | null = null;
/** Set when a database agent comes or goes — what the files shadow may change. */
let isFileLayerStale = false;
let fileAgentReport: {
  errors: AgentDefinitionFileError[];
  shadowed: ShadowedAgentDefinitionFile[];
} = { errors: [], shadowed: [] };

/** A name reduced to its agent-id slug: "Code Reviewer" / "code-reviewer" → "CODE_REVIEWER". */
function nameSlug(name: string | undefined | null): string {
  return (name ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The database/built-in persona an agent file would collide with, if any. */
function findEarlierLayerClash(definition: AgentDefinitionFile): Persona | null {
  const direct = PERSONAS.get(definition.agentId);
  if (direct) return direct;
  const slug = nameSlug(definition.name);
  for (const persona of PERSONAS.values()) {
    if (nameSlug(persona.name) === slug || nameSlug(persona.id) === slug) return persona;
  }
  return null;
}

/** Re-read the agent files (throttled; a no-op until the registry is given roots). */
function syncFileAgents(force = false): void {
  if (!fileAgentCache) return;
  const scan = fileAgentCache.scan({ force });
  if (!scan.changed && !force && !isFileLayerStale) return;
  isFileLayerStale = false;
  FILE_PERSONAS.clear();
  const shadowed = [...scan.shadowed];
  for (const definition of scan.definitions) {
    const clash = findEarlierLayerClash(definition);
    if (clash) {
      const layer = clash.custom ? "database custom agent" : "built-in agent";
      shadowed.push({ path: definition.path, agentId: definition.agentId, shadowedBy: `${layer} "${clash.name}" (${clash.id})` });
      continue;
    }
    AgentPersonaRegistry.registerCustom(
      {
        agentId: definition.agentId,
        name: definition.name,
        description: definition.fields.description,
        identity: definition.prompt,
        project: "prism-chat",
        // No `tools` = the parent's enabled tools, as in Claude Code.
        availableTools: definition.fields.tools ?? ["*"],
        ...definition.fields,
        ...(definition.color && { color: definition.color }),
        ...(definition.icon && { icon: definition.icon }),
      },
      { source: "file", sourcePath: definition.path },
    );
  }
  for (const entry of shadowed) {
    logger.warn(`[AgentPersonaRegistry] Agent file ${entry.path} (${entry.agentId}) is shadowed by ${entry.shadowedBy} — not registered`);
  }
  fileAgentReport = { errors: scan.errors, shadowed };
  logger.info(
    `[AgentPersonaRegistry] ${FILE_PERSONAS.size} file-defined agent(s) registered` +
      (scan.errors.length > 0 ? `, ${scan.errors.length} file(s) rejected` : ""),
  );
}

/** Every persona: built-ins and database agents, then unshadowed file agents. */
function allPersonas(): Persona[] {
  return [
    ...PERSONAS.values(),
    ...[...FILE_PERSONAS.values()].filter((persona) => !PERSONAS.has(persona.id)),
  ];
}

// ── Registry API ─────────────────────────────────────────────────

const AgentPersonaRegistry = {
  get(agentId: string): Persona | null {
    if (!agentId) return null;
    const key = agentId.toUpperCase();
    const persona = PERSONAS.get(key);
    if (persona) return persona;
    syncFileAgents();
    const filePersona = FILE_PERSONAS.get(key);
    if (filePersona) return filePersona;
    logger.warn(`[AgentPersonaRegistry] Unknown agent: "${agentId}"`);
    return null;
  },

  /**
   * An agent by id OR by name, as a model names it in `create_subagent`'s
   * `agent` argument: "Coding", "Clankerbox", "code-reviewer", "My Agent",
   * "CUSTOM_MY_AGENT". Ids first, then names (case, spaces and dashes
   * ignored); built-ins outrank database agents, which outrank files.
   */
  resolve(nameOrId: string | null | undefined): Persona | null {
    const requested = (nameOrId ?? "").trim();
    if (!requested) return null;
    syncFileAgents();
    const key = requested.toUpperCase();
    const byId = PERSONAS.get(key) ?? FILE_PERSONAS.get(key);
    if (byId) return byId;
    const slug = nameSlug(requested);
    if (!slug) return null;
    const personas = allPersonas();
    return (
      personas.find((persona) => nameSlug(persona.name) === slug) ??
      personas.find((persona) => persona.id === `CUSTOM_${slug}`) ??
      null
    );
  },

  list() {
    syncFileAgents();
    return allPersonas()
      .sort(
        (firstPersona, secondPersona) =>
          (firstPersona.displayOrder ?? 100) -
          (secondPersona.displayOrder ?? 100),
      )
      .map((persona) => ({
        id: persona.id,
        name: persona.name,
        type: persona.type || "",
        description: persona.description || "",
        ...(persona.custom ? { custom: true, source: persona.source ?? "database" } : {}),
        ...(persona.runtime === ACP_RUNTIME ? { runtime: ACP_RUNTIME } : {}),
      }));
  },

  has(agentId: string): boolean {
    const key = (agentId || "").toUpperCase();
    if (PERSONAS.has(key)) return true;
    syncFileAgents();
    return FILE_PERSONAS.has(key);
  },

  isAgentProject(project: string): boolean {
    if (!project) return false;
    for (const persona of allPersonas()) {
      if (persona.project === project) return true;
    }
    return false;
  },

  /**
   * Register a custom (user-defined) agent persona at runtime.
   * Converts a MongoDB document into a persona object compatible
   * with the built-in format, then inserts into the PERSONAS map.
   */
  registerCustom(
    doc: Record<string, unknown>,
    { source = "database", sourcePath }: { source?: "database" | "file"; sourcePath?: string } = {},
  ) {
    if (!doc?.agentId || typeof doc.agentId !== "string") return;

    // model / provider / effort / tools / disallowedTools / maxTurns /
    // permissionMode — validated here too: a stored document predating the
    // route's validation keeps its valid fields and drops the rest.
    const { fields: definitionFields, errors: definitionErrors } =
      normalizeAgentDefinitionFields(doc);
    if (definitionErrors.length > 0) {
      logger.warn(
        `[AgentPersonaRegistry] Agent ${doc.agentId}: ignoring invalid field(s) — ${definitionErrors.join("; ")}`,
      );
    }

    // An external runtime (an ACP agent process) is a stored agent's alone:
    // a workspace file never starts a process through its definition. An
    // `acp` agent whose launch configuration is invalid keeps its runtime
    // — it must never silently run as a Prism agent instead — and cannot
    // be spawned (the spawn names the errors).
    const runtimeDefinition: NormalizedAgentRuntime =
      source === "database" ? normalizeAgentRuntime(doc) : { errors: [] };
    if (runtimeDefinition.errors.length > 0) {
      logger.warn(
        `[AgentPersonaRegistry] Agent ${doc.agentId}: invalid runtime — ${runtimeDefinition.errors.join("; ")}`,
      );
    }
    const isAcpAgent = runtimeDefinition.runtime === ACP_RUNTIME;

    // Reconstruct PolicyRules from serialized format
    const rawPolicies = Array.isArray(doc.policies)
      ? (doc.policies as SerializedPolicy[])
      : [];
    const policies: PolicyRule[] = rawPolicies.map((serializedPolicy) => {
      const rule: PolicyRule = {
        tool: serializedPolicy.tool || "*",
        decision: (serializedPolicy.decision as PolicyDecision) || "ASK_USER",
        name:
          serializedPolicy.name ||
          `${serializedPolicy.decision}(${serializedPolicy.tool})`,
      };
      // Reconstruct `when` predicate from pattern string
      if (
        serializedPolicy.pattern &&
        typeof serializedPolicy.pattern === "string"
      ) {
        try {
          const regex = new RegExp(serializedPolicy.pattern);
          const field = serializedPolicy.field || "command";
          rule.when = (args: Record<string, unknown>) =>
            regex.test(String(args[field] ?? ""));
        } catch {
          // FAIL CLOSED. Dropping the predicate made the rule match every
          // call of its tool — right for DENY and ASK_USER, but an APPROVE
          // with a typo'd pattern approved everything. It now approves
          // nothing; DENY and ASK_USER keep covering every call.
          if (rule.decision === "APPROVE") rule.when = () => false;
          logger.warn(
            `[AgentPersonaRegistry] Invalid regex pattern "${serializedPolicy.pattern}" in ${rule.decision} policy for agent ${doc.agentId} — ` +
              (rule.decision === "APPROVE"
                ? "it approves nothing"
                : `it applies to every ${rule.tool} call`),
          );
        }
      }
      return rule;
    });

    const persona: Persona = {
      id: doc.agentId as string,
      name: (doc.name as string) || (doc.agentId as string),
      type: (doc.type as string) || "",
      description: (doc.description as string) || "",
      project: (doc.project as string) || "prism-chat",
      custom: true,
      source,
      ...(sourcePath && { sourcePath }),
      ...(definitionFields.model && { model: definitionFields.model }),
      ...(definitionFields.provider && { provider: definitionFields.provider }),
      ...(definitionFields.effort && { effort: definitionFields.effort }),
      ...(definitionFields.maxTurns && { maxTurns: definitionFields.maxTurns }),
      ...(definitionFields.permissionMode && { permissionMode: definitionFields.permissionMode }),
      ...(definitionFields.disallowedTools?.length && { blockedTools: definitionFields.disallowedTools }),
      ...(isAcpAgent && {
        runtime: ACP_RUNTIME,
        ...(runtimeDefinition.acp
          ? { acp: runtimeDefinition.acp }
          : { runtimeErrors: runtimeDefinition.errors }),
      }),
      icon: (doc.icon as string) || "",
      avatar: (doc.avatar as string) || "",
      color: (doc.color as string) || "",
      backgroundImage: (doc.backgroundImage as string) || "",
      identity: () => (doc.identity as string) || "",
      guidelines: (doc.guidelines as string) || "",
      interactionRules: "",
      toolPolicy: (personaContext: PersonaContext) => {
        // Support structured ToolPolicySection[] stored in MongoDB,
        // or fall back to wrapping a plain string as a single section.
        const raw = doc.toolPolicy;
        let sections: ToolPolicySection[];

        if (Array.isArray(raw)) {
          sections = (raw as Array<Record<string, unknown>>).map((section) => ({
            content: (section.content as string) || "",
            ...(Array.isArray(section.requires)
              ? { requires: section.requires as string[] }
              : {}),
          }));
        } else {
          const text = (raw as string) || "";
          sections = text ? [{ content: text }] : [];
        }

        return buildToolPolicy(sections, personaContext);
      },
      availableTools: Array.isArray(doc.availableTools)
        ? (doc.availableTools as string[])
        : Array.isArray(doc.enabledTools)
          ? (doc.enabledTools as string[])
          : [],
      enabledByDefaultTools: Array.isArray(doc.enabledByDefaultTools)
        ? (doc.enabledByDefaultTools as string[])
        : undefined,
      policies: policies.length > 0 ? policies : undefined,
      capabilities: "",
      platformRules:
        typeof doc.platformRules === "object" &&
        doc.platformRules !== null &&
        Object.keys(doc.platformRules as object).length > 0
          ? (doc.platformRules as Record<string, string>)
          : undefined,
      hasSomaticState: (doc.hasSomaticState as boolean) || false,
      negativeConstraints: Array.isArray(doc.negativeConstraints)
        ? (doc.negativeConstraints as string[])
        : undefined,
      usesDirectoryTree: (doc.usesDirectoryTree as boolean) || false,
      usesCodingGuidelines: (doc.usesCodingGuidelines as boolean) || false,
      modelRoles:
        typeof doc.modelRoles === "object" && doc.modelRoles !== null
          ? (doc.modelRoles as Persona["modelRoles"])
          : undefined,
      routingPreset:
        typeof doc.routingPreset === "string" && doc.routingPreset
          ? doc.routingPreset
          : undefined,
    };

    if (source === "file") {
      FILE_PERSONAS.set(doc.agentId as string, persona);
      return;
    }
    isFileLayerStale = true;
    PERSONAS.set(doc.agentId as string, persona);
    logger.info(
      `[AgentPersonaRegistry] Registered custom agent: "${doc.name}" (${doc.agentId}) with ${persona.availableTools.length} tools, ${policies.length} policies` +
        (persona.runtime === ACP_RUNTIME ? `, runtime acp (${persona.acp?.command ?? "invalid launch configuration"})` : ""),
    );
  },

  unregister(agentId: string) {
    if (!agentId) return;
    const key = agentId.toUpperCase();
    const persona = PERSONAS.get(key);
    if (persona?.custom) {
      PERSONAS.delete(key);
      isFileLayerStale = true;
      logger.info(`[AgentPersonaRegistry] Unregistered custom agent: "${key}"`);
    }
  },

  /**
   * Load agents from `.prism/agents` / `.claude/agents` under `roots()` (read
   * on every scan, so roots configured later are picked up). Files are
   * re-read at most once a second, and re-parsed only when they change.
   */
  useAgentDefinitionFiles(roots: () => readonly string[], minimumScanIntervalMilliseconds = 1_000) {
    fileAgentCache = new AgentDefinitionFileCache(
      roots,
      minimumScanIntervalMilliseconds,
      (filePath, result) => {
        if ("error" in result) {
          logger.warn(`[AgentPersonaRegistry] Agent file ${filePath} rejected: ${result.error}`);
        }
      },
    );
    FILE_PERSONAS.clear();
    syncFileAgents(true);
  },

  /** Re-scan the agent files now, ignoring the throttle. */
  refreshFileAgents() {
    syncFileAgents(true);
  },

  /** The file-defined agents, and the files that did not become one (and why). */
  describeFileAgents() {
    syncFileAgents();
    return {
      agents: [...FILE_PERSONAS.values()]
        .filter((persona) => !PERSONAS.has(persona.id))
        .map((persona) => ({
          agentId: persona.id,
          name: persona.name,
          description: persona.description || "",
          path: persona.sourcePath || "",
          ...(persona.model && { model: persona.model }),
          ...(persona.provider && { provider: persona.provider }),
          ...(persona.effort && { effort: persona.effort }),
          ...(persona.maxTurns && { maxTurns: persona.maxTurns }),
          ...(persona.permissionMode && { permissionMode: persona.permissionMode }),
        })),
      errors: fileAgentReport.errors,
      shadowed: fileAgentReport.shadowed,
    };
  },

  /**
   * Load all custom agents from the database and register them.
   * Called at startup and can be called to refresh after mutations.
   */
  async loadCustomAgents() {
    try {
      const { default: CustomAgentService } =
        await import("./CustomAgentService.ts");
      const agents = await CustomAgentService.list();

      // Clear existing custom agents first
      for (const [key, persona] of PERSONAS) {
        if (persona.custom) PERSONAS.delete(key);
      }
      isFileLayerStale = true;

      for (const document of agents) {
        this.registerCustom(document);
      }

      logger.info(
        `[AgentPersonaRegistry] Loaded ${agents.length} custom agent(s) from database`,
      );
    } catch (error: unknown) {
      logger.warn(
        `[AgentPersonaRegistry] Failed to load custom agents: ${getErrorMessage(error)}`,
      );
    }
  },
};

export default AgentPersonaRegistry;
export type { Persona, PersonaContext, ToolPolicySection };
