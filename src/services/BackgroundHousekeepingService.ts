// ────────────────────────────────────────────────────────────
// BackgroundHousekeepingService — Boot-Time & Scheduled Cleanup
// ────────────────────────────────────────────────────────────
// Proactive cleanup of orphaned resources that survive crashes
// and unclean shutdowns. Runs once at boot and on a periodic
// interval (default 6h).
//
// Three cleanup targets:
//   1. Orphaned worktrees in /tmp/prism-worktrees/ (>24h)
//   2. Stale MongoDB sessions/request-logs
//   3. MinIO orphan objects (tombstoned references)
//
// Modeled on Claude Code's src/utils/backgroundHousekeeping.ts
// ────────────────────────────────────────────────────────────

import { readdir, stat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MILLISECONDS_PER_DAY,
  hours,
} from "@rodrigo-barraza/utilities-library";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import MinioWrapper from "../wrappers/MinioWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS, FILE_CATEGORIES } from "../constants.ts";
import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Worktrees older than this are considered orphaned */
const WORKTREE_MAX_AGE_MS = MILLISECONDS_PER_DAY;

/** Temp worktree root directory used by OrchestratorService */
const WORKTREE_ROOT = "/tmp/prism-worktrees";

/** Request logs older than this are pruned (keep 90 days) */
const REQUEST_LOG_MAX_AGE_DAYS = 90;

/** Stale isGenerating flags left from crashes */
const STALE_CONVERSATION_CUTOFF_MS = hours(2);

export interface HousekeepingWorktreeResult {
  pruned: string[];
  errors: string[];
}

export interface HousekeepingConversationResult {
  conversationsCleared: number;
  agentConversationsCleared: number;
}

export interface HousekeepingResult {
  worktrees?: HousekeepingWorktreeResult | { error: string };
  staleConversations?: HousekeepingConversationResult | { error: string };
  requestLogs?: { deleted: number } | { error: string };
  minioOrphans?: { removed: number } | { error: string };
  durationMs: number;
  trigger: string;
}

// ─── Worktree Pruning ─────────────────────────────────────────────────────────

/**
 * Remove orphaned worktrees in /tmp/prism-worktrees/ older than 24h.
 * These accumulate when sub-agents crash or the process is killed without
 * running CleanupRegistry teardown.
 */
async function pruneOrphanedWorktrees(): Promise<HousekeepingWorktreeResult> {
  const pruned: string[] = [];
  const errors: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(WORKTREE_ROOT);
  } catch {
    return { pruned, errors };
  }

  if (entries.length === 0) return { pruned, errors };

  const cutoff = Date.now() - WORKTREE_MAX_AGE_MS;

  for (const entry of entries) {
    const entryPath = resolve(WORKTREE_ROOT, entry);
    try {
      const info = await stat(entryPath);
      if (!info.isDirectory()) continue;

      if (info.mtimeMs < cutoff) {
        await rm(entryPath, { recursive: true, force: true });
        pruned.push(entry);
      }
    } catch (error: unknown) {
      errors.push(`${entry}: ${getErrorMessage(error)}`);
    }
  }

  return { pruned, errors };
}

// ─── Stale Conversation Cleanup ────────────────────────────────────────────────
// Clear isGenerating flags that were left dangling by a crash.
// Also removes conversations that have been in "generating" state for >2h.
async function clearStaleConversations(): Promise<HousekeepingConversationResult> {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return { conversationsCleared: 0, agentConversationsCleared: 0 };

  const cutoff = new Date(Date.now() - STALE_CONVERSATION_CUTOFF_MS).toISOString();

  const [convResult, agentConvResult] = await Promise.all([
    db
      .collection(COLLECTIONS.MODEL_CONVERSATIONS)
      .updateMany(
        { isGenerating: true, updatedAt: { $lt: cutoff } },
        { $set: { isGenerating: false } },
      ),
    db
      .collection(COLLECTIONS.AGENT_CONVERSATIONS)
      .updateMany(
        { isGenerating: true, updatedAt: { $lt: cutoff } },
        { $set: { isGenerating: false } },
      ),
  ]);

  return {
    conversationsCleared: convResult.modifiedCount,
    agentConversationsCleared: agentConvResult.modifiedCount,
  };
}

// ─── Old Request Log Pruning ──────────────────────────────────────────────────

/**
 * Remove request logs older than REQUEST_LOG_MAX_AGE_DAYS.
 * Keeps the DB from growing unbounded over time.
 */
async function pruneOldRequestLogs(): Promise<number> {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return 0;

  const cutoff = new Date(
    Date.now() - REQUEST_LOG_MAX_AGE_DAYS * MILLISECONDS_PER_DAY,
  ).toISOString();
  const result = await db.collection(COLLECTIONS.REQUESTS).deleteMany({
    timestamp: { $lt: cutoff },
  });

  return result.deletedCount;
}

// ─── MinIO Orphan Cleanup ─────────────────────────────────────────────────────

/**
 * Known top-level prefixes used by FileService and other structured storage.
 * Objects under these prefixes are NOT conversation-scoped and must never be
 * treated as orphans based on conversation ID matching.
 */
const STRUCTURAL_PREFIXES: Set<string> = new Set([
  FILE_CATEGORIES.PROJECTS,
  FILE_CATEGORIES.UPLOADS,
  FILE_CATEGORIES.GENERATIONS,
]);

/**
 * Find MinIO objects that no longer have matching MongoDB references.
 * This handles cases where a conversation is deleted but the MinIO
 * objects (screenshots, file artifacts) remain.
 *
 * Conservative approach: only orphan-checks objects whose top-level prefix
 * looks like a conversation ID (not a known structural prefix like "projects/").
 */
