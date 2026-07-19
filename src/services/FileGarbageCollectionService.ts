// ────────────────────────────────────────────────────────────
// FileGarbageCollectionService — orphaned upload cleanup
// ────────────────────────────────────────────────────────────
// Uploads land in MinIO under the FileService layout
// (projects/{project}/{username}/uploads/… or flat uploads/…) and are
// referenced from Mongo documents as minio:// refs, direct bucket URLs,
// or /files/<key> proxy URLs. Attachments that were uploaded but never
// referenced by any document (abandoned drafts, failed sends) accumulate
// forever — this service finds and (optionally) deletes them.
//
// Deliberately conservative:
//  - dryRun defaults to TRUE — callers must opt in to deletion
//  - objects newer than 30 days are NEVER touched
//  - only the uploads category is considered (generations, screenshots,
//    and project workspaces are out of scope)
//  - every decision is logged

import logger from "#src/utils/logger";
import MinioWrapper from "#src/wrappers/MinioWrapper";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import FileService from "#src/services/FileService";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

/** Hard floor — objects newer than this are never eligible, ever. */
const MINIMUM_AGE_DAYS = 30;

/**
 * Collections that persist media references. Conversations are the primary
 * holders; workflows, synthesis runs, favorites, and artifacts can embed
 * refs too, so they participate in the reference scan (conservative:
 * a ref ANYWHERE keeps the object).
 */
const REFERENCE_SCAN_COLLECTIONS = [
  COLLECTIONS.MODEL_CONVERSATIONS,
  COLLECTIONS.AGENT_CONVERSATIONS,
  COLLECTIONS.WORKFLOWS,
  COLLECTIONS.SYNTHESIS,
  COLLECTIONS.FAVORITES,
  COLLECTIONS.AGENT_ARTIFACTS,
];

export interface OrphanEntry {
  key: string;
  size: number;
  lastModified: string;
}

export interface GarbageCollectionReport {
  dryRun: boolean;
  olderThanDays: number;
  scannedObjects: number;
  uploadObjects: number;
  referencedKeys: number;
  scannedDocuments: number;
  skippedRecent: number;
  orphans: OrphanEntry[];
  deletedCount: number;
  errors: string[];
}

interface MinioObjectInfo {
  name: string;
  size: number;
  lastModified: Date;
}

/** Normalize a candidate key the same way reads do (legacy ::ffff: scrub). */
function normalizeKey(key: string): string {
  return FileService.extractKey(`minio://${key}`);
}

/**
 * Extract every MinIO object key referenced in a serialized document.
 * Recognized forms:
 *   minio://<key>
 *   <bucketUrl>/<key>          (direct public bucket URLs)
 *   …/files/<key>              (backend proxy URLs; keys under projects/ or uploads/)
 */
