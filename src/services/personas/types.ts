import type {
  AgentEffort,
  AgentPermissionMode,
} from "#src/services/agents/AgentDefinitionFields";
import type { AcpAgentLaunch, AgentRuntime } from "#src/services/agents/AgentRuntime";
import type { PolicyRule } from "#src/services/PolicyEngine";
import type { PinnablePermissionMode } from "#src/services/permissions/PermissionModes";
import type { EmotionPersonality } from "#src/services/somatic/SomaticConstants";
import type { RoleModelSpec } from "#src/services/routing/AgentModelPins";

export interface PersonaContext {
  enabledTools?: string[];
  /** Final resolved (callable) tool names from AgenticToolResolver — includes core-locked and innate discovery tools. Policy sections gate on these, so the prompt only ever references tools the model can actually call. */
  resolvedToolNames?: string[];
  /** The persona being assembled — injected by SystemPromptAssembler so shared policy builders can scope catalog-derived content (tool counts, domains) to it. */
  _persona?: Persona;
  agentContext?: Record<string, unknown>;
  locale?: string;
  [key: string]: unknown;
}

/**
 * A declarative tool policy section with optional tool requirements.
 *
 * When `requires` is set, the section is only injected into the system
 * prompt when at least one of the listed tools is present in the
 * resolved `enabledTools`. Supports exact names (`"generate_image"`)
 * and prefix globs (`"get_discord_*"`, `"list_lights"`).
 *
 * When `requires` is omitted or empty, the section is always included.
 */
export interface ToolPolicySection {
  content: string | ((locale: string) => string);
  /** Tool names or prefix globs (e.g. `"discord_*"`). Section is included when ANY match. */
  requires?: string[];
  /** When true, `requires` matches ONLY against the resolver's final callable
   *  tool names (`resolvedToolNames`), never the broader enabledTools entries.
   *  Use for sections that instruct calling a specific tool — the instruction
   *  must not render when the tool is absent from the native tool array.
   *  Falls back to the default union when resolvedToolNames is not provided
   *  (e.g. preview paths). */
  requiresResolved?: boolean;
}

/**
 * Serialized policy format stored in MongoDB for custom agents.
 * The `when` predicate function can't be serialized, so we store a
 * regex `pattern` and `field` that get reconstructed into a `when`
 * function at registration time.
 */
export interface SerializedPolicy {
  tool: string;
  decision: string;
  name?: string;
  /** Regex pattern to test against the argument field. */
  pattern?: string;
  /** Which argument field to test the pattern against (default: "command"). */
  field?: string;
}

export type PlatformKey = "discord" | "slack" | "teams" | "web" | string;

