import type { PolicyRule } from "#src/services/PolicyEngine";

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
  description?: string;
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
   * Explicit "thou shalt not" rules injected as a dedicated `<constraints>` block.
   * LLMs respond more reliably to explicit negative constraints than positive-only
   * instructions — stating what NOT to do with equal emphasis reduces hallucination
   * and policy violation rates. Each string is a single constraint rule.
   */
  negativeConstraints?: string[];
  usesDirectoryTree: boolean;
  usesCodingGuidelines: boolean;
}
