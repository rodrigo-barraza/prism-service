import type { Db } from "mongodb";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import MongoWrapper from "#src/wrappers/MongoWrapper";
import { MONGO_DB_NAME } from "#config";
import { COLLECTIONS } from "#src/constants";
import logger from "#src/utils/logger";
import { estimateTokens } from "#src/utils/CostCalculator";
import {
  catalogDescription,
  toSkill,
  type Skill,
  type SkillCaller,
} from "#src/services/SkillService";

// ────────────────────────────────────────────────────────────
// SkillUsage — one row per skill invocation, and the report over them
// ────────────────────────────────────────────────────────────
// load_skill and execute_skill each record a row in `skill_usage`
// (SkillService counts the lifetime total on the skill as well). The
// admin report (GET /admin/skills/usage) joins the skills with the last
// 30 days of rows: invocations, last use, what the skill's catalog line
// costs every prompt and what its body costs when loaded, and which
// skills nobody invoked in the window — the ones paying catalog tokens
// for nothing. Rows expire after 180 days (a TTL index, src/index.ts).
// ────────────────────────────────────────────────────────────

export const SKILL_USAGE_WINDOW_DAYS = 30;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

export type SkillInvocationKind = "load" | "execute";

export interface SkillUsageDocument {
  /** `String(_id)` of the skill document. */
  skillDocumentId: string;
  skillId: string;
  name: string;
  kind: SkillInvocationKind;
  project: string;
  username: string;
  profileId: string;
  agent: string | null;
  conversationId: string | null;
  agentConversationId: string | null;
  at: Date;
}

export interface SkillInvocationWhere {
  conversationId?: string | null;
  agentConversationId?: string | null;
}

/** Record one invocation. Best effort: a failed write never fails the tool. */
export async function recordSkillUsage(
  skill: Pick<Skill, "id" | "skillId" | "name">,
  caller: SkillCaller,
  kind: SkillInvocationKind,
  where: SkillInvocationWhere = {},
): Promise<void> {
  try {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.SKILL_USAGE);
    if (!collection) return;
    const row: SkillUsageDocument = {
      skillDocumentId: skill.id,
      skillId: skill.skillId,
      name: skill.name,
      kind,
      project: caller.project,
      username: caller.username,
      profileId: caller.profileId,
      agent: caller.agent,
      conversationId: where.conversationId ?? null,
      agentConversationId: where.agentConversationId ?? null,
      at: new Date(),
    };
    await collection.insertOne(row as unknown as Record<string, unknown>);
  } catch (error: unknown) {
    logger.warn(`[SkillUsage] Could not record a ${kind} of "${skill.name}": ${getErrorMessage(error)}`);
  }
}

export interface SkillUsageRow {
  id: string;
  name: string;
  skillId: string;
  source: string;
  enabled: boolean;
  project: string | null;
  username: string | null;
  agent: string | null;
  /** Invocations in the window, from the usage rows. */
  invocations: number;
  /** Every invocation since the skill was created (its counter). */
  totalInvocations: number;
  lastUsedAt: string | null;
  /** What the skill's catalog line adds to every prompt that lists it. */
  catalogTokens: number;
  /** What load_skill returns: the body. */
  bodyTokens: number;
  neverInvokedInWindow: boolean;
  createdAt: string | null;
}

export interface SkillUsageReport {
  windowDays: number;
  since: string;
  generatedAt: string;
  skills: SkillUsageRow[];
  totals: {
    skills: number;
    invocations: number;
    /** Catalog tokens of the enabled skills. */
    catalogTokens: number;
    neverInvokedInWindow: number;
  };
}

/** The line the skill catalog lists a skill as (system prompt §8, SkillMemoryScorer). */
function catalogLine(skill: Skill): string {
  const description = catalogDescription(skill);
  return description ? `- ${skill.name}: ${description}` : `- ${skill.name}`;
}

function byNameThenId(left: SkillUsageRow, right: SkillUsageRow): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function isoOf(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value ? value : null;
}

/**
 * Every skill (optionally one project's or one user's — a legacy skill with
 * no project or owner belongs to every one) with its usage in the last 30
 * days, by name.
 */
export async function buildSkillUsageReport(
  db: Pick<Db, "collection">,
  {
    project,
    username,
    now = new Date(),
  }: { project?: string | null; username?: string | null; now?: Date } = {},
): Promise<SkillUsageReport> {
  const since = new Date(now.getTime() - SKILL_USAGE_WINDOW_DAYS * DAY_MILLISECONDS);
  const filter: Record<string, unknown> = {
    ...(project ? { project: { $in: [project, null] } } : {}),
    ...(username ? { username: { $in: [username, null] } } : {}),
  };
  const documents = await db
    .collection(COLLECTIONS.AGENT_SKILLS)
    .find(filter)
    .project({ embedding: 0 })
    .toArray();
  const rows = (await db
    .collection(COLLECTIONS.SKILL_USAGE)
    .find({ at: { $gte: since } })
    .project({ skillDocumentId: 1, at: 1 })
    .toArray()) as unknown as Array<Pick<SkillUsageDocument, "skillDocumentId" | "at">>;

  const invocations = new Map<string, { count: number; last: Date }>();
  for (const row of rows) {
    const at = row.at instanceof Date ? row.at : new Date(row.at);
    const held = invocations.get(row.skillDocumentId);
    if (!held) invocations.set(row.skillDocumentId, { count: 1, last: at });
    else {
      held.count += 1;
      if (at > held.last) held.last = at;
    }
  }

  const skills = documents
    .map((document) => toSkill(document as Parameters<typeof toSkill>[0]))
    .map((skill): SkillUsageRow => {
      const usage = invocations.get(skill.id);
      const lastUsed = [isoOf(skill.lastUsedAt), usage ? usage.last.toISOString() : null]
        .filter((value): value is string => !!value)
        .sort()
        .at(-1) ?? null;
      const count = usage?.count ?? 0;
      return {
        id: skill.id,
        name: skill.name,
        skillId: skill.skillId,
        source: skill.source,
        enabled: skill.enabled,
        project: skill.scope.project,
        username: skill.scope.username,
        agent: skill.scope.agent,
        invocations: count,
        totalInvocations: Math.max(skill.usageCount, count),
        lastUsedAt: lastUsed,
        catalogTokens: estimateTokens(catalogLine(skill)),
        bodyTokens: estimateTokens(skill.body),
        // A use counted only on the skill (before rows were kept) still counts.
        neverInvokedInWindow: count === 0 && !(lastUsed && lastUsed >= since.toISOString()),
        createdAt: skill.createdAt,
      };
    })
    .sort(byNameThenId);

  return {
    windowDays: SKILL_USAGE_WINDOW_DAYS,
    since: since.toISOString(),
    generatedAt: now.toISOString(),
    skills,
    totals: {
      skills: skills.length,
      invocations: skills.reduce((sum, skill) => sum + skill.invocations, 0),
      catalogTokens: skills
        .filter((skill) => skill.enabled)
        .reduce((sum, skill) => sum + skill.catalogTokens, 0),
      neverInvokedInWindow: skills.filter((skill) => skill.neverInvokedInWindow).length,
    },
  };
}
