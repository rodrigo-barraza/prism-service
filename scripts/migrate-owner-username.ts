/**
 * Migrate Owner Username
 *
 * One-off migration for the login guard (README "Authentication"): before
 * it, a request with no `x-username` was `anonymous`, and the owner's own
 * Prism data sits under that name. After it, the owner's login maps to a
 * real username (prism-client's PRISM_USERS), so this moves their records
 * from one username to the other — in every collection that stores one:
 * conversations, agent conversations, requests, settings, memories, rules,
 * hooks, permission rules, skills, profiles, scheduled tasks, timers, … The
 * collections are found, not listed: every collection whose documents carry
 * a top-level `username` equal to `--from` is moved.
 *
 * Scheduled tasks and conversation timers run turns of their own; the auth
 * of whoever saved them decides their owner powers (`authKind`). Moved to the
 * owner, they are the owner's: those with no `authKind` yet are stamped as a
 * signed-in user's (`"user"`). A recorded `"service"` is kept.
 *
 * Never deletes anything: it only `$set`s. A document that cannot move
 * because the target username already has one with the same unique key (a
 * profile, a versioned instruction) stays where it is and is counted as a
 * conflict.
 *
 * Default is a DRY RUN that prints, per collection, how many documents would
 * move. `--apply` writes. Applying to the production database (`prism`)
 * also needs `--yes-production`.
 *
 * Usage:
 *   node scripts/migrate-owner-username.ts --from anonymous --to rodrigo
 *   node scripts/migrate-owner-username.ts --from anonymous --to rodrigo --projects prism-chat,coding
 *   node scripts/migrate-owner-username.ts --from anonymous --to rodrigo --apply --yes-production
 *
 * Environment:
 *   MONGO_URI (or PRISM_SERVICE_MONGO_URI / PRISM_MONGO_URI) — MongoDB connection string
 *   MONGO_DB_NAME (or PRISM_SERVICE_MONGO_DB_NAME / PRISM_MONGO_DB_NAME) — database (default "prism")
 */

import { pathToFileURL } from "node:url";
import type { Db, Document, Filter } from "mongodb";

/** The databases production runs on: applying there needs --yes-production. */
export const PRODUCTION_DATABASE_NAMES: ReadonlySet<string> = new Set(["prism"]);

/** Records that run turns of their own; moved to the owner, they are stamped as a signed-in user's. */
export const INTERNAL_TURN_COLLECTIONS: ReadonlySet<string> = new Set([
  "scheduled_tasks",
  "conversation_timers",
]);

const DUPLICATE_KEY_ERROR_CODE = 11000;

export interface MigrationOptions {
  from: string;
  to: string;
  /** Only these projects; null = every project. */
  projects: string[] | null;
  apply: boolean;
}

export interface CollectionReport {
  collection: string;
  /** Documents under `from` (in the projects asked for). */
  matched: number;
  /** Moved to `to` (applied), or that would be (dry run: = matched). */
  moved: number;
  /** Left under `from`: `to` already holds a document with the same unique key. */
  conflicts: number;
  /** Internal-turn records stamped `authKind: "user"` (or that would be). */
  stamped: number;
}

export interface ParsedArguments extends MigrationOptions {
  yesProduction: boolean;
}

/** `--from X --to Y [--projects a,b] [--apply] [--yes-production]`; throws on anything else. */
export function parseArguments(argv: string[]): ParsedArguments {
  const parsed: ParsedArguments = { from: "", to: "", projects: null, apply: false, yesProduction: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith("--")) throw new Error(`${argument} needs a value`);
      return next.trim();
    };
    if (argument === "--from") parsed.from = value();
    else if (argument === "--to") parsed.to = value();
    else if (argument === "--projects") {
      const projects = value()
        .split(",")
        .map((project) => project.trim())
        .filter(Boolean);
      parsed.projects = projects.length > 0 ? projects : null;
    } else if (argument === "--apply") parsed.apply = true;
    else if (argument === "--yes-production") parsed.yesProduction = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!parsed.from || !parsed.to) throw new Error("Both --from and --to are required");
  if (parsed.from === parsed.to) throw new Error("--from and --to name the same username");
  return parsed;
}

/** Why applying to `databaseName` is refused, or null when it may go ahead. */
export function productionRefusal(databaseName: string, args: Pick<ParsedArguments, "apply" | "yesProduction">): string | null {
  if (!args.apply || !PRODUCTION_DATABASE_NAMES.has(databaseName) || args.yesProduction) return null;
  return `Refusing to apply to the production database "${databaseName}" without --yes-production.`;
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === DUPLICATE_KEY_ERROR_CODE;
}

