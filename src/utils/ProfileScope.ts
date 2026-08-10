import type { Request } from "express";

/**
 * Profile scoping — the third identity dimension alongside project/username.
 *
 * A profile partitions user-scoped data (conversations, skills, rules, hooks,
 * memories, …) so one person can operate as multiple isolated personas.
 * Identity is carried per request in the `x-profile-id` header; absence means
 * the default profile. The header is prism-local for now (not yet promoted to
 * the utilities-library IDENTITY_HEADERS taxonomy), so CORS allows it
 * explicitly in src/index.ts.
 *
 * Documents written before profiles existed have no `profileId` field. The
 * default profile therefore matches BOTH "default" and missing/null via
 * `profileFilter`, so pre-profile data belongs to the default profile without
 * a migration.
 */
export const PROFILE_ID_HEADER = "x-profile-id";
export const DEFAULT_PROFILE_ID = "default";

/** Profile ids are client-asserted; constrain to a safe slug shape. */
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Normalize a raw header/param value to a safe profile id. */
export function normalizeProfileId(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return PROFILE_ID_PATTERN.test(value) ? value : DEFAULT_PROFILE_ID;
}

/** Mongo filter value matching a profile id in a query. */
export type ProfileIdFilter = string | { $in: (string | null)[] };

/**
 * Mongo filter value for a profile id. The default profile owns legacy
 * documents that predate the field ({ $in: [..., null] } matches missing
 * fields too).
 */
export function profileFilter(profileId: string): ProfileIdFilter {
  return profileId === DEFAULT_PROFILE_ID
    ? { $in: [DEFAULT_PROFILE_ID, null] }
    : profileId;
}

export interface RequestScope {
  project: string;
  username: string;
  profileId: string;
}

/**
 * The {project, username, profileId} identity of a request. Use these values
 * to stamp inserts (always the literal id, never the $in filter).
 */
export function resolveScope(req: Request): RequestScope {
  return {
    project: req.project || "any",
    username: req.username || "any",
    profileId: normalizeProfileId(req.profileId),
  };
}

/**
 * The read-scope of a request as a Mongo filter fragment — spread into
 * find/update/delete filters of profile-partitioned collections.
 */
export function scopeFilter(req: Request): {
  project: string;
  username: string;
  profileId: ProfileIdFilter;
} {
  const { project, username, profileId } = resolveScope(req);
  return { project, username, profileId: profileFilter(profileId) };
}
