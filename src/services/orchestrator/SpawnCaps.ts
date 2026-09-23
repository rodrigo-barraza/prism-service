import {
  DEFAULT_RECURSIVE_SPAWNING_DEPTH,
  MAXIMUM_RECURSIVE_SPAWNING_DEPTH,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { ORCHESTRATOR } from "#src/constants";
import SettingsService from "#src/services/SettingsService";
import logger from "#src/utils/logger";

// ────────────────────────────────────────────────────────────
// SpawnCaps — runaway caps on delegation, per ROOT conversation
// ────────────────────────────────────────────────────────────
// Three ceilings bound the whole delegation tree of one user conversation,
// whatever its agents ask for (Claude Code's defaults):
//   spawns     — sub-agents started over the conversation's life (200);
//                finished and evicted ones still count, and so does a
//                spawn whose worktree or loop then failed — a retry loop
//                is a runaway too
//   concurrent — sub-agents running at once (20)
//   depth      — how deep delegation nests; the root agent is depth 0 (3)
// Each is counted for ONE root conversation: two conversations never share
// a cap, so one conversation's fan-out cannot refuse another's spawns.
// Settings → `subAgentCaps` configures them. The depth cap bounds a
// conversation's own delegation depth (`maxRecursionDepth`, the client's
// choice, default 1); it never raises it.
//
// The ledger lives in this process: a restart starts every conversation's
// spawn count again.
// ────────────────────────────────────────────────────────────

export interface SpawnCapLimits {
  maxSpawnsPerConversation: number;
  maxConcurrentPerConversation: number;
  maxDepth: number;
}

export const DEFAULT_SPAWN_CAPS: Readonly<SpawnCapLimits> = Object.freeze({
  maxSpawnsPerConversation: ORCHESTRATOR.MAX_SPAWNS_PER_CONVERSATION,
  maxConcurrentPerConversation: ORCHESTRATOR.MAX_SUB_AGENTS,
  maxDepth: ORCHESTRATOR.MAX_DELEGATION_DEPTH,
});

/** A whole number ≥ `floor`, else the default. */
function wholeNumberAtLeast(value: unknown, floor: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= floor ? value : fallback;
}

/** The caps in force: Settings → `subAgentCaps`, a missing or malformed field → its default. */
export async function resolveSpawnCaps(): Promise<SpawnCapLimits> {
  let configured: Partial<Record<keyof SpawnCapLimits, unknown>> = {};
  try {
    configured =
      ((await SettingsService.getSection("subAgentCaps")) as typeof configured | undefined) ?? {};
  } catch (error: unknown) {
    logger.warn(`[SpawnCaps] Settings unreadable — default caps apply: ${getErrorMessage(error)}`);
  }
  return {
    maxSpawnsPerConversation: wholeNumberAtLeast(
      configured.maxSpawnsPerConversation,
      1,
      DEFAULT_SPAWN_CAPS.maxSpawnsPerConversation,
    ),
    maxConcurrentPerConversation: wholeNumberAtLeast(
      configured.maxConcurrentPerConversation,
      1,
      DEFAULT_SPAWN_CAPS.maxConcurrentPerConversation,
    ),
    // 0 turns delegation off everywhere; the taxonomy's ceiling still holds.
    maxDepth: Math.min(
      MAXIMUM_RECURSIVE_SPAWNING_DEPTH,
      wholeNumberAtLeast(configured.maxDepth, 0, DEFAULT_SPAWN_CAPS.maxDepth),
    ),
  };
}

/**
 * The delegation depth a conversation runs with: its own `maxRecursionDepth`
 * (else the taxonomy default), never deeper than the cap.
 */
export function capDelegationDepth(
  configuredDepth: number | null | undefined,
  caps: Pick<SpawnCapLimits, "maxDepth">,
): number {
  const configured =
    typeof configuredDepth === "number" && Number.isFinite(configuredDepth)
      ? Math.max(0, configuredDepth)
      : DEFAULT_RECURSIVE_SPAWNING_DEPTH;
  return Math.min(caps.maxDepth, configured);
}

// ── The ledger ───────────────────────────────────────────────

interface ConversationLedger {
  /** Sub-agents admitted over the conversation's life. */
  spawned: number;
  /**
   * Admitted, not yet registered as RUNNING. Parallel spawns (a router's
   * Promise.all) all pass the concurrency check before any of them
   * registers — the reservation is what makes the check hold for them.
   */
  reserved: number;
}

const ledgers = new Map<string, ConversationLedger>();

export type SpawnAdmission =
  | { admitted: true; spawnNumber: number; release: () => void }
  | { admitted: false; error: string };

/**
 * Admit one spawn into `rootConversationId`'s tree, or say which cap
 * refuses it. `running` is how many of its sub-agents run right now. An
 * admitted spawn holds a concurrency reservation until `release()` — call
 * it once the sub-agent is registered as running, or when the spawn fails
 * before that (idempotent).
 */
export function admitSpawn(
  rootConversationId: string,
  running: number,
  caps: SpawnCapLimits,
): SpawnAdmission {
  let ledger = ledgers.get(rootConversationId);
  if (!ledger) {
    ledger = { spawned: 0, reserved: 0 };
    ledgers.set(rootConversationId, ledger);
  }
  if (ledger.spawned >= caps.maxSpawnsPerConversation) {
    return {
      admitted: false,
      error:
        `Spawn limit reached: this conversation has started ${ledger.spawned} sub-agents ` +
        `(max ${caps.maxSpawnsPerConversation} per conversation). Finish the task without delegating further.`,
    };
  }
  if (running + ledger.reserved >= caps.maxConcurrentPerConversation) {
    return {
      admitted: false,
      error:
        `Maximum concurrent sub-agents (${caps.maxConcurrentPerConversation}) reached in this conversation. ` +
        `Wait for a sub-agent to complete or stop one.`,
    };
  }
  ledger.spawned++;
  ledger.reserved++;
  const admittedLedger = ledger;
  let released = false;
  return {
    admitted: true,
    spawnNumber: ledger.spawned,
    release() {
      if (released) return;
      released = true;
      admittedLedger.reserved--;
    },
  };
}

/** Sub-agents admitted so far in a conversation's tree. */
export function spawnsInConversation(rootConversationId: string): number {
  return ledgers.get(rootConversationId)?.spawned ?? 0;
}

/** Forget every conversation's count (tests; the orchestrator's full reset). */
export function resetSpawnLedgers(): void {
  ledgers.clear();
}
