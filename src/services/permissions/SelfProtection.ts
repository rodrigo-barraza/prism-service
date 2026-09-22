import type { Capability } from "./types.ts";

/**
 * SelfProtection — an agent cannot change its own permissions.
 *
 * The rules live in Mongo behind `/permissions/rules`, not in a file an
 * agent could be denied write access to, so the protection is on the ways a
 * tool call could reach them: the REST routes (rules, approvals, custom-agent
 * policies, the settings keys that relax gating), the collections, and the
 * settings page a browser tool could click through.
 *
 * It is a built-in DENY evaluated before every other layer — no rule, mode or
 * approval relaxes it — and it only inspects tools that can act outside the
 * workspace files (shell, MCP, external side effects). File tools are left
 * alone on purpose: an agent editing Prism's own source legitimately writes
 * the string `permission_rules`, and a file write reaches no running service.
 *
 * This is a tripwire, not a sandbox. A determined shell can still build the
 * URL from pieces; the OS sandbox (modernization item #14) is what closes
 * that. What this does guarantee is that the obvious call — the one a
 * prompt-injected agent would make — is refused and named.
 */

interface ProtectedTarget {
  name: string;
  /** Every pattern must match somewhere in the call's strings. */
  patterns: RegExp[];
}

const PROTECTED_TARGETS: ProtectedTarget[] = [
  { name: "permission rules API", patterns: [/\/permissions\/(rules|mode|settings)\b/i] },
  { name: "permission collections", patterns: [/\bpermission_(rules|decisions)\b/i] },
  { name: "approval endpoint", patterns: [/\/agent\/approve\b/i] },
  { name: "custom agent policies", patterns: [/\/custom-agents\b/i, /\bpolicies\b/i] },
  {
    // An HTTP origin in front of `/settings`, so a local `…/settings.json`
    // next to the word "permission" in a shell line doesn't trip it.
    name: "approval settings",
    patterns: [
      /(https?:\/\/|localhost|127\.0\.0\.1|:\d{2,5})[^\s"'`]*\/settings\b/i,
      /\b(permissions?|autoApprove|enableCriticGate|critic(Provider|Model))\b/i,
    ],
  },
  { name: "permission settings page", patterns: [/[?&]section=permissions?\b/i] },
];

const INSPECTED_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "shell",
  "mcp",
  "external_side_effect",
]);

const MAX_DEPTH = 6;
const MAX_CHARACTERS = 200_000;

function collectStrings(value: unknown, depth: number, out: string[], budget: { left: number }): void {
  if (budget.left <= 0 || depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") {
    const slice = value.slice(0, budget.left);
    budget.left -= slice.length;
    out.push(slice);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) collectStrings(element, depth + 1, out, budget);
    return;
  }
  if (typeof value === "object") {
    for (const [key, element] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      collectStrings(element, depth + 1, out, budget);
    }
  }
}

export interface SelfProtectionHit {
  target: string;
  reason: string;
}

export function checkSelfProtection(
  call: { name: string; args: Record<string, unknown> },
  capabilities: readonly Capability[],
): SelfProtectionHit | null {
  if (!capabilities.some((capability) => INSPECTED_CAPABILITIES.has(capability))) {
    return null;
  }
  const strings: string[] = [];
  collectStrings(call.args ?? {}, 0, strings, { left: MAX_CHARACTERS });
  const text = strings.join("\n");
  for (const target of PROTECTED_TARGETS) {
    if (target.patterns.every((pattern) => pattern.test(text))) {
      return {
        target: target.name,
        reason:
          `[Self-Protection] "${call.name}" would reach the ${target.name}. ` +
          `An agent cannot change its own permissions or approve its own calls; ` +
          `ask the user to change them in Settings → Permissions.`,
      };
    }
  }
  return null;
}
