import type { Db, Filter } from "mongodb";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import { COLLECTIONS } from "#src/constants";
import { profileFilter } from "#src/utils/ProfileScope";
import { compileRule, type CompiledPermissionRule } from "./PermissionEvaluator.ts";
import type { PermissionRuleDocument } from "./types.ts";

/**
 * PermissionRuleStore — loads a user profile's rules and keeps them compiled
 * in memory.
 *
 * A rule set is loaded once per run, but it READS through this cache on
 * every check (`peekRules`), and the REST routes `reloadRules` before they
 * answer. That is what makes "Always allow" work mid-turn: the card posts a
 * rule, the route reloads, and the very next tool call in the same running
 * loop is checked against it — no Mongo round-trip in front of each call,
 * and no TTL window where the new rule sits inert.
 */

export const PERMISSION_RULES = {
  /** Background staleness bound for `loadRules` (routes reload explicitly). */
  CACHE_TTL_MILLISECONDS: 30_000,
  /** Hard cap per profile — the evaluator is linear in the rule count. */
  MAX_RULES_PER_PROFILE: 500,
} as const;

export interface PermissionIdentity {
  username: string;
  profileId: string;
}

interface CachedRules {
  rules: CompiledPermissionRule[];
  loadedAt: number;
}

const cache = new Map<string, CachedRules>();

export function identityKey(identity: PermissionIdentity): string {
  return `${identity.username || "any"}::${identity.profileId || "default"}`;
}

async function queryRules(db: Db, identity: PermissionIdentity): Promise<CompiledPermissionRule[]> {
  const documents = await db
    .collection<PermissionRuleDocument>(COLLECTIONS.PERMISSION_RULES)
    // The default profile also owns legacy documents with no profileId (null).
    .find({
      username: identity.username,
      profileId: profileFilter(identity.profileId),
    } as Filter<PermissionRuleDocument>)
    .sort({ createdAt: -1 })
    .limit(PERMISSION_RULES.MAX_RULES_PER_PROFILE)
    .toArray();
  return documents.filter((document) => document.enabled !== false).map(compileRule);
}

/** Re-query and replace the cached rules. Throws on a database error. */
export async function reloadRules(
  db: Db,
  identity: PermissionIdentity,
): Promise<CompiledPermissionRule[]> {
  const rules = await queryRules(db, identity);
  cache.set(identityKey(identity), { rules, loadedAt: Date.now() });
  return rules;
}

/**
 * Cached rules when fresh, otherwise a reload. On a database error the last
 * cached rules (however old) are kept — a Mongo blip must not silently drop
 * the user's deny rules — and with nothing cached the result is empty,
 * which is what a run had before rules existed.
 */
export async function loadRules(
  db: Db | null | undefined,
  identity: PermissionIdentity,
): Promise<CompiledPermissionRule[]> {
  const cached = cache.get(identityKey(identity));
  if (cached && Date.now() - cached.loadedAt < PERMISSION_RULES.CACHE_TTL_MILLISECONDS) {
    return cached.rules;
  }
  if (!db) return cached?.rules ?? [];
  try {
    return await reloadRules(db, identity);
  } catch (error: unknown) {
    logger.warn(
      `[Permissions] Could not load rules for ${identityKey(identity)} (${cached ? "keeping the last loaded set" : "no rules cached"}): ${errorMessage(error)}`,
    );
    return cached?.rules ?? [];
  }
}

/** The cached rules, however old, or `null` when never loaded. Synchronous. */
export function peekRules(identity: PermissionIdentity): CompiledPermissionRule[] | null {
  return cache.get(identityKey(identity))?.rules ?? null;
}

/** Test seam. */
export function clearPermissionRuleCache(): void {
  cache.clear();
}