async function pruneMinioOrphans(): Promise<number> {
  if (!MinioWrapper.isAvailable()) return 0;

  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return 0;

  let removed = 0;

  try {
    // Stream IDs instead of distinct() to avoid materializing the entire array
    const validIds = new Set<string>();
    const convCursor = db
      .collection(COLLECTIONS.MODEL_CONVERSATIONS)
      .find<{ id: string }>({}, { projection: { id: 1, _id: 0 } });
    const agentConvCursor = db
      .collection(COLLECTIONS.AGENT_CONVERSATIONS)
      .find<{ id: string }>({}, { projection: { id: 1, _id: 0 } });
    for await (const document of convCursor) validIds.add(document.id);
    for await (const document of agentConvCursor) validIds.add(document.id);

    // List MinIO objects with the conversation-scoped prefix pattern
    // Convention: conversation objects are stored as {conversationId}/{filename}
    // FileService objects use: projects/{project}/{user}/{category}/{uuid}.{ext}
    const objects = (await MinioWrapper.listObjects("").catch(() => [])) as (
      | string
      | { name?: string }
    )[];
    if (objects.length === 0) return 0;

    // Group objects by their top-level prefix — only check prefixes that are
    // NOT known structural paths (projects/, uploads/, generations/, etc.)
    const prefixes = new Set<string>();
    for (const object of objects) {
      const name = typeof object === "string" ? object : object?.name;
      const prefix = name ? name.split("/")[0] : "";
      if (prefix && !validIds.has(prefix) && !STRUCTURAL_PREFIXES.has(prefix)) {
        prefixes.add(prefix);
      }
    }

    // Remove orphaned prefixes
    for (const prefix of prefixes) {
      const orphanedObjects = objects.filter((orphanedObject) => {
        const name =
          typeof orphanedObject === "string"
            ? orphanedObject
            : orphanedObject?.name;
        return name ? name.startsWith(`${prefix}/`) : false;
      });
      for (const object of orphanedObjects) {
        try {
          const name = typeof object === "string" ? object : object?.name;
          if (name) {
            await MinioWrapper.remove(name);
            removed++;
          }
        } catch {
          // Best-effort — skip failures
        }
      }
    }
  } catch (error: unknown) {
    logger.warn(
      `[Housekeeping] MinIO orphan scan failed: ${getErrorMessage(error)}`,
    );
  }

  return removed;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const BackgroundHousekeepingService = {
  /**
   * Run all housekeeping tasks.
   * Safe to call at any time — each task is independent and failure-tolerant.
   */
  async run({
    trigger = "boot",
  }: { trigger?: string } = {}): Promise<HousekeepingResult> {
    const startTime = performance.now();
    logger.info(`[Housekeeping] Starting (trigger: ${trigger})…`);

    const results: Partial<HousekeepingResult> = {};

    // 1. Prune orphaned worktrees
    try {
      const worktrees = await pruneOrphanedWorktrees();
      results.worktrees = worktrees;
      if (worktrees.pruned.length > 0) {
        logger.info(
          `[Housekeeping] Pruned ${worktrees.pruned.length} orphaned worktree(s): ${worktrees.pruned.join(", ")}`,
        );
      }
      if (worktrees.errors.length > 0) {
        logger.warn(
          `[Housekeeping] Worktree errors: ${worktrees.errors.join("; ")}`,
        );
      }
    } catch (error: unknown) {
      results.worktrees = { error: getErrorMessage(error) };
      logger.error(
        `[Housekeeping] Worktree pruning failed: ${getErrorMessage(error)}`,
      );
    }

    // 2. Clear stale conversations
    try {
      const conversationsCleanup = await clearStaleConversations();
      results.staleConversations = conversationsCleanup;
      const total =
        conversationsCleanup.conversationsCleared + conversationsCleanup.agentConversationsCleared;
      if (total > 0) {
        logger.info(
          `[Housekeeping] Cleared ${total} stale isGenerating flag(s)`,
        );
      }
    } catch (error: unknown) {
      results.staleConversations = { error: getErrorMessage(error) };
      logger.error(
        `[Housekeeping] Conversation cleanup failed: ${getErrorMessage(error)}`,
      );
    }

    // 3. Prune old request logs
    try {
      const deletedLogs = await pruneOldRequestLogs();
      results.requestLogs = { deleted: deletedLogs };
      if (deletedLogs > 0) {
        logger.info(
          `[Housekeeping] Pruned ${deletedLogs} request log(s) older than ${REQUEST_LOG_MAX_AGE_DAYS} days`,
        );
      }
    } catch (error: unknown) {
      results.requestLogs = { error: getErrorMessage(error) };
      logger.error(
        `[Housekeeping] Request log pruning failed: ${getErrorMessage(error)}`,
      );
    }

    // 4. MinIO orphan cleanup
    try {
      const minioOrphans = await pruneMinioOrphans();
      results.minioOrphans = { removed: minioOrphans };
      if (minioOrphans > 0) {
        logger.info(
          `[Housekeeping] Removed ${minioOrphans} orphaned MinIO object(s)`,
        );
      }
    } catch (error: unknown) {
      results.minioOrphans = { error: getErrorMessage(error) };
      logger.error(
        `[Housekeeping] MinIO orphan cleanup failed: ${getErrorMessage(error)}`,
      );
    }

    const durationMs = Math.round(performance.now() - startTime);
    results.durationMs = durationMs;
    results.trigger = trigger;

    logger.success(`[Housekeeping] Complete (${durationMs}ms)`);
    return results as HousekeepingResult;
  },
};

export default BackgroundHousekeepingService;