/** Move one collection's documents; documents that collide stay and are counted. */
async function moveDocuments(db: Db, name: string, filter: Filter<Document>, to: string) {
  const collection = db.collection(name);
  try {
    const result = await collection.updateMany(filter, { $set: { username: to } });
    return { moved: result.modifiedCount, conflicts: 0 };
  } catch (error: unknown) {
    if (!isDuplicateKey(error)) throw error;
  }
  // A unique key collided: what updateMany moved before it stopped no longer
  // matches `filter`; the rest go one at a time.
  let moved = 0;
  let conflicts = 0;
  const remaining = await collection.find(filter, { projection: { _id: 1 } }).toArray();
  for (const { _id } of remaining) {
    try {
      const result = await collection.updateOne({ _id }, { $set: { username: to } });
      moved += result.modifiedCount;
    } catch (error: unknown) {
      if (!isDuplicateKey(error)) throw error;
      conflicts++;
    }
  }
  return { moved, conflicts };
}

/**
 * Move every document under `from` to `to`, in every collection that stores
 * a username (dry run: count only). Returns the collections that had any.
 */
export async function migrateOwnerUsername(db: Db, options: MigrationOptions): Promise<CollectionReport[]> {
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith("system."))
    .sort();
  const reports: CollectionReport[] = [];
  for (const name of collections) {
    const filter: Filter<Document> = {
      username: options.from,
      ...(options.projects ? { project: { $in: options.projects } } : {}),
    };
    const collection = db.collection(name);
    const matched = await collection.countDocuments(filter);
    if (matched === 0) continue;
    // `authKind: null` matches a missing field too: never a recorded "service".
    const unstamped = { ...filter, authKind: null };
    const stampable = INTERNAL_TURN_COLLECTIONS.has(name) ? await collection.countDocuments(unstamped) : 0;
    if (!options.apply) {
      reports.push({ collection: name, matched, moved: matched, conflicts: 0, stamped: stampable });
      continue;
    }
    const stamped =
      stampable > 0
        ? (await collection.updateMany(unstamped, { $set: { authKind: "user" } })).modifiedCount
        : 0;
    const { moved, conflicts } = await moveDocuments(db, name, filter, options.to);
    reports.push({ collection: name, matched, moved, conflicts, stamped });
  }
  return reports;
}

/** The report as a table. */
export function formatReport(reports: CollectionReport[], options: MigrationOptions & { database: string }): string {
  const verb = options.apply ? "moved" : "would move";
  const lines = [
    `${options.apply ? "APPLIED" : "DRY RUN"} — "${options.from}" → "${options.to}" in ${options.database}` +
      (options.projects ? ` (projects: ${options.projects.join(", ")})` : " (every project)"),
    "",
    `${"collection".padEnd(32)} ${"matched".padStart(8)} ${verb.padStart(10)} ${"conflicts".padStart(9)} ${"stamped".padStart(8)}`,
  ];
  for (const report of reports) {
    lines.push(
      `${report.collection.padEnd(32)} ${String(report.matched).padStart(8)} ${String(report.moved).padStart(10)} ` +
        `${String(report.conflicts).padStart(9)} ${String(report.stamped).padStart(8)}`,
    );
  }
  if (reports.length === 0) lines.push(`(no document has username "${options.from}")`);
  const total = reports.reduce((sum, report) => sum + report.moved, 0);
  lines.push("", `${verb}: ${total} document(s) in ${reports.length} collection(s)`);
  if (!options.apply) lines.push("Nothing was written. Add --apply to move them.");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const uri = process.env.PRISM_SERVICE_MONGO_URI || process.env.PRISM_MONGO_URI || process.env.MONGO_URI || "";
  const database =
    process.env.PRISM_SERVICE_MONGO_DB_NAME || process.env.PRISM_MONGO_DB_NAME || process.env.MONGO_DB_NAME || "prism";
  if (!uri) throw new Error("MONGO_URI is not set");
  const refusal = productionRefusal(database, args);
  if (refusal) throw new Error(refusal);

  const { connectDatabase, getDatabase, disconnectDatabase } = await import(
    "@rodrigo-barraza/utilities-library/service/mongo"
  );
  await connectDatabase(uri, { name: database, dbName: database });
  try {
    const reports = await migrateOwnerUsername(getDatabase(database), args);
    console.log(formatReport(reports, { ...args, database }));
  } finally {
    await disconnectDatabase(database);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`migrate-owner-username: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
