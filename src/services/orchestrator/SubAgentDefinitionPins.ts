import type { Persona } from "#src/services/personas/types";
import type { PolicyRule } from "#src/services/PolicyEngine";
import type { AgentPermissionMode } from "#src/services/agents/AgentDefinitionFields";
import { PermissionModeHandle } from "#src/services/permissions/PermissionModeState";
import { resolveToolEntriesToSet } from "#src/utils/resolveToolEntriesToSet";

// ────────────────────────────────────────────────────────────
// SubAgentDefinitionPins — what an agent definition changes about a
// sub-agent it is spawned as (prompt 17, Landing 2)
// ────────────────────────────────────────────────────────────
//   model / provider / effort  the model it runs on, whatever the parent's
//   maxTurns                   its iteration cap (a run that hits it is `partial`)
//   disallowedTools            removed from the tools it inherits
//   permissionMode             may only NARROW the parent's approval mode
//   policies                   its own, evaluated beside the parent's
// ────────────────────────────────────────────────────────────

/** The model a definition pins, on its provider (else the parent's); null = no pin. */
export function pinnedSubAgentModel(
  definition: Persona | null | undefined,
  currentProviderName: string,
): { providerName: string; resolvedModel: string } | null {
  if (!definition?.model) return null;
  return {
    providerName: definition.provider || currentProviderName,
    resolvedModel: definition.model,
  };
}

/** The per-run knobs a definition pins. */
export interface SubAgentRunPins {
  maxIterations: number;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  /** Gemini's effort knob; the provider forwards it only to a model that declares the level. */
  thinkingLevel?: string;
}

/**
 * A run's iteration cap and effort with the definition's `maxTurns` and
 * `effort` applied. A pinned effort means thinking at that effort — unless
 * it is "none".
 */
export function applyRunPins(
  definition: Persona | null | undefined,
  current: { maxIterations: number; thinkingEnabled?: boolean; reasoningEffort?: string },
): SubAgentRunPins {
  const pins: SubAgentRunPins = { ...current };
  if (definition?.maxTurns) pins.maxIterations = definition.maxTurns;
  if (definition?.effort) {
    pins.reasoningEffort = definition.effort;
    pins.thinkingLevel = definition.effort;
    pins.thinkingEnabled = definition.effort !== "none";
  }
  return pins;
}

export interface SubAgentApproval {
  autoApprove: boolean;
  /** The sub-agent's permission mode (for the permission-mode layer); none = the tier's. */
  permissionMode?: AgentPermissionMode;
  /** The definition asked for a wider mode than the parent's; this is what it got instead. */
  narrowedFrom?: AgentPermissionMode;
}

/** Modes that restrict; the stricter of two wins (plan > dontAsk). */
const RESTRICTING_MODES: readonly AgentPermissionMode[] = ["plan", "dontAsk"];

/**
 * A sub-agent's approval mode from its parent's and its definition's.
 * A definition can only make its sub-agent STRICTER than the parent:
 *
 *   (none)                    the parent's mode, as before.
 *   default                   asks per tier, even under a parent that auto-approves.
 *   plan                      read-only; approvals off, and the sub-agent's mode
 *                             handle is `plan` (subAgentModeHandle), so a write is refused.
 *   dontAsk                   asks become denials; the parent's approvals stand.
 *   acceptEdits/auto/bypass   never wider than the parent: the parent's mode
 *                             (`narrowedFrom` records the request when that is less).
 *
 * A parent already in `plan` or `dontAsk` passes it down: a child is never looser.
 */
