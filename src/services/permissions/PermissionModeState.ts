import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { AutoModeSession } from "./AutoModeSession.ts";
import {
  DEFAULT_PERMISSION_MODE,
  UNATTENDED_PERMISSION_MODE,
  canUseBypass,
  isPermissionMode,
  type PermissionMode,
} from "./PermissionModes.ts";

/**
 * PermissionModeState — the mode one running turn is in, and how it changes.
 *
 * A turn resolves its mode once, at the top of AgenticLoopService, into a
 * PermissionModeHandle carried on the loop options (`_permissionMode`).
 * Every AutoApprovalEngine built for the turn — the harness's, a branching
 * strategy's, `run_tool_program`'s — reads the handle on each check, and a
 * sub-agent receives the SAME handle, so a switch reaches the whole tree at
 * its next tool call. Root turns register their handle here by conversation
 * id, which is how `PUT /permissions/mode` switches a turn that is running.
 */

export type PermissionModeSource =
  /** The request named it (the client's selector, a caller's override). */
  | "request"
  /** The conversation's stored mode. */
  | "conversation"
  /** `settings.permissions.defaultMode`. */
  | "settings"
  /** An unattended run on a conversation that names no mode. */
  | "unattended"
  /** Switched mid-turn by the user (the selector). */
  | "user"
  /** The user approved the plan — plan mode is over. */
  | "plan_approved"
  /** `bypass` was asked for by someone it is not open to. */
  | "owner_check";

export interface PermissionModeChange {
  mode: PermissionMode;
  previousMode: PermissionMode;
  source: PermissionModeSource;
}

export class PermissionModeHandle {
  private current: PermissionMode;
  private currentSource: PermissionModeSource;
  /**
   * Auto mode's breaker, the user's words and the classifier's bill for this
   * turn. A sub-agent's derived handle is given its parent's
   * (subAgentModeHandle), so the delegation tree shares one.
   */
  autoMode = new AutoModeSession();
  /**
   * Nobody is watching this run: anything that would ask is denied, in any
   * mode. `dontAsk` implies it; a scheduled task or timer sets it on top of
   * whatever mode its conversation is in, so a plan-mode conversation stays
   * read-only when a timer fires on it.
   */
  readonly unattended: boolean;
  private readonly listeners = new Set<(change: PermissionModeChange) => void>();

  constructor(
    mode: PermissionMode,
    { source = "settings", unattended = false }: { source?: PermissionModeSource; unattended?: boolean } = {},
  ) {
    this.current = mode;
    this.currentSource = source;
    this.unattended = unattended;
  }

  get mode(): PermissionMode {
    return this.current;
  }

  get source(): PermissionModeSource {
    return this.currentSource;
  }

  /** A call that would ask must be denied instead. */
  get cannotAsk(): boolean {
    return this.unattended || this.current === "dontAsk";
  }

  /** Switch modes. Returns whether anything changed; listeners hear only real changes. */
  set(mode: PermissionMode, source: PermissionModeSource): boolean {
    if (mode === this.current) return false;
    const previousMode = this.current;
    this.current = mode;
    this.currentSource = source;
    for (const listener of this.listeners) {
      try {
        listener({ mode, previousMode, source });
      } catch (error: unknown) {
        logger.warn(`[PermissionModes] A mode-change listener failed: ${errorMessage(error)}`);
      }
    }
    return true;
  }

  onChange(listener: (change: PermissionModeChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** The mode a handle-less caller (a test, the rules tester) means. */
export function modeOf(handle: PermissionModeHandle | PermissionMode | null | undefined): PermissionMode {
  if (!handle) return DEFAULT_PERMISSION_MODE;
  return typeof handle === "string" ? handle : handle.mode;
}

// ── Running turns, by conversation ───────────────────────────────

const running = new Map<string, PermissionModeHandle>();

export const PermissionModeRegistry = {
  register(conversationId: string, handle: PermissionModeHandle): void {
    if (conversationId) running.set(conversationId, handle);
  },
  /** Only the handle that registered removes itself (a newer turn may have replaced it). */
  unregister(conversationId: string, handle: PermissionModeHandle): void {
    if (running.get(conversationId) === handle) running.delete(conversationId);
  },
  get(conversationId: string): PermissionModeHandle | null {
    return running.get(conversationId) ?? null;
  },
  /** Test seam. */
  clear(): void {
    running.clear();
  },
};

// ── Resolution at the top of a turn ──────────────────────────────

/** `settings.permissions.defaultMode`, or `default`. Never `bypass`: bypass is chosen, not inherited. */
export async function readDefaultPermissionMode(): Promise<PermissionMode> {
  try {
    const { default: SettingsService } = await import("#src/services/SettingsService");
    const section = (await SettingsService.getSection("permissions")) as
      | { defaultMode?: unknown }
      | undefined;
    const configured = section?.defaultMode;
    if (isPermissionMode(configured) && configured !== "bypass") return configured;
  } catch (error: unknown) {
    logger.warn(`[PermissionModes] Could not read the default mode: ${errorMessage(error)}`);
  }
  return DEFAULT_PERMISSION_MODE;
}

export interface ResolvedPermissionMode {
  mode: PermissionMode;
  source: PermissionModeSource;
  /** Set when `bypass` was asked for and refused. */
  refusedBypass?: { from: PermissionModeSource; reason: string };
}

/**
 * The mode a turn starts in:
 *
 *   1. the request's `permissionMode` (the client's selector, or a caller's
 *      explicit override);
 *   2. unattended runs: the conversation's stored mode when it names one
 *      other than `default`, else `dontAsk`;
 *   3. the conversation's stored mode;
 *   4. the settings default.
 *
 * `bypass` survives only for a username in PRISM_PERMISSION_BYPASS_OWNERS;
 * anyone else gets `default` and the refusal is reported.
 */
export async function resolveTurnPermissionMode({
  requested,
  unattended = false,
  storedMode,
  username,
}: {
  requested?: unknown;
  unattended?: boolean;
  storedMode: PermissionMode | null;
  username?: string | null;
}): Promise<ResolvedPermissionMode> {
  let resolved: ResolvedPermissionMode;
  if (isPermissionMode(requested)) {
    resolved = { mode: requested, source: "request" };
  } else if (unattended) {
    resolved =
      storedMode && storedMode !== DEFAULT_PERMISSION_MODE
        ? { mode: storedMode, source: "conversation" }
        : { mode: UNATTENDED_PERMISSION_MODE, source: "unattended" };
  } else if (storedMode) {
    resolved = { mode: storedMode, source: "conversation" };
  } else {
    resolved = { mode: await readDefaultPermissionMode(), source: "settings" };
  }

  if (resolved.mode === "bypass" && !canUseBypass(username)) {
    return {
      mode: unattended ? UNATTENDED_PERMISSION_MODE : DEFAULT_PERMISSION_MODE,
      source: "owner_check",
      refusedBypass: {
        from: resolved.source,
        reason: `bypass is owner-only and "${username || "anonymous"}" is not a bypass owner`,
      },
    };
  }
  return resolved;
}
