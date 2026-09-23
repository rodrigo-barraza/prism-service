import type { ObjectId } from "mongodb";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import { MAX_TOOL_ITERATIONS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "#src/utils/logger";
import { normalizeProfileId, profileFilter } from "#src/utils/ProfileScope";
import { getRequestContext } from "#src/utils/RequestContext";
import SkillFolderStore, {
  type SkillFolderFile,
  type SkillFolderResource,
  type StoredSkillFolder,
} from "#src/services/skills/SkillFolderStore";
import { normalizeSkillFilePath } from "#src/services/skills/skillFilePaths";
import { SKILL_FILE_NAME } from "#src/services/skills/skillMarkdown";
import type {
  SkillInvocationKind,
  SkillInvocationWhere,
} from "#src/services/skills/SkillUsage";

// ────────────────────────────────────────────────────────────
// SkillService — the one reader and writer of `agent_skills`
// ────────────────────────────────────────────────────────────
// A skill is a named body of instructions the agent loads on demand.
// The system prompt carries only a catalog (name + one-line
// description); `load_skill` returns the body when a task needs it
// (progressive disclosure — prompt 19).
//
// Two schemas share the collection, and every read goes through
// `toSkill`, which maps both onto the one `Skill` type:
//   - panel skills (SkillsRoutes before Landing 1, and every write
//     since): body in `content`, scoped by project/username/profileId,
//     `enabled`, an `embedding`;
//   - SkillService skills (the create_skill tool and the Claude config
//     importer before Landing 1): body in `prompt`, a `skillId` slug,
//     execution settings (`tools`, `steps`, `maxIterations`, `model`),
//     `project` possibly null, and no `username`, `profileId` or
//     `enabled` at all.
// Nothing is migrated in place: an unset scope field on a legacy
// document reads as "every value" (a null project is every project, a
// missing owner is shared), which is exactly who could reach those
// documents before. New writes always stamp the caller's full scope.
//
// An imported skill keeps its folder (Landing 2): `folderRef` names it in
// SkillFolderStore and `resources` is its manifest. load_skill lists the
// bundled files; read_skill_file reads one, only by a manifest path.
// ────────────────────────────────────────────────────────────

/** Who a skill is visible to. `null` is unset: every value matches. */
export interface SkillScope {
  project: string | null;
  username: string | null;
  profileId: string | null;
  /** Persona the skill is bound to; null = every persona. */
  agent: string | null;
}

/** A bundled file of a skill folder, as load_skill lists it. */
export interface SkillResource {
  path: string;
  bytes: number;
}

/** The one skill shape every reader sees, whichever schema stored it. */
export interface Skill {
  /** `String(_id)` — what the Skills panel addresses a skill by. */
  id: string;
  /** Name slug — what execute_skill / delete_skill address a skill by. */
  skillId: string;
  name: string;
  description: string;
  body: string;
  scope: SkillScope;
  enabled: boolean;
  /** "user" (Skills panel), "agent" (create_skill), "claude-config:<root>" (importer). */
  source: string;
  /** Where SkillFolderStore keeps the skill's folder; null = a body only. */
  folderRef: string | null;
  /** The stored folder's manifest (SKILL.md included), by path. */
  resources: SkillFolderResource[];
  /** Tools a skill run may use; null = no restriction. */
  allowedTools: string[] | null;
  embedding: number[] | null;
  /** execute_skill settings (SkillService-schema skills). */
  steps: string[];
  maxIterations: number | null;
  model: string | null;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The identity asking — always concrete, unlike a stored scope. */
export interface SkillCaller {
  project: string;
  username: string;
  profileId: string;
  agent: string | null;
}

export interface SkillWriteInput {
  name: string;
  description?: string;
  body: string;
  enabled?: boolean;
  agent?: string | null;
  source?: string;
  allowedTools?: string[] | null;
  steps?: string[];
  maxIterations?: number;
  model?: string | null;
  /** A folder already written to SkillFolderStore. */
  folder?: StoredSkillFolder | null;
}

/** A skill read from an external source (a Claude config or a plugin). */
export interface ImportedSkillInput {
  name: string;
  description?: string;
  body: string;
  source: string;
  agent?: string | null;
  allowedTools?: string[] | null;
  /** The skill's folder, SKILL.md included; stored on create or change. */
  files?: SkillFolderFile[];
}

export interface SkillPatch {
  name?: string;
  description?: string;
  body?: string;
  enabled?: boolean;
}

export interface SkillUpsertResult {
  status: "created" | "updated" | "unchanged" | "skipped";
  skillId?: string;
  reason?: string;
  error?: string;
}

export interface SkillPrepareResult {
  skillId?: string;
  name?: string;
  prompt?: string;
  config?: {
    maxIterations: number;
    model: string | null;
    tools: string[] | null;
    agent: string | null;
    project: string | null;
  };
  unresolved?: string[];
  steps?: string[];
  error?: string;
}

export interface LoadedSkill {
  name: string;
  description: string;
  body: string;
  source: string;
  resources: SkillResource[];
  /** How to read a bundled file — present when there are any. */
  hint?: string;
  allowedTools?: string[];
  steps?: string[];
  /** `{{variable}}` placeholders — execute_skill fills them. */
  templateVariables?: string[];
}

/** A document as stored — either schema, or both after a write. */
interface StoredSkillDocument {
  _id?: ObjectId;
  skillId?: string;
  name?: string;
  description?: string;
  content?: string;
  prompt?: string;
  project?: string | null;
  username?: string | null;
  profileId?: string | null;
  agent?: string | null;
  enabled?: boolean;
  source?: string;
  folderRef?: string | null;
  resources?: SkillFolderResource[];
  allowedTools?: string[] | null;
  tools?: string[] | null;
  steps?: string[];
  maxIterations?: number;
  model?: string | null;
  usageCount?: number;
  lastUsedAt?: string | null;
  embedding?: number[] | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

interface VisibleSkill {
  document: StoredSkillDocument;
  skill: Skill;
}

const TEMPLATE_VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;
const CATALOG_DESCRIPTION_MAX_CHARS = 160;
/** read_skill_file returns at most this much of a text file. */
const SKILL_FILE_READ_MAX_BYTES = 256 * 1024;
/** Bytes sniffed for a NUL when telling text from binary. */
const BINARY_SNIFF_BYTES = 8_000;
const SCRIPT_NOTE =
  "This is a bundled script: reading it runs nothing. To run it, use the shell tool — it " +
  "gets the normal approvals, and nothing about coming from a skill changes that.";

function getCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_SKILLS);
}

/** The slug execute_skill and delete_skill address a skill by. */
export function skillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isoString(value: Date | string | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : null;
}

/** Read either stored schema as the one `Skill` type. */
export function toSkill(document: StoredSkillDocument): Skill {
  const name = String(document.name ?? document.skillId ?? "");
  const body =
    typeof document.content === "string"
      ? document.content
      : typeof document.prompt === "string"
        ? document.prompt
        : "";
  const isLegacyServiceSchema =
    typeof document.prompt === "string" && typeof document.content !== "string";
  return {
    id: document._id === undefined || document._id === null ? "" : String(document._id),
    skillId: document.skillId || skillSlug(name),
    name,
    description: typeof document.description === "string" ? document.description : "",
    body,
    scope: {
      project: document.project ?? null,
      username: document.username ?? null,
      profileId: document.profileId ?? null,
      agent: document.agent ?? null,
    },
    enabled: document.enabled !== false,
    source: document.source || (isLegacyServiceSchema ? "agent" : "user"),
    folderRef: document.folderRef ?? null,
    resources: Array.isArray(document.resources)
      ? document.resources.filter(
          (resource): resource is SkillFolderResource =>
            !!resource && typeof resource.path === "string",
        )
      : [],
    allowedTools: stringList(document.allowedTools) ?? stringList(document.tools),
    embedding: Array.isArray(document.embedding) ? document.embedding : null,
    steps: stringList(document.steps) ?? [],
    maxIterations:
      typeof document.maxIterations === "number" ? document.maxIterations : null,
    model: document.model ?? null,
    usageCount: typeof document.usageCount === "number" ? document.usageCount : 0,
    lastUsedAt: document.lastUsedAt ?? null,
    createdAt: isoString(document.createdAt),
    updatedAt: isoString(document.updatedAt),
  };
}

/**
 * The caller's identity, from what the call site knows, then the request's
 * async context (which carries the profile), then the unscoped defaults the
 * routes use.
 */
export function resolveSkillCaller(
  known: {
    project?: string | null;
    username?: string | null;
    profileId?: string | null;
    agent?: string | null;
  } = {},
): SkillCaller {
  const request = getRequestContext();
  return {
    project: known.project || request.project || "any",
    username: known.username || request.username || "any",
    profileId: normalizeProfileId(known.profileId || request.profileId),
    // An explicit null (direct mode) means "no persona", not "ask the request".
    agent: known.agent !== undefined ? known.agent : (request.agent ?? null),
  };
}

/**
 * Documents the caller may see. An unset (null or missing) field matches
 * every caller — `$in: [value, null]` matches missing fields too.
 */
function visibilityFilter(caller: SkillCaller, forAgent: boolean) {
  return {
    project: { $in: [caller.project, null] },
    username: { $in: [caller.username, null] },
    profileId: profileFilter(caller.profileId),
    ...(forAgent ? { agent: { $in: [caller.agent, null] } } : {}),
  };
}

/** Owned-by-this-caller documents (the scope a write stamps). */
function ownerFilter(caller: SkillCaller) {
  return {
    project: caller.project,
    username: caller.username,
    profileId: profileFilter(caller.profileId),
  };
}

/** Owner, then project, then persona: the narrower scope wins a name clash. */
function specificity(skill: Skill): number {
  return (
    (skill.scope.username ? 4 : 0) +
    (skill.scope.project ? 2 : 0) +
    (skill.scope.agent ? 1 : 0)
  );
}

/** Byte order, not locale order: the catalog must not move with ICU data. */
function byNameThenId(left: Skill, right: Skill): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** One skill per name — the most specific scope's — ordered by name. */
function shadowByName(visible: VisibleSkill[]): VisibleSkill[] {
  const byName = new Map<string, VisibleSkill>();
  for (const entry of [...visible].sort((left, right) =>
    byNameThenId(left.skill, right.skill),
  )) {
    const key = entry.skill.name.toLowerCase();
    const held = byName.get(key);
    if (!held || specificity(entry.skill) > specificity(held.skill)) {
      byName.set(key, entry);
    }
  }
  return [...byName.values()].sort((left, right) =>
    byNameThenId(left.skill, right.skill),
  );
}

function matchesReference(skill: Skill, reference: string): boolean {
  return (
    skill.id === reference ||
    skill.name === reference ||
    skill.skillId === reference ||
    skill.skillId === skillSlug(reference)
  );
}

function templateVariables(body: string): string[] {
  return [...new Set([...body.matchAll(TEMPLATE_VARIABLE_PATTERN)].map((match) => match[1]))];
}

/** A catalog line's description: one line, bounded, never the body. */
export function catalogDescription(skill: Skill): string {
  const source =
    skill.description.trim() ||
    skill.body
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0) ||
    "";
  const oneLine = source.replace(/\s+/g, " ").trim();
  return oneLine.length > CATALOG_DESCRIPTION_MAX_CHARS
    ? `${oneLine.slice(0, CATALOG_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`
    : oneLine;
}

