import crypto from "node:crypto";
import NativeSteerRegistry from "#src/services/NativeSteerRegistry";
import { SYSTEM_MESSAGE_TAGS, wrapSystemMessage } from "#src/utils/SystemMessageTags";
import logger from "#src/utils/logger";
import type { DecisionOwner } from "#src/services/PendingDecisionStore";

/**
 * TurnInputMailbox — input that arrives WHILE a turn is running.
 *
 * Until now the only channels into a running agentic loop were the approval
 * and question resolvers (a promise the loop is already blocked on) and the
 * stop signal. Anything else the user typed waited in the client until the
 * turn finished and was then sent as a fresh turn. This module is the third
 * channel: a per-turn mailbox the harness drains at its safe execution
 * boundaries (top of an iteration, after a tool batch, and at the point
 * where it would otherwise end the turn on a text-only response).
 *
 * Four kinds of input ride the same box:
 *   - `user_update`      the user steering the current task (POST /agent/input)
 *   - `question_answer`  the answer to a NON-blocking ask_user card
 *   - `task_completion`  an async task / sub-agent finished while the parent
 *                        kept working (instead of waking a new turn later)
 *   - `agent_message`    a parent's send_subagent_message to a RUNNING
 *                        sub-agent (previously queued into a field nobody read)
 *   - `hook_context`     the `additionalContext` of an async configured hook
 *                        that finished while the turn kept going
 *   - `goal_revision`    the goal verifier's gaps: the agent claimed the goal
 *                        done and the verifier disagrees (lifecycle/GoalGate)
 *
 * Keyed by the loop's client-facing `conversationId` — for a root turn that
 * is the id the client holds; for a sub-agent it is the sub-agent's own
 * conversation id (the orchestrator posts with that). One turn per
 * conversation at a time, same invariant as ApprovalRegistry.
 *
 * An entry is only accepted while a turn is OPEN, so a caller that gets
 * `accepted: false` knows to queue the message as the next turn instead.
 * What a box accepts is also written through to TurnInputStore (when the
 * turn opened it with its owner) and forgotten when the turn closes it: an
 * entry accepted by a turn a restart interrupted is delivered once after
 * the restart — into the re-driven turn, or into the transcript
 * (TurnResumeService).
 *
 * A turn that has decided to end SEALS its box first (ReActHarness, before
 * it counts background work and finalizes): from then on a post is refused
 * exactly as if the box were closed. Without the seal, input arriving during
 * finalize was accepted and then dropped by `close()` — a sub-agent team's
 * whole result, or a user's update, lost to a window of database writes.
 *
 * Native steering (NativeSteerRegistry): a text `user_update` posted while
 * the turn's provider stream can steer natively is HELD — invisible to
 * drain() — and offered to the stream. The harness takes it when the
 * provider applied it (`take`); otherwise it is released and drained here
 * like any other entry.
 */

export type TurnInputKind =
  | "user_update"
  | "question_answer"
  | "task_completion"
  | "agent_message"
  | "hook_context"
  | "goal_revision";

export interface TurnInputEntry {
  id: string;
  kind: TurnInputKind;
  /** Plain text of the input. For notifications, the already-formatted block. */
  text: string;
  images?: string[];
  receivedAt: number;
  /** Producer-specific metadata, copied verbatim onto the injected message. */
  meta?: Record<string, unknown>;
  /** Offered to the provider's native steering; held from drain() until it answers. */
  offeredNatively?: boolean;
}

export interface TurnInputPost {
  kind: TurnInputKind;
  text: string;
  images?: string[];
  meta?: Record<string, unknown>;
}

interface Mailbox {
  entries: TurnInputEntry[];
  openedAt: number;
  /** Total accepted over the life of the turn (for diagnostics / acks). */
  acceptedCount: number;
  /** The turn is ending: posts are refused as `no_active_turn`. */
  sealed: boolean;
  /** Who runs the turn — set when its entries are kept durably (TurnInputStore). */
  owner: DecisionOwner | null;
  /** Durably kept entries of this box, forgotten when it closes. */
  recordedIds: string[];
}

