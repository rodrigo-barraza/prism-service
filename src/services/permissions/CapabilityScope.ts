import { CAPABILITIES, type Capability } from "./types.ts";

// ────────────────────────────────────────────────────────────
// CapabilityScope — what a delegated or unattended run may do at all
// ────────────────────────────────────────────────────────────
// CapScope (arXiv 2609.08371) and Bounded Agents (2608.15888): cap a run's
// authority from the trusted request BEFORE it reads anything untrusted, and
// hold the cap outside the model. A sub-agent, a scheduled task and a goal's
// continuation (the agent working on its own after the verifier sent it
// back) each get a capability set declared when they are spawned, scheduled
// or set — `{ network: false }`, `{ network_write: false, shell: false }` —
// and the approval engine refuses any call whose tool carries a capability
// the set takes away. Nothing the model reads can widen it: a declaration
// only ever narrows, and a child's set is its own denials plus every
// ancestor's.
//
// The names are the capability tags tools declare (permissions/types.ts,
// tools-service ToolCapabilities.ts), plus `network_write`: a network call
// that can change something — network together with a side effect, a shell
// or a file write — so "no network writes" leaves reads alone.
// ────────────────────────────────────────────────────────────

export const NARROWABLE_CAPABILITIES = [...CAPABILITIES, "network_write"] as const;
export type NarrowableCapability = (typeof NARROWABLE_CAPABILITIES)[number];

const NARROWABLE = new Set<string>(NARROWABLE_CAPABILITIES);

/** What a spawn, a schedule or a goal declares: `false` takes a capability away; `true` changes nothing. */
export type CapabilityDeclaration = Partial<Record<NarrowableCapability, boolean>>;

/** A run's narrowed set: the capabilities it may not use. */
export interface CapabilityScope {
  denied: NarrowableCapability[];
}

export type CapabilityDeclarationParse =
  | { ok: true; declaration: CapabilityDeclaration | null }
  | { ok: false; error: string };

/**
 * A declaration from untyped input (a tool argument, a request body, a
 * stored document). Absent → null. Unknown names and non-boolean values are
 * an error, not ignored: a typo in "no network" must not run with network.
 */
export function parseCapabilityDeclaration(value: unknown): CapabilityDeclarationParse {
  if (value === undefined || value === null) return { ok: true, declaration: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: `capabilities must be an object such as { "network": false } — names: ${NARROWABLE_CAPABILITIES.join(", ")}`,
    };
  }
  const declaration: CapabilityDeclaration = {};
  for (const [name, allowed] of Object.entries(value as Record<string, unknown>)) {
    if (!NARROWABLE.has(name)) {
      return {
        ok: false,
        error: `unknown capability "${name}" — names: ${NARROWABLE_CAPABILITIES.join(", ")}`,
      };
    }
    if (typeof allowed !== "boolean") {
      return { ok: false, error: `capabilities.${name} must be true or false` };
    }
    declaration[name as NarrowableCapability] = allowed;
  }
  return { ok: true, declaration: Object.keys(declaration).length > 0 ? declaration : null };
}

function sortedUnique(names: Iterable<NarrowableCapability>): NarrowableCapability[] {
  const set = new Set(names);
  return NARROWABLE_CAPABILITIES.filter((name) => set.has(name));
}

/** The scope a declaration makes; null when it takes nothing away. */
export function scopeFromDeclaration(
  declaration: CapabilityDeclaration | null | undefined,
): CapabilityScope | null {
  if (!declaration) return null;
  const denied = sortedUnique(
    (Object.entries(declaration) as Array<[NarrowableCapability, boolean]>)
      .filter(([, allowed]) => allowed === false)
      .map(([name]) => name),
  );
  return denied.length > 0 ? { denied } : null;
}

/** A declaration showing a scope (what the API returns and the model is told). */
export function declarationOfScope(scope: CapabilityScope | null | undefined): CapabilityDeclaration | null {
  if (!scope || scope.denied.length === 0) return null;
  return Object.fromEntries(scope.denied.map((name) => [name, false])) as CapabilityDeclaration;
}

/** A scope from a stored or passed-on value — `{ denied: [...] }` or a declaration. Null when none. */
export function parseCapabilityScope(value: unknown): CapabilityScope | null {
  if (!value || typeof value !== "object") return null;
  const denied = (value as { denied?: unknown }).denied;
  if (Array.isArray(denied)) {
    const names = denied.filter(
      (name): name is NarrowableCapability => typeof name === "string" && NARROWABLE.has(name),
    );
    return names.length > 0 ? { denied: sortedUnique(names) } : null;
  }
  const parsed = parseCapabilityDeclaration(value);
  return parsed.ok ? scopeFromDeclaration(parsed.declaration) : null;
}

