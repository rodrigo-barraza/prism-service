// ─── Memory Consolidation Tracker ────────────────────────────
// Run counting, daily cost guard, and history recording for
// the memory consolidation pipeline.
// Extracted from MemoryConsolidationService.ts

import crypto from "crypto";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import logger from "#src/utils/logger";
import { COLLECTIONS, MEMORY } from "#src/constants";
import type { ConsolidationAction } from "./types.ts";

/** Min sessions between consolidation runs */
export const SESSIONS_BETWEEN_RUNS = MEMORY.SESSIONS_BETWEEN_RUNS;

/** Max consolidation runs per project per day (cost guard) */
export const DAILY_MAX_CONSOLIDATIONS = MEMORY.DAILY_MAX_CONSOLIDATIONS;

const RUNS_COLLECTION = COLLECTIONS.MEMORY_CONSOLIDATION_RUNS;
const HISTORY_COLLECTION = COLLECTIONS.MEMORY_CONSOLIDATION_HISTORY;

// ─── Run Counting ───────────────────────────────────────────

export async function getRunCount(project: string): Promise<number> {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return 0;
  const document = await db.collection(RUNS_COLLECTION).findOne({ project });
  return (document?.sessionsSinceLastRun as number) || 0;
}

export async function incrementRunCount(project: string): Promise<void> {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return;
  await db
    .collection(RUNS_COLLECTION)
    .updateOne(
      { project },
      { $inc: { sessionsSinceLastRun: 1 } },
      { upsert: true },
    );
}

export async function resetRunCount(project: string): Promise<void> {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return;
  await db.collection(RUNS_COLLECTION).updateOne(
    { project },
    {
      $set: {
        sessionsSinceLastRun: 0,
        lastConsolidatedAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}

// ─── Single-Writer Lock ─────────────────────────────────────
// The threshold trigger (checkAndRun) and the 24h AutoDream sweep can
// both consolidate the same scope concurrently; both mutate memories,
// so a race can double-close or double-merge. An advisory Mongo lock on
// the runs document (atomic findOneAndUpdate) makes consolidation
// single-writer per scope; a stale lock (crashed holder) is taken over
// after CONSOLIDATION_LOCK_STALE_MINUTES.

const LOCK_STALE_MILLISECONDS =
  MEMORY.CONSOLIDATION_LOCK_STALE_MINUTES * 60 * 1000;

export async function acquireConsolidationLock(
  project: string,
): Promise<boolean> {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return true; // no DB — nothing to race against
  const collection = db.collection(RUNS_COLLECTION);
  // Ensure the scope document exists (idempotent)
  await collection.updateOne(
    { project },
    { $setOnInsert: { project } },
    { upsert: true },
  );
  const staleBefore = new Date(
    Date.now() - LOCK_STALE_MILLISECONDS,
  ).toISOString();
  const result = await collection.findOneAndUpdate(
    {
      project,
      $or: [
        { isConsolidating: { $ne: true } },
        { lockAcquiredAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        isConsolidating: true,
        lockAcquiredAt: new Date().toISOString(),
      },
    },
  );
  const acquired = result !== null;
  if (!acquired) {
    logger.info(
      `[MemoryConsolidation] Lock held for "${project}" — skipping concurrent run`,
    );
  }
  return acquired;
}

export async function releaseConsolidationLock(
  project: string,
): Promise<void> {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return;
  await db
    .collection(RUNS_COLLECTION)
    .updateOne({ project }, { $set: { isConsolidating: false } });
}

// ─── History Recording ──────────────────────────────────────

export async function recordHistory(
  project: string,
  trigger: string,
  memoriesBefore: number,
  actions: ConsolidationAction[],
  summary: string,
  durationMilliseconds: number,
  applied?: { closedIds?: string[]; createdIds?: string[] },
): Promise<string | null> {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return null;
  const mergeCount = actions
    .filter((action) => action.type === "merge")
    .reduce((sum, action) => sum + (action.sourceIds?.length || 0), 0);
  const deleteCount = actions.filter(
    (action) => action.type === "delete" || action.type === "invalidate",
  ).length;
  const runId = crypto.randomUUID();
  await db.collection(HISTORY_COLLECTION).insertOne({
    runId,
    project,
    runAt: new Date().toISOString(),
    trigger,
    memoriesBefore,
    memoriesAfter:
      memoriesBefore -
      mergeCount -
      deleteCount +
      actions.filter((action) => action.type === "merge").length,
    actionsApplied: actions.length,
    actions: actions.map((action) => ({
      type: action.type,
      ...(action.sourceIds && { sourceIds: action.sourceIds }),
      ...(action.merged && { mergedTitle: action.merged.title }),
      ...(action.id && { deletedId: action.id }),
      reason: action.reason || "",
    })),
    // Soft-close bookkeeping — powers rollbackRun()
    closedIds: applied?.closedIds || [],
    createdIds: applied?.createdIds || [],
    summary,
    durationMilliseconds,
  });
  return runId;
}

export async function getHistoryRun(runId: string) {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return null;
  return db.collection(HISTORY_COLLECTION).findOne({ runId });
}

export async function markRunRolledBack(runId: string): Promise<void> {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return;
  await db
    .collection(HISTORY_COLLECTION)
    .updateOne(
      { runId },
      { $set: { rolledBackAt: new Date().toISOString() } },
    );
}

// ─── Cost Guard ─────────────────────────────────────────────

/**
 * Check if the daily consolidation budget is exhausted.
 * Returns true if more runs are allowed.
 */
export async function canRunToday(project: string): Promise<boolean> {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return true;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayCount = await db.collection(HISTORY_COLLECTION).countDocuments({
    project,
    runAt: { $gte: startOfDay.toISOString() },
  });
  if (todayCount >= DAILY_MAX_CONSOLIDATIONS) {
    logger.warn(
      `[MemoryConsolidation] Daily limit reached for "${project}" (${todayCount}/${DAILY_MAX_CONSOLIDATIONS})`,
    );
    return false;
  }
  return true;
}

// ─── History Query ──────────────────────────────────────────

export async function getHistory(project: string, limit: number = 10) {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return [];
  return db
    .collection(HISTORY_COLLECTION)
    .find({ project })
    .sort({ runAt: -1 })
    .limit(limit)
    .project({ _id: 0 })
    .toArray();
}