/** Embed name + description + body for relevance highlighting. Best effort. */
async function embedSkill(
  fields: { name: string; description: string; body: string },
  endpoint: string,
): Promise<number[] | null> {
  try {
    const { default: EmbeddingService } = await import(
      "#src/services/EmbeddingService"
    );
    const text = [fields.name, fields.description, fields.body]
      .filter(Boolean)
      .join("\n");
    const vector = await EmbeddingService.embed(text, {
      source: "skill-creation",
      endpoint,
    });
    return Array.isArray(vector) ? vector : null;
  } catch (error: unknown) {
    logger.warn(`[SkillService] Embedding failed: ${getErrorMessage(error)}`);
    return null;
  }
}

async function findVisible(
  caller: SkillCaller,
  {
    forAgent,
    includeDisabled = false,
    withEmbeddings = false,
  }: { forAgent: boolean; includeDisabled?: boolean; withEmbeddings?: boolean },
): Promise<VisibleSkill[]> {
  const collection = getCollection();
  if (!collection) return [];
  const documents = (await collection
    .find({
      ...visibilityFilter(caller, forAgent),
      ...(includeDisabled ? {} : { enabled: { $ne: false } }),
    })
    .project(withEmbeddings ? {} : { embedding: 0 })
    .toArray()) as unknown as StoredSkillDocument[];
  return documents.map((document) => ({ document, skill: toSkill(document) }));
}