/** Write an accepted entry through to TurnInputStore (lazily: this module stays light). */
function recordDurably(conversationId: string, box: Mailbox, entry: TurnInputEntry): void {
  if (!box.owner) return;
  box.recordedIds.push(entry.id);
  const owner = box.owner;
  void import("./TurnInputStore.ts")
    .then(({ default: TurnInputStore }) => TurnInputStore.record(conversationId, entry, owner))
    .catch(() => {
      /* best-effort: the entry still reaches the running turn */
    });
}

const mailboxes = new Map<string, Mailbox>();

/** Hard cap so a runaway producer cannot grow a turn's context unboundedly. */
export const TURN_INPUT_MAXIMUM_PENDING = 50;
/** A single user update is bounded like a normal prompt would be. */
export const TURN_INPUT_MAXIMUM_TEXT_LENGTH = 20_000;

const TurnInputMailbox = {
  /**
   * Open the mailbox for a turn. Idempotent; re-opening keeps pending
   * entries. With the turn's `owner`, what it accepts is kept durably.
   */
  open(conversationId: string, owner?: DecisionOwner | null): void {
    if (!conversationId) return;
    const existing = mailboxes.get(conversationId);
    if (existing) {
      existing.sealed = false;
      if (owner) existing.owner = owner;
      return;
    }
    mailboxes.set(conversationId, {
      entries: [],
      openedAt: Date.now(),
      acceptedCount: 0,
      sealed: false,
      owner: owner ?? null,
      recordedIds: [],
    });
    logger.debug(`[TurnInputMailbox] Opened for ${conversationId} (open=${mailboxes.size})`);
  },

  /**
   * Whether a turn of this conversation is running in this process — open,
   * or sealed while it finalizes.
   */
  hasTurn(conversationId: string): boolean {
    return mailboxes.has(conversationId);
  },

  /** Whether a turn is currently accepting input for this conversation. */
  isOpen(conversationId: string): boolean {
    const box = mailboxes.get(conversationId);
    return !!box && !box.sealed;
  },

  /**
   * The turn has decided to end: refuse every further post (as
   * `no_active_turn`, so producers take their after-the-turn path) while
   * the harness finalizes. Pending entries stay drainable.
   */
  seal(conversationId: string): void {
    const box = mailboxes.get(conversationId);
    if (box) box.sealed = true;
  },

  /**
   * Post input to a running turn. Returns `accepted: false` when no turn is
   * open — the caller then queues it as the next turn (client) or takes the
   * wake-a-new-turn path (task completion).
   */
  post(
    conversationId: string,
    input: TurnInputPost,
  ): { accepted: boolean; id?: string; position?: number; reason?: string } {
    const box = mailboxes.get(conversationId);
    if (!box || box.sealed) return { accepted: false, reason: "no_active_turn" };
    if (box.entries.length >= TURN_INPUT_MAXIMUM_PENDING) {
      return { accepted: false, reason: "mailbox_full" };
    }
    const text = typeof input.text === "string" ? input.text : "";
    if (!text.trim() && !(input.images && input.images.length > 0)) {
      return { accepted: false, reason: "empty_input" };
    }
    const entry: TurnInputEntry = {
      id: `input-${crypto.randomUUID().slice(0, 8)}`,
      kind: input.kind,
      text: text.slice(0, TURN_INPUT_MAXIMUM_TEXT_LENGTH),
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      receivedAt: Date.now(),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    box.entries.push(entry);
    box.acceptedCount++;
    recordDurably(conversationId, box, entry);
    logger.info(
      `[TurnInputMailbox] ${input.kind} ${entry.id} queued for ${conversationId} (pending=${box.entries.length})`,
    );
    offerNatively(conversationId, entry);
    return { accepted: true, id: entry.id, position: box.entries.length };
  },

  /**
   * Put back an entry a restart interrupted before its turn took it — same
   * id, same arrival time (TurnResumeService). It is already kept durably;
   * this box forgets it when it closes. False when no turn is open.
   */
  restore(conversationId: string, entry: TurnInputEntry): boolean {
    const box = mailboxes.get(conversationId);
    if (!box || box.sealed) return false;
    box.entries.push({ ...entry });
    box.acceptedCount++;
    if (box.owner) box.recordedIds.push(entry.id);
    logger.info(
      `[TurnInputMailbox] ${entry.kind} ${entry.id} restored for ${conversationId} after a restart`,
    );
    return true;
  },

  /** Take every pending entry, in arrival order. Empty when nothing is pending. */
  drain(conversationId: string): TurnInputEntry[] {
    const box = mailboxes.get(conversationId);
    if (!box || box.entries.length === 0) return [];
    // An entry offered to native steering stays until the harness takes it
    // (applied) or the offer is released (fallback).
    const drained = box.entries.filter((entry) => !entry.offeredNatively);
    if (drained.length === 0) return [];
    box.entries = box.entries.filter((entry) => entry.offeredNatively);
    return drained;
  },

  /** Number of entries waiting for the next boundary (held native offers excluded). */
  pendingCount(conversationId: string): number {
    return (
      mailboxes.get(conversationId)?.entries.filter((entry) => !entry.offeredNatively)
        .length ?? 0
    );
  },

  /**
   * Remove and return the entries the provider applied natively (by id, in
   * arrival order). The caller records them; nothing re-injects them.
   */
  take(conversationId: string, ids: string[]): TurnInputEntry[] {
    const box = mailboxes.get(conversationId);
    if (!box || ids.length === 0) return [];
    const wanted = new Set(ids);
    const taken = box.entries.filter((entry) => wanted.has(entry.id));
    box.entries = box.entries.filter((entry) => !wanted.has(entry.id));
    return taken;
  },

  /**
   * Close the mailbox at the end of the turn. Returns whatever was still
   * pending so the caller can decide what to do with it (the harness drains
   * right before finalize, so this is normally empty).
   */
  close(conversationId: string): TurnInputEntry[] {
    const box = mailboxes.get(conversationId);
    if (!box) return [];
    mailboxes.delete(conversationId);
    if (box.recordedIds.length > 0) {
      const ids = box.recordedIds;
      void import("./TurnInputStore.ts")
        .then(({ default: TurnInputStore }) => TurnInputStore.forget(ids))
        .catch(() => {
          /* best-effort: a leftover entry is recognised by its id at the next boot */
        });
    }
    if (box.entries.length > 0) {
      logger.warn(
        `[TurnInputMailbox] Closed ${conversationId} with ${box.entries.length} undelivered entr${box.entries.length === 1 ? "y" : "ies"}`,
      );
    }
    return box.entries;
  },

  /** Diagnostics. */
  get openCount(): number {
    return mailboxes.size;
  },

  /** Test helper — drop every mailbox. */
  _clearAll(): void {
    mailboxes.clear();
  },
};

/**
 * A text update the running stream can steer with natively is held and
 * offered; a `fallback` answer releases it to the next drain. (`applied` is
 * the harness's to act on — it takes the entry when the stream says so.)
 */
function offerNatively(conversationId: string, entry: TurnInputEntry): void {
  if (entry.kind !== "user_update" || entry.images?.length) return;
  const sender = NativeSteerRegistry.get(conversationId);
  if (!sender) return;
  entry.offeredNatively = true;
  const release = () => {
    entry.offeredNatively = false;
  };
  sender
    .steer({
      id: entry.id,
      // The same wrapper the drain would inject, so the transcript and the
      // model's context carry one form of the update.
      text: wrapSystemMessage(SYSTEM_MESSAGE_TAGS.USER_UPDATE, entry.text),
    })
    .then((outcome) => {
      if (outcome === "fallback") release();
    })
    .catch(release);
}

export default TurnInputMailbox;
