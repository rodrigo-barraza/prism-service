import crypto from "crypto";
import type { Collection, Db, Filter, ObjectId } from "mongodb";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { DEFAULT_PROFILE_ID, profileFilter } from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";

// ────────────────────────────────────────────────────────────
// ProjectInstructionsService — PRISM.md, stored in Mongo
// ────────────────────────────────────────────────────────────
// One always-injected markdown document per scope, playing the
// role Claude Code's CLAUDE.md plays on disk: durable project
// policy that the system prompt carries into every conversation,
// editable from BOTH sides — the UI (ProjectInstructionsRoutes)
// and the agent itself (ProjectInstructionsTools).
//
// Scope resolution is most-specific-wins: a document scoped to a
// named agent shadows the project-wide (agent: null) one, exactly
// the way a nested CLAUDE.md shadows the repo root's.
//
// Versioning reuses MemoryService's bi-temporal soft-close model
// (validTo / supersededBy / closedReason). A write NEVER destroys
// the previous text — it inserts the new version and closes the
// old row's valid-time window, so history and rollback are free
// and no concurrent writer can silently lose someone's edit.
//
// Write ordering (the concurrency contract):
//   1. read the highest version ever written for the exact scope
//   2. INSERT the new row at version + 1 (the commit point — a
//      unique index on {project, username, agent, version} makes
//      the allocation a race the loser detects and retries)
//   3. sweep: close every OTHER still-current row below the new
//      version, pointing supersededBy at the new row
// Insert-first means a crash between steps leaves two current
// rows, never zero — and getCurrent() breaks that tie by version,
// so a reader always sees the newest text, never a stale one.
// ────────────────────────────────────────────────────────────

/** Who authored a version — drives the "edited by you / by the agent" UI. */
export type InstructionsAuthor = "user" | "agent";

export interface ProjectInstructionsScope {
  project?: string | null;
  username?: string | null;
  /** null = applies to every agent in the project/username scope. */
  agent?: string | null;
  /** Owning profile. Omitted = the current request's profile (or default). */
  profileId?: string | null;
}

export interface ResolvedInstructionsScope {
  project: string;
  username: string;
  agent: string | null;
  profileId: string;
}

export interface ProjectInstructionsDocument {
  _id?: ObjectId;
  /** Stable uuid for this VERSION row (supersededBy points at one of these). */
  id: string;
  project: string;
  username: string;
  agent: string | null;
  /** Owning profile. Absent on rows that predate profiles (= default). */
  profileId?: string;
  content: string;
  version: number;
  /** null = current. An ISO timestamp closes the valid-time window. */
  validTo: string | null;
  supersededBy: string | null;
  closedReason: string | null;
  updatedBy: InstructionsAuthor;
  createdAt: string;
  updatedAt: string;
}

export interface SetContentOptions {
  /** closedReason stamped on the rows this write supersedes. */
  reason?: string;
}

/**
 * Content guardrail. The document is injected into EVERY system prompt in
 * the scope, so an unbounded document is an unbounded per-request token
 * bill — this is the ceiling that keeps a runaway agent from blowing up
 * the prompt for every future conversation.
 */
export const PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS = 100_000;

/**
 * Filter clause selecting only CURRENT (not superseded) rows.
 * `{ validTo: null }` matches documents where the field is null OR missing,
 * so rows predating the temporal model stay visible.
 */
export const CURRENT_INSTRUCTIONS_FILTER = { validTo: null } as const;

/** Scope placeholder matching the REST layer's `req.project || "any"`. */
export const DEFAULT_SCOPE_VALUE = "any";

/** Retries for the version-allocation race (unique index rejects a tie). */
const MAX_WRITE_ATTEMPTS = 5;

const MAX_VERSION_HISTORY_LIMIT = 100;
const DEFAULT_VERSION_HISTORY_LIMIT = 20;

const COLLECTION = COLLECTIONS.AGENT_INSTRUCTIONS;

// ─── Markdown section upsert (pure) ───────────────────────────

export interface HeadingSpec {
  level: number;
  text: string;
}

interface ScannedHeading {
  index: number;
  level: number;
  text: string;
}