/** Skill as the Skills panel API returns it (legacy field names kept). */
export function toApiSkill(skill: Skill) {
  return {
    id: skill.id,
    skillId: skill.skillId,
    name: skill.name,
    description: skill.description,
    content: skill.body,
    enabled: skill.enabled,
    project: skill.scope.project,
    username: skill.scope.username,
    profileId: skill.scope.profileId,
    agent: skill.scope.agent,
    source: skill.source,
    allowedTools: skill.allowedTools,
    resources: skill.resources.map(({ path, bytes }) => ({ path, bytes })),
    usageCount: skill.usageCount,
    lastUsedAt: skill.lastUsedAt,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

/** Skill as the agent's list_skills sees it: no body, no vector. */
function toListedSkill(skill: Skill) {
  return {
    name: skill.name,
    skillId: skill.skillId,
    description: catalogDescription(skill),
    source: skill.source,
    ...(skill.scope.agent ? { agent: skill.scope.agent } : {}),
    usageCount: skill.usageCount,
    lastUsedAt: skill.lastUsedAt,
  };
}

function sameList(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** Same files, same bytes — the stored folder can stay. */
function sameManifest(stored: SkillFolderResource[], incoming: SkillFolderResource[]): boolean {
  if (stored.length !== incoming.length) return false;
  const byPath = new Map(stored.map((resource) => [resource.path, resource.sha256]));
  return incoming.every(
    (resource) => resource.sha256 !== undefined && byPath.get(resource.path) === resource.sha256,
  );
}

/** Best effort: a folder no document points at is only wasted space. */
async function dropFolder(folderRef: string | null | undefined): Promise<void> {
  try {
    await SkillFolderStore.remove(folderRef);
  } catch (error: unknown) {
    logger.warn(`[SkillService] Could not drop skill folder ${folderRef}: ${getErrorMessage(error)}`);
  }
}

/** A buffer's text when it reads as UTF-8 text; null for binary. */
function asText(content: Buffer): string | null {
  if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function isScript(filePath: string, text: string): boolean {
  return filePath.startsWith("scripts/") || text.startsWith("#!");
}

/** The enabled catalog skill `name` names for this caller, or why not. */
async function findLoadable(
  name: string,
  caller: SkillCaller,
): Promise<VisibleSkill | { error: string }> {
  const visible = shadowByName(await findVisible(caller, { forAgent: true }));
  const found =
    visible.find(({ skill }) => skill.name === name) ||
    visible.find(({ skill }) => skill.name.toLowerCase() === name.toLowerCase()) ||
    visible.find(({ skill }) => skill.skillId === skillSlug(name));
  if (found) return found;
  const available = visible.map(({ skill }) => skill.name);
  return {
    error:
      `No skill named "${name}" is available here.` +
      (available.length > 0 ? ` Available: ${available.join(", ")}.` : " This scope has no skills."),
  };
}

/**
 * Count one use: the skill's lifetime counter and last use, and a usage row
 * for the admin report's window (SkillUsage.ts).
 */
async function countUse(
  collection: NonNullable<ReturnType<typeof getCollection>>,
  document: StoredSkillDocument,
  skill: Skill,
  caller: SkillCaller,
  kind: SkillInvocationKind,
  where: SkillInvocationWhere,
): Promise<void> {
  const { recordSkillUsage } = await import("#src/services/skills/SkillUsage");
  await Promise.all([
    collection.updateOne(
      { _id: document._id },
      { $inc: { usageCount: 1 }, $set: { lastUsedAt: new Date().toISOString() } },
    ),
    recordSkillUsage(skill, caller, kind, where),
  ]);
}

const SkillService = {
  /** Create a skill in the caller's scope. A name is unique per scope. */
  async create(input: SkillWriteInput, caller: SkillCaller) {
    const collection = getCollection();
    if (!collection) return { error: "Database not available" };

    const name = typeof input.name === "string" ? input.name.trim() : "";
    const body = typeof input.body === "string" ? input.body : "";
    if (!name) return { error: "'name' is required (string)" };
    if (!body.trim()) return { error: "a skill needs a body" };
    const skillId = skillSlug(name);
    if (!skillId) return { error: `'${name}' has no letters or digits to name the skill by` };

    const owned = (await collection
      .find(ownerFilter(caller))
      .project({ embedding: 0 })
      .toArray()) as unknown as StoredSkillDocument[];
    if (owned.some((document) => toSkill(document).skillId === skillId)) {
      return {
        error: `Skill "${skillId}" already exists in this scope. Delete it first or use a different name.`,
      };
    }

    const description = input.description || "";
    const now = new Date();
    const document: StoredSkillDocument = {
      skillId,
      name,
      description,
      content: body,
      project: caller.project,
      username: caller.username,
      profileId: caller.profileId,
      agent: input.agent ?? null,
      enabled: input.enabled !== false,
      source: input.source || "user",
      ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
      ...(input.steps?.length ? { steps: input.steps } : {}),
      ...(typeof input.maxIterations === "number"
        ? { maxIterations: Math.min(100, Math.max(1, input.maxIterations)) }
        : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.folder
        ? { folderRef: input.folder.folderRef, resources: input.folder.resources }
        : {}),
      usageCount: 0,
      embedding: await embedSkill({ name, description, body }, "/skills"),
      createdAt: now,
      updatedAt: now,
    };

    const result = await collection.insertOne(document as Record<string, unknown>);
    logger.info(`[SkillService] Created skill "${name}" (${skillId}) for ${caller.username}/${caller.project}`);
    return {
      skill: toSkill({ ...document, _id: result.insertedId }),
      message: `Skill "${name}" created. It is in the skill catalog from the next turn; load it with load_skill({ name: "${name}" }).`,
    };
  },

  /**
   * Idempotent upsert for skills imported from an external source (the
   * Claude config and Agent Plugins importers). Keyed by skillId + source
   * among the skills the caller can see:
   *   - no such skill           → created in the caller's scope, its
   *                               folder stored
   *   - same source             → updated in place (or unchanged: same
   *                               body, description, allowed tools and
   *                               folder); an unowned legacy import is
   *                               claimed; a changed folder is re-stored
   *                               and the old one dropped
   *   - different/absent source → skipped (never clobber a user skill)
   * `dryRun` reports the same status and writes nothing.
   */
  async upsertImported(
    data: ImportedSkillInput,
    caller: SkillCaller,
    { dryRun = false }: { dryRun?: boolean } = {},
  ): Promise<SkillUpsertResult> {
    const collection = getCollection();
    if (!collection) return { status: "skipped", error: "Database not available" };

    const { name, description = "", body, source } = data;
    if (!name || !body || !source) {
      return { status: "skipped", error: "'name', 'body' and 'source' are required" };
    }
    const skillId = skillSlug(name);
    const allowedTools = data.allowedTools ?? null;
    const files = data.files ?? [];
    const manifest = files.length > 0 ? SkillFolderStore.describe(files) : [];

    const existing = (
      await findVisible(caller, { forAgent: false, includeDisabled: true })
    ).find(({ skill }) => skill.skillId === skillId);

    if (existing && existing.skill.source !== source) {
      return {
        status: "skipped",
        skillId,
        reason: `skill "${skillId}" already exists from a different source (${existing.skill.source})`,
      };
    }

    if (existing) {
      const { skill, document } = existing;
      const isClaimed = skill.scope.username !== null;
      const sameFolder = sameManifest(skill.resources, manifest);
      if (
        skill.body === body &&
        skill.description === description &&
        sameList(skill.allowedTools, allowedTools) &&
        sameFolder &&
        isClaimed
      ) {
        return { status: "unchanged", skillId };
      }
      if (dryRun) return { status: "updated", skillId };

      const folder = !sameFolder && files.length > 0 ? await SkillFolderStore.save(files) : null;
      await collection.updateOne(
        { _id: document._id },
        {
          $set: {
            description,
            content: body,
            allowedTools,
            ...(sameFolder
              ? {}
              : {
                  folderRef: folder?.folderRef ?? null,
                  resources: folder?.resources ?? [],
                }),
            ...(isClaimed
              ? {}
              : {
                  project: caller.project,
                  username: caller.username,
                  profileId: caller.profileId,
                }),
            embedding: await embedSkill({ name, description, body }, "/skills/import"),
            updatedAt: new Date(),
          },
        },
      );
      if (!sameFolder) await dropFolder(skill.folderRef);
      logger.info(`[SkillService] Re-imported skill "${name}" (${skillId})`);
      return { status: "updated", skillId };
    }

    if (dryRun) return { status: "created", skillId };
    const folder = files.length > 0 ? await SkillFolderStore.save(files) : null;
    const created = await SkillService.create(
      { name, description, body, source, agent: data.agent ?? null, allowedTools, folder },
      caller,
    );
    if ("error" in created && created.error) {
      await dropFolder(folder?.folderRef);
      return { status: "skipped", skillId, error: created.error };
    }
    logger.info(`[SkillService] Imported skill "${name}" (${skillId}) from ${source}`);
    return { status: "created", skillId };
  },

  /**
   * Every skill document the caller can manage (the Skills panel's list):
   * disabled ones included, shadowed duplicates included, by name.
   */
  async listManaged(caller: SkillCaller): Promise<Skill[]> {
    return (await findVisible(caller, { forAgent: false, includeDisabled: true }))
      .map(({ skill }) => skill)
      .sort(byNameThenId);
  },

  /** The agent's view: enabled, this persona's, one per name — no bodies, no vectors. */
  async list(caller: SkillCaller) {
    const skills = shadowByName(await findVisible(caller, { forAgent: true })).map(
      ({ skill }) => toListedSkill(skill),
    );
    return {
      skills,
      total: skills.length,
      ...(skills.length > 0
        ? { hint: "Read a skill's instructions with load_skill({ name })." }
        : {}),
    };
  },

  /**
   * The skills the system-prompt catalog lists for this caller, in catalog
   * order. Embeddings are included for relevance highlighting only.
   */
  async catalog(caller: SkillCaller): Promise<Skill[]> {
    return shadowByName(
      await findVisible(caller, { forAgent: true, withEmbeddings: true }),
    ).map(({ skill }) => skill);
  },

  /** One skill the caller can see, by id, name or skillId (most specific wins). */
  async get(reference: string, caller: SkillCaller): Promise<Skill | null> {
    const match = shadowByName(
      (await findVisible(caller, { forAgent: false, includeDisabled: true })).filter(
        ({ skill }) => matchesReference(skill, reference),
      ),
    )[0];
    return match ? match.skill : null;
  },

  /** `load_skill`: the body and its resources, for an enabled catalog skill. */
  async load(
    name: string,
    caller: SkillCaller,
    where: SkillInvocationWhere = {},
  ): Promise<LoadedSkill | { error: string }> {
    const collection = getCollection();
    if (!collection) return { error: "Database not available" };

    const found = await findLoadable(name, caller);
    if ("error" in found) return found;

    const { skill, document } = found;
    await countUse(collection, document, skill, caller, "load", where);

    const variables = templateVariables(skill.body);
    // The body is SKILL.md; the rest of the folder is listed, read on demand.
    const resources = skill.resources
      .filter((resource) => resource.path !== SKILL_FILE_NAME)
      .map(({ path, bytes }) => ({ path, bytes }));
    return {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      source: skill.source,
      resources,
      ...(resources.length > 0
        ? {
            hint: `Read a bundled file with read_skill_file({ skill: "${skill.name}", path }). Scripts run only through the shell tool, with its normal approvals.`,
          }
        : {}),
      ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
      ...(skill.steps.length > 0 ? { steps: skill.steps } : {}),
      ...(variables.length > 0 ? { templateVariables: variables } : {}),
    };
  },

  /**
   * `read_skill_file`: one file of an enabled catalog skill's folder, by a
   * path its manifest lists — never anything else. Text comes back as
   * text (bounded); binary is described, not dumped. Reading a script runs
   * nothing.
   */
  async readFile(
    name: string,
    requestedPath: unknown,
    caller: SkillCaller,
  ): Promise<Record<string, unknown> | { error: string }> {
    const normalized = normalizeSkillFilePath(requestedPath);
    if ("error" in normalized) return { error: normalized.error };

    const found = await findLoadable(name, caller);
    if ("error" in found) return found;
    const { skill } = found;
    if (!skill.folderRef || skill.resources.length === 0) {
      return {
        error: `Skill "${skill.name}" has no bundled files: load_skill returns all of it.`,
      };
    }

    const resource = skill.resources.find((entry) => entry.path === normalized.path);
    if (!resource) {
      return {
        error:
          `"${normalized.path}" is not a file of skill "${skill.name}". ` +
          `Its files: ${skill.resources.map((entry) => entry.path).join(", ")}.`,
      };
    }

    let content: Buffer;
    try {
      content = await SkillFolderStore.read(skill.folderRef, resource.path);
    } catch (error: unknown) {
      logger.warn(
        `[SkillService] read_skill_file ${skill.name}/${resource.path}: ${getErrorMessage(error)}`,
      );
      return { error: `Could not read "${resource.path}" from skill "${skill.name}".` };
    }

    const base = { skill: skill.name, path: resource.path, bytes: content.length };
    const text = asText(content);
    if (text === null) {
      return { ...base, binary: true, note: "A binary file: its bytes are not returned." };
    }
    const truncated = content.length > SKILL_FILE_READ_MAX_BYTES;
    return {
      ...base,
      content: truncated
        ? new TextDecoder().decode(content.subarray(0, SKILL_FILE_READ_MAX_BYTES))
        : text,
      ...(truncated ? { truncated: true } : {}),
      ...(isScript(resource.path, text) ? { note: SCRIPT_NOTE } : {}),
    };
  },

  /** Update a skill the caller can see. Returns null when there is none. */
  async update(reference: string, patch: SkillPatch, caller: SkillCaller): Promise<Skill | { error: string } | null> {
    const collection = getCollection();
    if (!collection) return { error: "Database not available" };

    const target = (
      await findVisible(caller, { forAgent: false, includeDisabled: true })
    ).find(({ skill }) => skill.id === reference || skill.skillId === reference);
    if (!target) return null;

    const { skill, document } = target;
    const name = patch.name?.trim() || skill.name;
    const description = patch.description ?? skill.description;
    const body = patch.body ?? skill.body;
    const $set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined && name !== skill.name) {
      $set.name = name;
      $set.skillId = skillSlug(name);
    }
    if (patch.description !== undefined) $set.description = description;
    if (patch.body !== undefined) $set.content = body;
    if (patch.enabled !== undefined) $set.enabled = patch.enabled;
    if (patch.name !== undefined || patch.description !== undefined || patch.body !== undefined) {
      const embedding = await embedSkill({ name, description, body }, "/skills");
      if (embedding) $set.embedding = embedding;
    }

    await collection.updateOne({ _id: document._id }, { $set });
    logger.info(`[SkillService] Updated skill "${name}" (${skill.id})`);
    return toSkill({ ...document, ...$set } as StoredSkillDocument);
  },

  /** Delete a skill the caller can see, by id, skillId or name. */
  async delete(reference: string, caller: SkillCaller) {
    const collection = getCollection();
    if (!collection) return { error: "Database not available" };

    const target = shadowByName(
      (await findVisible(caller, { forAgent: false, includeDisabled: true })).filter(
        ({ skill }) => matchesReference(skill, reference),
      ),
    )[0];
    if (!target) return { error: `Skill "${reference}" not found` };

    await collection.deleteOne({ _id: target.document._id });
    await dropFolder(target.skill.folderRef);
    logger.info(`[SkillService] Deleted skill "${target.skill.name}" (${target.skill.id})`);
    return { deleted: true, skillId: target.skill.skillId, name: target.skill.name };
  },

  /**
   * Execute a skill — interpolates variables, counts the use, and returns
   * the assembled prompt + config for the agentic loop. The caller
   * (execute_skill) runs it.
   */
  async prepare(
    reference: string,
    variables: Record<string, unknown>,
    caller: SkillCaller,
    where: SkillInvocationWhere = {},
  ): Promise<SkillPrepareResult> {
    const collection = getCollection();
    if (!collection) return { error: "Database not available" };

    const target = shadowByName(
      (await findVisible(caller, { forAgent: true })).filter(({ skill }) =>
        matchesReference(skill, reference),
      ),
    )[0];
    if (!target) {
      return {
        error: `Skill "${reference}" not found. Use list_skills to see available skills.`,
      };
    }
    const { skill, document } = target;

    let prompt = skill.body;
    for (const [key, value] of Object.entries(variables)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
    }
    const unresolved = templateVariables(prompt);

    await countUse(collection, document, skill, caller, "execute", where);

    return {
      skillId: skill.skillId,
      name: skill.name,
      prompt,
      config: {
        maxIterations: skill.maxIterations || MAX_TOOL_ITERATIONS,
        model: skill.model,
        tools: skill.allowedTools, // null = all tools
        agent: skill.scope.agent,
        project: skill.scope.project,
      },
      unresolved: unresolved.length > 0 ? unresolved : undefined,
      steps: skill.steps.length > 0 ? skill.steps : undefined,
    };
  },
};

export default SkillService;