export interface Persona {
  id: string;
  name: string;
  type: string;
  project: string;
  displayOrder?: number;
  custom?: boolean;
  /** Where a custom agent was defined: a Mongo document or a workspace file. */
  source?: "database" | "file";
  /** The `.claude/agents` / `.prism/agents` file a file-defined agent came from. */
  sourcePath?: string;
  description?: string;
  /**
   * Agent-definition pins (prompt 17) — honoured when the agent is spawned as
   * a sub-agent: the model/provider/effort it runs on, its turn cap, and a
   * permission mode that can only narrow the parent's (OrchestratorService).
   */
  model?: string;
  provider?: string;
  effort?: AgentEffort;
  maxTurns?: number;
  permissionMode?: AgentPermissionMode;
  /**
   * What runs the agent as a sub-agent: Prism's own loop (absent), or an
   * external ACP agent process (`acp`, with its `acp` launch configuration
   * — agents/AgentRuntime). Only a stored (database) agent can name one.
   */
  runtime?: AgentRuntime;
  acp?: AcpAgentLaunch;
  /** Why a stored `acp` definition cannot run (its launch configuration is invalid). */
  runtimeErrors?: string[];
  icon?: string;
  avatar?: string;
  color?: string;
  backgroundImage?: string;
  identity: (context: PersonaContext) => string;
  guidelines: string;
  interactionRules: string;
  toolPolicy: string | ((context: PersonaContext) => string);
  availableTools: string[];
  /** Subset of availableTools that are active on the first iteration. When empty/undefined, all availableTools are enabled by default (backward-compatible). */
  enabledByDefaultTools?: string[];
  /** Post-filter denylist — strips tools after all resolution (supports domainKey:, domain:, label:, exact names). Tools explicitly in availableTools are protected. */
  blockedTools?: string[];
  /** Controls whether core tools are locked (always-on, non-toggleable) in the client UI. Default: true. */
  coreToolsLocked?: boolean;
  /** Declarative tool call policies (serialized for custom agents). */
  policies?: PolicyRule[];
  /**
   * The permission mode every root turn of this agent runs in, whatever the
   * request (`permissionMode`, `autoApprove`), the conversation or the
   * settings say — and "approve all" (full auto) never applies to it
   * (PermissionModeState.resolveTurnPermissionMode). Only modes that narrow
   * can be pinned. For an agent that acts for whoever talks to it: LUPOS runs
   * `dontAsk`, so a tool his APPROVE policies do not list and whose tier
   * would ask is refused, never parked on a card nobody in the channel sees.
   */
  pinnedPermissionMode?: PinnablePermissionMode;
  /**
   * Fire-and-forget tools (the StopAtTools pattern): when EVERY call of a
   * model response is one of these and the same response carried reply
   * text, the calls run and the turn ends with that text — no further model
   * call to read results nobody needs (harnesses/lifecycle/EndTurnAfterTools).
   * Any other tool in the batch, or no text, and the loop goes on as usual.
   * LUPOS: his emoji reaction.
   */
  endTurnAfterTools?: string[];
  /**
   * Pre-flight tool discovery's picks reach the model as an activation — a
   * tool-update message after the user's message, called through the fixed
   * `tool_call` bridge — instead of joining the declared tool block
   * (AgenticLoopService). Every conversation of the persona then sends the
   * same tools and the same system prompt, so a new conversation starts on
   * a cached prefix (audit K1). For personas whose every turn is a fresh
   * conversation (LUPOS: one per Discord reply). Bridge-mode providers
   * (Gemini, local models) only; elsewhere picks are declared as before.
   */
  activatePreflightTools?: boolean;
  /**
   * The persona's `requires`-gated tool-policy sections, when its toolPolicy
   * is built from them. A tool activated mid-turn brings the sections it
   * unlocks in its tool-update message — the system prompt was assembled
   * before it was callable.
   */
  toolPolicySections?: ToolPolicySection[];
  capabilities: string;
  /** When true, tool descriptions in the system prompt are truncated to the first sentence and optional parameters are omitted. Saves ~1,500 tokens for conversational agents that don't need full parameter docs. */
  compactToolDocs?: boolean;
  /**
   * System-prompt tool doc rendering tier. Default is "index" (one line per
   * tool — full parameter schemas travel in the native tool definitions and
   * full docs are injected on-demand when tools are enabled mid-turn).
   * Set "full" or "compact" to opt a persona back into heavier rendering.
   * Takes precedence over the legacy compactToolDocs flag.
   */
  toolDocMode?: "full" | "compact" | "index";
  /**
   * Platform-specific interaction rules, keyed by platform identifier.
   * Only the section matching the current platform (from agentContext.platform)
   * is injected into the system prompt. When absent, the agent has no
   * platform-specific behavior — it remains fully platform-agnostic.
   */
  platformRules?: Record<
    PlatformKey,
    string | ((context: PersonaContext) => string)
  >;
  /** When true, the assembler injects the agent's somatic state (from agentContext.selfContext) as an interleaved system message before the last user message. */
  hasSomaticState?: boolean;
  /**
   * Emotional dynamics tuning for hasSomaticState agents: resting baseline
   * levels (the persona's temperament), decay half-life, volatility, etc.
   * Omitted fields fall back to DEFAULT_EMOTION_PERSONALITY.
   */
  somaticPersonality?: Partial<EmotionPersonality>;
  /**
   * When true, the assembler injects a response-variety block (the agent's
   * recent replies across ALL conversations plus a per-turn delivery
   * seasoning) into self-context so consecutive replies don't converge on
   * the same openers, jokes, and rhythms.
   */
  usesResponseVariety?: boolean;
  /**
   * Explicit "thou shalt not" rules injected as a dedicated `<constraints>` block.
   * LLMs respond more reliably to explicit negative constraints than positive-only
   * instructions — stating what NOT to do with equal emphasis reduces hallucination
   * and policy violation rates. Each string is a single constraint rule.
   */
  negativeConstraints?: string[];
  usesDirectoryTree: boolean;
  usesCodingGuidelines: boolean;
  /**
   * Models this agent pins per role — `main` is the model it runs on,
   * `subagent` the model its sub-agents run on, and so on (MODEL_ROLES).
   * An agent definition outranks Settings; a custom agent outranks a
   * built-in persona (routing/RoleModelResolver).
   */
  modelRoles?: Partial<Record<string, RoleModelSpec>>;
  /** A routing preset this agent runs under (routing/RoutingPresets). */
  routingPreset?: string;
}
