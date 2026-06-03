import type { PolicyRule } from "../PolicyEngine.ts";

export interface PersonaContext {
  enabledTools?: string[];
  agentContext?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A declarative tool policy section with optional tool requirements.
 *
 * When `requires` is set, the section is only injected into the system
 * prompt when at least one of the listed tools is present in the
 * resolved `enabledTools`. Supports exact names (`"generate_image"`)
 * and prefix globs (`"discord_*"`, `"lifx_*"`).
 *
 * When `requires` is omitted or empty, the section is always included.
 */
export interface ToolPolicySection {
  content: string;
  /** Tool names or prefix globs (e.g. `"discord_*"`). Section is included when ANY match. */
  requires?: string[];
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
  /** Post-filter denylist — strips tools after all resolution (supports domainKey:, domain:, label:, exact names). Tools explicitly in availableTools are protected. */
  blockedTools?: string[];
  /** Controls whether core tools are locked (always-on, non-toggleable) in the client UI. Default: true. */
  coreToolsLocked?: boolean;
  /** Declarative tool call policies (serialized for custom agents). */
  policies?: PolicyRule[];
  capabilities: string;
  usesDirectoryTree: boolean;
  usesCodingGuidelines: boolean;
}