export function resolveSubAgentApproval(
  parent: { autoApprove: boolean; permissionMode?: AgentPermissionMode | null },
  requested: AgentPermissionMode | null | undefined,
): SubAgentApproval {
  const parentMode = parent.permissionMode ?? undefined;
  const parentRestriction = parentMode && RESTRICTING_MODES.includes(parentMode) ? parentMode : undefined;

  if (!requested) {
    return { autoApprove: parent.autoApprove, ...(parentMode && { permissionMode: parentMode }) };
  }
  if (requested === "plan") {
    return { autoApprove: false, permissionMode: "plan" };
  }
  if (requested === "dontAsk") {
    return {
      autoApprove: parent.autoApprove && parentRestriction !== "plan",
      permissionMode: parentRestriction === "plan" ? "plan" : "dontAsk",
    };
  }
  if (requested === "default") {
    return { autoApprove: false, permissionMode: parentRestriction ?? "default" };
  }
  // acceptEdits / auto / bypass — widening modes: exactly the parent's.
  return {
    autoApprove: parent.autoApprove && parentRestriction !== "plan",
    ...(parentMode && { permissionMode: parentMode }),
    ...(!parent.autoApprove && { narrowedFrom: requested }),
  };
}

/**
 * The permission-mode handle a sub-agent runs under (permission-modes'
 * PermissionModeHandle). With no mode in its definition it shares its
 * parent's handle, so a switch of the parent's mode reaches it. A definition
 * that names a mode gets a handle of its own: the parent's mode narrowed by
 * resolveSubAgentApproval, re-narrowed on every switch of the parent's —
 * a `plan` agent stays read-only under a parent in acceptEdits, and a child
 * of an unattended run can ask nobody either. `dispose` stops the following
 * when the sub-agent's run ends.
 */
export function subAgentModeHandle(
  parent: PermissionModeHandle,
  parentAutoApprove: boolean,
  requested: AgentPermissionMode | null | undefined,
): { handle: PermissionModeHandle; dispose: () => void } {
  if (!requested) return { handle: parent, dispose: () => {} };
  const narrow = (mode: AgentPermissionMode): AgentPermissionMode =>
    resolveSubAgentApproval({ autoApprove: parentAutoApprove, permissionMode: mode }, requested)
      .permissionMode ?? mode;
  const handle = new PermissionModeHandle(narrow(parent.mode), {
    source: parent.source,
    unattended: parent.unattended,
  });
  const dispose = parent.onChange((change) => {
    handle.set(narrow(change.mode), change.source);
  });
  return { handle, dispose };
}

/**
 * The policies a sub-agent runs under: the parent's (delegation must not
 * escape a DENY) and, when it is a different agent, its own definition's —
 * tagged as their own layer so PolicyEngine takes the stronger verdict of
 * the two instead of letting one list's specific APPROVE beat the other's
 * wildcard DENY. Undefined = none (AgenticLoopService then applies the
 * sub-agent persona's own, the pre-existing path).
 */
export function composeSubAgentPolicies(
  parentPolicies: PolicyRule[] | null | undefined,
  parentAgent: string | null | undefined,
  definition: Persona | null | undefined,
): PolicyRule[] | undefined {
  const inherited = parentPolicies ?? [];
  const isOtherAgent = !!definition && definition.id.toUpperCase() !== (parentAgent ?? "").toUpperCase();
  const own = isOtherAgent ? definition!.policies ?? [] : [];
  if (own.length === 0) return inherited.length > 0 ? inherited : undefined;
  if (inherited.length === 0) return own;
  return [...inherited, ...own.map((rule) => ({ ...rule, layer: `agent:${definition!.id}` }))];
}

/**
 * `tools` minus a definition's `disallowedTools` (exact names, `domain:`,
 * `domainKey:` and `label:` entries). Needed because the tool resolver's
 * `blockedTools` never strips a tool that is in the explicit enabled list —
 * and a sub-agent's list is explicit (inherited from its parent).
 */
export function withoutDisallowedTools(
  tools: string[],
  disallowedTools: string[] | undefined,
  schemas: Parameters<typeof resolveToolEntriesToSet>[1],
): string[] {
  if (!disallowedTools?.length) return tools;
  const blocked = resolveToolEntriesToSet(disallowedTools, schemas);
  for (const entry of disallowedTools) blocked.add(entry);
  return tools.filter((toolName) => !blocked.has(toolName));
}
