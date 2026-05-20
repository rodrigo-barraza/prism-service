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
// @ts-ignore
import { MS_PER_DAY, hours } from "@rodrigo-barraza/utilities-library";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import MinioWrapper from "../wrappers/MinioWrapper.ts";
// @ts-ignore
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import logger from "../utils/logger.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Worktrees older than this are considered orphaned */
const WORKTREE_MAX_AGE_MS = MS_PER_DAY;

/** Temp worktree root directory used by CoordinatorService */
const WORKTREE_ROOT = "/tmp/prism-worktrees";

/** Request logs older than this are pruned (keep 90 days) */
const REQUEST_LOG_MAX_AGE_DAYS = 90;

/** Stale isGenerating flags left from crashes */
const STALE_SESSION_CUTOFF_MS = hours(2);

// ─── Worktree Pruning ─────────────────────────────────────────────────────────

/**
 * Remove orphaned worktrees in /tmp/prism-worktrees/ older than 24h.
 * These accumulate when workers crash or the process is killed without
 * running CleanupRegistry teardown.
 *
 * @returns {Promise<{ pruned: string[], errors: string[] }>}
 */
async function pruneOrphanedWorktrees() {
  // @ts-ignore
  const pruned: Record<string, unknown>[] = [];
  // @ts-ignore
  const errors: Record<string, unknown>[] = [];

  let entries: Record<string, unknown>;
  try {
    // @ts-ignore - TODO: strict typing
    entries = await readdir(WORKTREE_ROOT).catch(() => []);
  } catch {
    // @ts-ignore
    return { pruned, errors };
  }

  // @ts-ignore
  if (entries.length === 0) return { pruned, errors };

  const cutoff = Date.now() - WORKTREE_MAX_AGE_MS;

  // @ts-ignore
  for ( const entry of entries) {
    const entryPath = resolve(WORKTREE_ROOT, entry);
    try {
      const info = await stat(entryPath);
      if (!info.isDirectory()) continue;

      if (info.mtimeMs < cutoff) {
        await rm(entryPath, { recursive: true, force: true });
        pruned.push(entry);
      }
    } catch (error: unknown) {
      // @ts-ignore - TODO: strict typing
      errors.push(`${entry}: ${error.message}`);
    }
  }

  return { pruned, errors };
}

// ─── Stale Session Cleanup ────────────────────────────────────────────────────

/**
 * Clear isGenerating flags that were left dangling by a crash.
 * Also removes sessions that have been in "generating" state for >2h.
 *
 * @returns {Promise<{ conversationsCleared: number, agentSessionsCleared: number }>}
 */
async function clearStaleSessions() {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return { conversationsCleared: 0, agentSessionsCleared: 0 };

  const cutoff = new Date(Date.now() - STALE_SESSION_CUTOFF_MS).toISOString();

  const [convResult, sessionResult] = await Promise.all([
    db
      .collection(COLLECTIONS.CONVERSATIONS)
      .updateMany(
        { isGenerating: true, updatedAt: { $lt: cutoff } },
        { $set: { isGenerating: false } },
      ),
    db
      .collection(COLLECTIONS.AGENT_SESSIONS)
      .updateMany(
        { isGenerating: true, updatedAt: { $lt: cutoff } },
        { $set: { isGenerating: false } },
      ),
  ]);

  return {
    conversationsCleared: convResult.modifiedCount,
    agentSessionsCleared: sessionResult.modifiedCount,
  };
}

// ─── Old Request Log Pruning ──────────────────────────────────────────────────

/**
 * Remove request logs older than REQUEST_LOG_MAX_AGE_DAYS.
 * Keeps the DB from growing unbounded over time.
 *
 * @returns {Promise<number>} Number of documents deleted
 */