export function extractReferencedKeys(
  serializedDocument: string,
  bucketUrl: string | null,
): string[] {
  const keys: string[] = [];
  const stopChars = /[\s"'\\)\]}>]/;

  const collectAfter = (marker: string) => {
    let searchIndex = 0;
    while (true) {
      const markerIndex = serializedDocument.indexOf(marker, searchIndex);
      if (markerIndex === -1) break;
      let end = markerIndex + marker.length;
      while (
        end < serializedDocument.length &&
        !stopChars.test(serializedDocument[end])
      ) {
        end++;
      }
      const key = serializedDocument.slice(markerIndex + marker.length, end);
      if (key) keys.push(key);
      searchIndex = end;
    }
  };

  collectAfter("minio://");
  if (bucketUrl) collectAfter(`${bucketUrl}/`);
  // Proxy URLs: capture only keys in known storage prefixes to avoid
  // treating arbitrary "/files/…" strings as object keys.
  for (const prefix of ["/files/projects/", "/files/uploads/"]) {
    let searchIndex = 0;
    while (true) {
      const markerIndex = serializedDocument.indexOf(prefix, searchIndex);
      if (markerIndex === -1) break;
      const keyStart = markerIndex + "/files/".length;
      let end = keyStart;
      while (
        end < serializedDocument.length &&
        !stopChars.test(serializedDocument[end])
      ) {
        end++;
      }
      const key = serializedDocument.slice(keyStart, end);
      if (key) keys.push(key);
      searchIndex = end;
    }
  }
  return keys;
}

/** Whether an object key belongs to the uploads category. */
export function isUploadKey(key: string): boolean {
  return key.startsWith("uploads/") || key.includes("/uploads/");
}

export default class FileGarbageCollectionService {
  /** Scan all reference-holding collections for MinIO object keys. */
  static async collectReferencedKeys(): Promise<{
    keys: Set<string>;
    scannedDocuments: number;
  }> {
    const keys = new Set<string>();
    let scannedDocuments = 0;
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    const bucketUrl = MinioWrapper.getBucketUrl();

    for (const collectionName of REFERENCE_SCAN_COLLECTIONS) {
      try {
        const cursor = database.collection(collectionName).find({});
        for await (const document of cursor) {
          scannedDocuments++;
          const serialized = JSON.stringify(document);
          if (!serialized.includes("minio://") && !serialized.includes("/files/") && !(bucketUrl && serialized.includes(bucketUrl))) {
            continue;
          }
          for (const key of extractReferencedKeys(serialized, bucketUrl)) {
            keys.add(normalizeKey(key));
          }
        }
      } catch (error: unknown) {
        // A failed collection scan must abort the run — deleting based on
        // an incomplete reference set is exactly the mistake to avoid.
        throw new Error(
          `Reference scan failed for collection "${collectionName}": ${getErrorMessage(error)}`,
          { cause: error },
        );
      }
    }
    return { keys, scannedDocuments };
  }

  /**
   * Run the orphan scan. `dryRun` (default TRUE) reports without deleting.
   * Only upload-category objects older than `olderThanDays` (floored at
   * 30 days) that are referenced by no scanned document are eligible.
   */
  static async run({
    dryRun = true,
    olderThanDays = MINIMUM_AGE_DAYS,
  }: {
    dryRun?: boolean;
    olderThanDays?: number;
  } = {}): Promise<GarbageCollectionReport> {
    if (!MinioWrapper.isAvailable()) {
      throw new Error("MinIO is not available — nothing to garbage-collect");
    }
    const effectiveAgeDays = Math.max(MINIMUM_AGE_DAYS, olderThanDays);
    const cutoffTime = Date.now() - effectiveAgeDays * 24 * 60 * 60 * 1000;

    const { keys: referencedKeys, scannedDocuments } =
      await FileGarbageCollectionService.collectReferencedKeys();

    const objects: MinioObjectInfo[] = [];
    for (const prefix of ["projects/", "uploads/"]) {
      objects.push(
        ...((await MinioWrapper.listObjects(prefix)) as MinioObjectInfo[]),
      );
    }

    const report: GarbageCollectionReport = {
      dryRun,
      olderThanDays: effectiveAgeDays,
      scannedObjects: objects.length,
      uploadObjects: 0,
      referencedKeys: referencedKeys.size,
      scannedDocuments,
      skippedRecent: 0,
      orphans: [],
      deletedCount: 0,
      errors: [],
    };

    for (const object of objects) {
      if (!isUploadKey(object.name)) continue;
      report.uploadObjects++;

      const lastModified = new Date(object.lastModified);
      if (!(lastModified.getTime() < cutoffTime)) {
        // Never touch recent objects (also skips unparseable dates)
        report.skippedRecent++;
        continue;
      }
      if (referencedKeys.has(normalizeKey(object.name))) continue;

      const orphan: OrphanEntry = {
        key: object.name,
        size: object.size,
        lastModified: lastModified.toISOString(),
      };
      report.orphans.push(orphan);
      logger.info(
        `[FilesGC] Orphan${dryRun ? " (dry-run)" : ""}: ${object.name} (${(object.size / 1024).toFixed(0)} KB, ${orphan.lastModified})`,
      );
      if (!dryRun) {
        try {
          await MinioWrapper.remove(object.name);
          report.deletedCount++;
          logger.info(`[FilesGC] Deleted ${object.name}`);
        } catch (error: unknown) {
          const message = `Delete failed for ${object.name}: ${getErrorMessage(error)}`;
          report.errors.push(message);
          logger.error(`[FilesGC] ${message}`);
        }
      }
    }

    logger.info(
      `[FilesGC] ${dryRun ? "Dry-run" : "Run"} complete: ${report.orphans.length} orphan(s) of ${report.uploadObjects} upload object(s) ` +
        `(${report.referencedKeys} referenced keys across ${report.scannedDocuments} documents, ` +
        `${report.skippedRecent} skipped as newer than ${effectiveAgeDays}d, ${report.deletedCount} deleted)`,
    );
    return report;
  }
}