const DEFAULT_HEADING_LEVEL = 2;
const MAX_HEADING_LEVEL = 6;

/**
 * Split a caller-supplied heading into { level, text }.
 * "Build" → level 2 (the default), "### Gotchas" → level 3.
 * Trailing closing sequences ("## Foo ##") are stripped.
 */
export function parseHeadingSpec(heading: string): HeadingSpec {
  const raw = (heading || "").trim();
  const prefixMatch = /^(#{1,6})\s*/.exec(raw);
  const level = prefixMatch?.[1]
    ? prefixMatch[1].length
    : DEFAULT_HEADING_LEVEL;
  const text = raw
    .slice(prefixMatch?.[0]?.length ?? 0)
    .replace(/\s+#+\s*$/, "")
    .trim();
  return { level: Math.min(level, MAX_HEADING_LEVEL), text };
}

function normalizeHeadingText(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Locate every ATX heading in a markdown document, skipping fenced code
 * blocks. A "## Usage" line inside a ``` fence is CODE, not a heading —
 * treating it as one is how a section-level editor eats half a document.
 */
function scanHeadings(lines: string[]): ScannedHeading[] {
  const headings: ScannedHeading[] = [];
  let openFence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      const fenceCharacter = marker[0] ?? "";
      const trailer = fenceMatch[2] ?? "";

      if (!openFence) {
        // A backtick fence's info string may not contain backticks.
        if (fenceCharacter === "`" && trailer.includes("`")) continue;
        openFence = { marker: fenceCharacter, length: marker.length };
      } else if (
        openFence.marker === fenceCharacter &&
        marker.length >= openFence.length &&
        trailer.trim() === ""
      ) {
        openFence = null;
      }
      continue;
    }

    if (openFence) continue;

    // ATX heading: up to 3 leading spaces, 1–6 hashes, then whitespace or EOL.
    const headingMatch = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (!headingMatch?.[1]) continue;

    const text = (headingMatch[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
    headings.push({ index, level: headingMatch[1].length, text });
  }

  return headings;
}

function buildSectionLines(headingLine: string, body: string): string[] {
  const normalizedBody = (body || "")
    .replace(/\r\n/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  if (!normalizedBody) return [headingLine];
  return [headingLine, "", ...normalizedBody.split("\n")];
}

/**
 * Add or REPLACE a `## heading` section in a markdown document, preserving
 * everything else byte-for-byte.
 *
 *  - heading absent  → the section is appended at the end
 *  - heading present → only that section is replaced, up to the next
 *                      heading of the SAME OR HIGHER level (a `###`
 *                      subheading belongs to its `##` parent and goes with
 *                      it; the following `##` sibling is never swallowed)
 *  - empty document  → the section becomes the whole document
 *  - fenced code     → `##` inside ``` / ~~~ is code, never a heading
 *
 * Idempotent: upserting the same heading/body twice yields the same string.
 * The result carries no trailing newline, so repeated round-trips are stable.
 */
export function upsertMarkdownSection(
  content: string,
  heading: string,
  body: string,
): string {
  const { level, text } = parseHeadingSpec(heading);
  if (!text) {
    throw new Error("upsertMarkdownSection requires a non-empty heading");
  }

  const headingLine = `${"#".repeat(level)} ${text}`;
  const sectionLines = buildSectionLines(headingLine, body);
  const section = sectionLines.join("\n");

  const source = (content || "").replace(/\r\n/g, "\n");
  if (!source.trim()) return section;

  const lines = source.split("\n");
  const headings = scanHeadings(lines);
  const targetOrdinal = headings.findIndex(
    (candidate) =>
      candidate.level === level &&
      normalizeHeadingText(candidate.text) === normalizeHeadingText(text),
  );

  if (targetOrdinal === -1) {
    return `${source.replace(/\s+$/, "")}\n\n${section}`;
  }

  const start = headings[targetOrdinal]?.index ?? 0;
  const nextBoundary = headings
    .slice(targetOrdinal + 1)
    .find((candidate) => candidate.level <= level);
  const end = nextBoundary ? nextBoundary.index : lines.length;

  const before = lines.slice(0, start);
  const after = lines.slice(end);
  while (before.length > 0 && (before[before.length - 1] ?? "").trim() === "") {
    before.pop();
  }
  while (after.length > 0 && (after[0] ?? "").trim() === "") {
    after.shift();
  }

  const parts: string[] = [];
  if (before.length > 0) parts.push(before.join("\n"), "");
  parts.push(section);
  if (after.length > 0) parts.push("", after.join("\n"));

  return parts.join("\n").replace(/\s+$/, "");
}

/**
 * Does the document already carry this exact heading (same level, same text,
 * outside code fences)? Used to report "added" vs "replaced" back to the
 * model after a section edit.
 */
export function hasMarkdownSection(content: string, heading: string): boolean {
  const { level, text } = parseHeadingSpec(heading);
  if (!text || !content) return false;
  return scanHeadings((content || "").replace(/\r\n/g, "\n").split("\n")).some(
    (candidate) =>
      candidate.level === level &&
      normalizeHeadingText(candidate.text) === normalizeHeadingText(text),
  );
}

// ─── Storage ──────────────────────────────────────────────────

function collectionFor(db: Db): Collection<ProjectInstructionsDocument> {
  return db.collection<ProjectInstructionsDocument>(COLLECTION);
}

export function normalizeScope(
  scope: ProjectInstructionsScope | undefined | null,
): ResolvedInstructionsScope {
  return {
    project: scope?.project || DEFAULT_SCOPE_VALUE,
    username: scope?.username || DEFAULT_SCOPE_VALUE,
    agent: scope?.agent || null,
    // Internal tools call without a profileId — fall back to the request's
    // profile (AsyncLocalStorage), then the default profile.
    profileId:
      scope?.profileId || getRequestContext().profileId || DEFAULT_PROFILE_ID,
  };
}

function exactScopeFilter(
  scope: ResolvedInstructionsScope,
): Filter<ProjectInstructionsDocument> {
  // Profile is an exact-match dimension like username — never a fallback
  // layer. The cast is needed because the default profile's filter value is
  // { $in: ["default", null] } (legacy rows lack the field) while the
  // document type declares the stamped literal string.
  return {
    project: scope.project,
    username: scope.username,
    agent: scope.agent,
    profileId: profileFilter(scope.profileId),
  } as Filter<ProjectInstructionsDocument>;
}

function assertWithinContentCap(content: string) {
  if (content.length > PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS) {
    throw new Error(
      `Project instructions exceed the ${PROJECT_INSTRUCTIONS_MAX_CONTENT_CHARS.toLocaleString()}-character limit ` +
        `(got ${content.length.toLocaleString()}) — this document is injected into every system prompt in the scope`,
    );
  }
}

function isDuplicateKeyError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === 11000
  );
}

const indexedDatabases = new WeakSet<Db>();

/**
 * Best-effort index creation, run lazily on first use of a Db handle.
 * The unique {scope, version} index is what makes concurrent setContent()
 * calls serialize instead of both claiming the same version number.
 */
export async function ensureIndexes(db: Db) {
  if (!db || indexedDatabases.has(db)) return;
  indexedDatabases.add(db);
  try {
    const collection = collectionFor(db);
    // The pre-profile unique index would make version allocation collide
    // ACROSS profiles (two profiles claiming v(n+1) of the same
    // project/username/agent scope) — drop it if it still exists.
    await collection
      .dropIndex("project_1_username_1_agent_1_version_1")
      .catch(() => {});
    await collection.createIndex({
      project: 1,
      username: 1,
      agent: 1,
      profileId: 1,
      validTo: 1,
      version: -1,
    });
    await collection.createIndex(
      { project: 1, username: 1, agent: 1, profileId: 1, version: 1 },
      { unique: true },
    );
  } catch (error: unknown) {
    logger.warn(
      `[ProjectInstructionsService] Index creation skipped: ${getErrorMessage(error)}`,
    );
  }
}

async function findRows(
  db: Db,
  filter: Filter<ProjectInstructionsDocument>,
  limit?: number,
): Promise<ProjectInstructionsDocument[]> {
  const cursor = collectionFor(db).find(filter).sort({ version: -1 });
  const limited = typeof limit === "number" ? cursor.limit(limit) : cursor;
  return (await limited.toArray()) as ProjectInstructionsDocument[];
}

async function highestVersion(
  db: Db,
  scope: ResolvedInstructionsScope,
): Promise<number> {
  const rows = await findRows(db, exactScopeFilter(scope), 1);
  return rows[0]?.version ?? 0;
}

/**
 * The current document for the EXACT scope given — no most-specific-wins
 * fallback. This is what the UI edits and what a write targets.
 */
async function getExactCurrent(
  db: Db,
  scope: ProjectInstructionsScope,
): Promise<ProjectInstructionsDocument | null> {
  const resolved = normalizeScope(scope);
  await ensureIndexes(db);
  const rows = await findRows(db, {
    ...exactScopeFilter(resolved),
    ...CURRENT_INSTRUCTIONS_FILTER,
  });
  return rows[0] ?? null;
}

/**
 * The EFFECTIVE document for a scope — most-specific-wins. An agent-scoped
 * current document beats the project-wide (agent: null) one.
 */
async function getCurrent(
  db: Db,
  scope: ProjectInstructionsScope,
): Promise<ProjectInstructionsDocument | null> {
  const resolved = normalizeScope(scope);
  await ensureIndexes(db);

  const filter: Filter<ProjectInstructionsDocument> = resolved.agent
    ? {
        ...exactScopeFilter(resolved),
        agent: { $in: [resolved.agent, null] },
        ...CURRENT_INSTRUCTIONS_FILTER,
      }
    : {
        ...exactScopeFilter(resolved),
        ...CURRENT_INSTRUCTIONS_FILTER,
      };

  const rows = await findRows(db, filter);
  if (rows.length === 0) return null;

  if (resolved.agent) {
    const agentScoped = rows.find((row) => row.agent === resolved.agent);
    if (agentScoped) return agentScoped;
  }
  return rows.find((row) => !row.agent) ?? rows[0] ?? null;
}

/**
 * Which scope a self-edit should write to: the scope of the document the
 * agent actually READS. Without this, an agent whose context carries an
 * agent id would fork a private copy the moment it edited, silently
 * shadowing the project-wide document the user maintains in the UI.
 */
async function resolveWriteScope(
  db: Db,
  scope: ProjectInstructionsScope,
): Promise<ResolvedInstructionsScope> {
  const resolved = normalizeScope(scope);
  const effective = await getCurrent(db, resolved);
  if (!effective) return { ...resolved, agent: null };
  return {
    project: effective.project,
    username: effective.username,
    agent: effective.agent || null,
    // getCurrent only ever returns rows in the requester's profile partition;
    // legacy rows (no profileId) belong to the default profile.
    profileId: effective.profileId || resolved.profileId,
  };
}

/**
 * Replace the document's content with a new version. The previous version
 * is superseded, never overwritten.
 */
async function setContent(
  db: Db,
  scope: ProjectInstructionsScope,
  content: string,
  updatedBy: InstructionsAuthor = "user",
  options: SetContentOptions = {},
): Promise<ProjectInstructionsDocument> {
  const resolved = normalizeScope(scope);
  const normalizedContent = typeof content === "string" ? content : "";
  assertWithinContentCap(normalizedContent);
  await ensureIndexes(db);

  const collection = collectionFor(db);
  const now = new Date().toISOString();
  let inserted: ProjectInstructionsDocument | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const candidate: ProjectInstructionsDocument = {
      id: crypto.randomUUID(),
      project: resolved.project,
      username: resolved.username,
      agent: resolved.agent,
      // Always the literal profile id — never the $in filter value.
      profileId: resolved.profileId,
      content: normalizedContent,
      version: (await highestVersion(db, resolved)) + 1,
      validTo: null,
      supersededBy: null,
      closedReason: null,
      updatedBy,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await collection.insertOne(candidate);
      inserted = candidate;
      break;
    } catch (error: unknown) {
      lastError = error;
      // A concurrent writer claimed this version number — re-read and retry.
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  if (!inserted) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to write project instructions");
  }

  await collection.updateMany(
    {
      ...exactScopeFilter(resolved),
      ...CURRENT_INSTRUCTIONS_FILTER,
      version: { $lt: inserted.version },
    },
    {
      $set: {
        validTo: now,
        supersededBy: inserted.id,
        closedReason: options.reason || "superseded",
        updatedAt: now,
      },
    },
  );

  logger.info(
    `[ProjectInstructionsService] ${resolved.project}/${resolved.username}/${resolved.agent ?? "*"} ` +
      `→ v${inserted.version} by ${updatedBy} (${normalizedContent.length} chars)`,
  );

  return inserted;
}

/**
 * Add or replace a single `## heading` section — the operation an agent
 * reaches for when it learns one durable thing and must not disturb the
 * rest of the document.
 */
async function appendSection(
  db: Db,
  scope: ProjectInstructionsScope,
  heading: string,
  body: string,
  updatedBy: InstructionsAuthor = "agent",
): Promise<ProjectInstructionsDocument> {
  const resolved = normalizeScope(scope);
  const current = await getExactCurrent(db, resolved);
  const nextContent = upsertMarkdownSection(
    current?.content ?? "",
    heading,
    body,
  );

  // A no-op edit must not manufacture a version.
  if (current && nextContent === current.content) return current;

  return setContent(db, resolved, nextContent, updatedBy, {
    reason: "edited",
  });
}

/** Version history for the exact scope, newest first. */
async function listVersions(
  db: Db,
  scope: ProjectInstructionsScope,
  limit: number = DEFAULT_VERSION_HISTORY_LIMIT,
): Promise<ProjectInstructionsDocument[]> {
  const resolved = normalizeScope(scope);
  await ensureIndexes(db);
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), MAX_VERSION_HISTORY_LIMIT)
    : DEFAULT_VERSION_HISTORY_LIMIT;
  return findRows(db, exactScopeFilter(resolved), boundedLimit);
}

/**
 * Restore an earlier version's content as a NEW version — rollback moves
 * forward in version-time, so the history stays append-only.
 */
async function rollbackTo(
  db: Db,
  scope: ProjectInstructionsScope,
  version: number,
  updatedBy: InstructionsAuthor = "user",
): Promise<ProjectInstructionsDocument | null> {
  const resolved = normalizeScope(scope);
  await ensureIndexes(db);
  const rows = await findRows(
    db,
    { ...exactScopeFilter(resolved), version },
    1,
  );
  const target = rows[0];
  if (!target) return null;

  return setContent(db, resolved, target.content, updatedBy, {
    reason: `rollback to v${version}`,
  });
}

/**
 * Soft-close the current document — the instructions stop being injected,
 * but every version stays queryable and rollbackTo() can bring them back.
 */
async function clear(
  db: Db,
  scope: ProjectInstructionsScope,
  updatedBy: InstructionsAuthor = "user",
  reason = "cleared",
): Promise<ProjectInstructionsDocument | null> {
  const resolved = normalizeScope(scope);
  const current = await getExactCurrent(db, resolved);
  if (!current) return null;

  const now = new Date().toISOString();
  await collectionFor(db).updateMany(
    { ...exactScopeFilter(resolved), ...CURRENT_INSTRUCTIONS_FILTER },
    {
      $set: {
        validTo: now,
        supersededBy: null,
        closedReason: reason,
        updatedBy,
        updatedAt: now,
      },
    },
  );

  logger.info(
    `[ProjectInstructionsService] Cleared ${resolved.project}/${resolved.username}/${resolved.agent ?? "*"} (was v${current.version})`,
  );

  return {
    ...current,
    validTo: now,
    supersededBy: null,
    closedReason: reason,
    updatedBy,
    updatedAt: now,
  };
}

/** Db handle for callers without a request (internal tools). */
function getDatabase(): Db | null {
  try {
    return MongoWrapper.getDb(MONGO_DB_NAME) ?? null;
  } catch {
    return null;
  }
}

const ProjectInstructionsService = {
  getDatabase,
  ensureIndexes,
  normalizeScope,
  resolveWriteScope,
  getCurrent,
  getExactCurrent,
  setContent,
  appendSection,
  listVersions,
  rollbackTo,
  clear,
  upsertMarkdownSection,
  parseHeadingSpec,
  hasMarkdownSection,
};

export default ProjectInstructionsService;