async function pruneOldRequestLogs() {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return 0;

  const cutoff = new Date(
    Date.now() - REQUEST_LOG_MAX_AGE_DAYS * MS_PER_DAY,
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
const STRUCTURAL_PREFIXES = new Set(["projects", "uploads", "generations"]);

/**
 * Find MinIO objects that no longer have matching MongoDB references.
 * This handles cases where a conversation is deleted but the MinIO
 * objects (screenshots, file artifacts) remain.
 *
 * Conservative approach: only orphan-checks objects whose top-level prefix
 * looks like a conversation ID (not a known structural prefix like "projects/").
 *
 * @returns {Promise<number>} Number of orphaned objects removed
 */
async function pruneMinioOrphans() {
  if (!MinioWrapper.isAvailable()) return 0;

  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return 0;

  let removed = 0;

  try {
    // Stream IDs instead of distinct() to avoid materializing the entire array
    const validIds = new Set();
    const convCursor = db
      .collection(COLLECTIONS.CONVERSATIONS)
      .find({}, { projection: { id: 1, _id: 0 } });
    const sessionCursor = db
      .collection(COLLECTIONS.AGENT_SESSIONS)
      .find({}, { projection: { id: 1, _id: 0 } });
    // @ts-ignore
    for await ( const document of convCursor) validIds.add(document.id);
    // @ts-ignore
    for await ( const document of sessionCursor) validIds.add(document.id);

    // List MinIO objects with the conversation-scoped prefix pattern
    // Convention: conversation objects are stored as {conversationId}/{filename}
    // FileService objects use: projects/{project}/{user}/{category}/{uuid}.{ext}
    const objects = await MinioWrapper.listObjects("").catch(() => []);
    if (!Array.isArray(objects) || objects.length === 0) return 0;

    // Group objects by their top-level prefix — only check prefixes that are
    // NOT known structural paths (projects/, uploads/, generations/, etc.)
    const prefixes = new Set<string>();
    for (const object of objects) {
      const name = typeof object === "string" ? object : (object as { name?: string })?.name;
      const prefix = name ? name.split("/")[0] : "";
      if (prefix && !validIds.has(prefix) && !STRUCTURAL_PREFIXES.has(prefix)) {
        prefixes.add(prefix);
      }
    }

    // Remove orphaned prefixes
    for (const prefix of prefixes) {
      // @ts-ignore - TODO: strict typing
      const orphanedObjects = objects.filter((o: Record<string, unknown>) => {
        const name = typeof o === "string" ? o : (o as { name?: string })?.name;
        return name ? name.startsWith(`${prefix}/`) : false;
      });
      for (const object of orphanedObjects) {
        try {
          const name = typeof object === "string" ? object : (object as { name?: string })?.name;
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
    // @ts-ignore - TODO: strict typing
    logger.warn(`[Housekeeping] MinIO orphan scan failed: ${error.message}`);
  }

  return removed;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const BackgroundHousekeepingService = {
  /**
   * Run all housekeeping tasks.
   * Safe to call at any time — each task is independent and failure-tolerant.
   *


   * @returns {Promise<object>} Summary of actions taken
   */
  async run({ trigger = "boot" }: Record<string, unknown> = {}) {
    const startTime = performance.now();
    logger.info(`[Housekeeping] Starting (trigger: ${trigger})…`);

    const results = {};

    // 1. Prune orphaned worktrees
    try {
      const worktrees = await pruneOrphanedWorktrees();
      // @ts-ignore
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
      // @ts-ignore
      results.worktrees = { error: error.message };
      // @ts-ignore - TODO: strict typing
      logger.error(`[Housekeeping] Worktree pruning failed: ${error.message}`);
    }

    // 2. Clear stale sessions
    try {
      const sessions = await clearStaleSessions();
      // @ts-ignore
      results.staleSessions = sessions;
      const total =
        sessions.conversationsCleared + sessions.agentSessionsCleared;
      if (total > 0) {
        logger.info(
          `[Housekeeping] Cleared ${total} stale isGenerating flag(s)`,
        );
      }
    } catch (error: unknown) {
      // @ts-ignore
      results.staleSessions = { error: error.message };
      // @ts-ignore - TODO: strict typing
      logger.error(`[Housekeeping] Session cleanup failed: ${error.message}`);
    }

    // 3. Prune old request logs
    try {
      const deletedLogs = await pruneOldRequestLogs();
      // @ts-ignore
      results.requestLogs = { deleted: deletedLogs };
      if (deletedLogs > 0) {
        logger.info(
          `[Housekeeping] Pruned ${deletedLogs} request log(s) older than ${REQUEST_LOG_MAX_AGE_DAYS} days`,
        );
      }
    } catch (error: unknown) {
      // @ts-ignore
      results.requestLogs = { error: error.message };
      logger.error(
        // @ts-ignore - TODO: strict typing
        `[Housekeeping] Request log pruning failed: ${error.message}`,
      );
    }

    // 4. MinIO orphan cleanup
    try {
      const minioOrphans = await pruneMinioOrphans();
      // @ts-ignore
      results.minioOrphans = { removed: minioOrphans };
      if (minioOrphans > 0) {
        logger.info(
          `[Housekeeping] Removed ${minioOrphans} orphaned MinIO object(s)`,
        );
      }
    } catch (error: unknown) {
      // @ts-ignore
      results.minioOrphans = { error: error.message };
      logger.error(
        // @ts-ignore - TODO: strict typing
        `[Housekeeping] MinIO orphan cleanup failed: ${error.message}`,
      );
    }

    const durationMs = Math.round(performance.now() - startTime);
    // @ts-ignore
    results.durationMs = durationMs;
    // @ts-ignore
    results.trigger = trigger;

    logger.success(`[Housekeeping] Complete (${durationMs}ms)`);
    return results;
  },
};

export default BackgroundHousekeepingService;