/** Every denial of every scope — a child keeps each ancestor's. Null when nothing is taken away. */
export function narrowScope(...scopes: Array<CapabilityScope | null | undefined>): CapabilityScope | null {
  const denied = sortedUnique(scopes.flatMap((scope) => scope?.denied ?? []));
  return denied.length > 0 ? { denied } : null;
}

/** The capability of `capabilities` the scope takes away, if any. */
export function scopeDenial(
  scope: CapabilityScope | null | undefined,
  capabilities: readonly Capability[],
): NarrowableCapability | null {
  if (!scope) return null;
  for (const name of scope.denied) {
    if (name === "network_write") {
      if (
        capabilities.includes("network") &&
        (capabilities.includes("external_side_effect") ||
          capabilities.includes("shell") ||
          capabilities.includes("fs_write"))
      ) {
        return name;
      }
    } else if (capabilities.includes(name)) {
      return name;
    }
  }
  return null;
}

const CAPABILITY_WORDS: Record<NarrowableCapability, string> = {
  fs_read: "reading files",
  fs_write: "writing files",
  shell: "the shell",
  network: "the network",
  mcp: "MCP tools",
  subagent: "delegating to sub-agents",
  memory_write: "saving memories",
  external_side_effect: "actions outside the workspace",
  network_write: "network writes",
};

const CAPABILITY_LABELS: Record<NarrowableCapability, string> = {
  fs_read: "file reads",
  fs_write: "file writes",
  shell: "shell",
  network: "network",
  mcp: "MCP tools",
  subagent: "sub-agents",
  memory_write: "memory writes",
  external_side_effect: "outside actions",
  network_write: "network writes",
};

/** "no network, no shell" — for logs, the model and the UI. */
export function describeScope(scope: CapabilityScope | null | undefined): string {
  if (!scope || scope.denied.length === 0) return "no narrowing";
  return scope.denied.map((name) => `no ${CAPABILITY_LABELS[name]}`).join(", ");
}

/** What the model is told when a call is out of its run's scope. */
export function capabilityScopeDenialReason(
  toolName: string,
  capability: NarrowableCapability,
  scope: CapabilityScope,
): string {
  return (
    `[Capability scope] "${toolName}" uses ${CAPABILITY_WORDS[capability]}, which this run may not use ` +
    `(it was started with ${describeScope(scope)}). The scope was fixed when the run was spawned, scheduled ` +
    `or given its goal, and nothing in the conversation can widen it: do the work without it, or report ` +
    `that it needs ${CAPABILITY_WORDS[capability]}.`
  );
}

/** The overlay a goal's continuation narrows the run with (lifecycle/GoalGate). */
export const GOAL_SCOPE_KEY = "goal";

/**
 * A run's live scope. The base is fixed at spawn or schedule time; a goal's
 * continuation narrows it further while the agent works on its own
 * (lifecycle/GoalGate), and releases that when it stops. Every approval
 * engine of the run reads `current` on each call.
 */
export class CapabilityScopeHandle {
  readonly base: CapabilityScope | null;
  private readonly overlays = new Map<string, CapabilityScope>();

  constructor(base: CapabilityScope | null = null) {
    this.base = base;
  }

  get current(): CapabilityScope | null {
    return narrowScope(this.base, ...this.overlays.values());
  }

  /** Narrow the run further under `key` (null narrows nothing). */
  narrow(key: string, scope: CapabilityScope | null | undefined): void {
    if (scope && scope.denied.length > 0) this.overlays.set(key, scope);
    else this.overlays.delete(key);
  }

  release(key: string): void {
    this.overlays.delete(key);
  }
}

/** The scope a run holds right now, from its handle or a fixed scope. */
export function currentScope(
  value: CapabilityScopeHandle | CapabilityScope | null | undefined,
): CapabilityScope | null {
  if (!value) return null;
  if (value instanceof CapabilityScopeHandle) return value.current;
  return parseCapabilityScope(value);
}

// ── Live scopes, for what a run schedules ───────────────────

const liveScopes = new Map<string, CapabilityScopeHandle>();

/**
 * The scope of every run in progress, by its loop key — what a scheduled
 * task created from inside a run inherits: the tools-service hop that
 * creates it forwards the run's `x-conversation-id` (ScheduledTasksRoutes),
 * so a narrowed sub-agent cannot schedule its way out of its scope.
 */
export const LiveCapabilityScopes = {
  register(loopKey: string, handle: CapabilityScopeHandle): void {
    if (loopKey) liveScopes.set(loopKey, handle);
  },
  unregister(loopKey: string, handle: CapabilityScopeHandle): void {
    if (liveScopes.get(loopKey) === handle) liveScopes.delete(loopKey);
  },
  current(loopKey: string | null | undefined): CapabilityScope | null {
    return loopKey ? (liveScopes.get(loopKey)?.current ?? null) : null;
  },
  /** Test seam. */
  _clear(): void {
    liveScopes.clear();
  },
};
