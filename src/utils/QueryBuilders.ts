import type { MongoFilter } from "../types/express.ts";

/**
 * Build a MongoDB date-range filter from optional `from` and `to` query params.
 * Returns an object like `{ $gte: from, $lte: to }`, or `null` if neither is set.
 */
export function buildDateRangeFilter(
  from: string | undefined | null,
  to: string | undefined | null,
): Record<string, string> | null {
  if (!from && !to) return null;
  const filter: Record<string, string> = {};
  if (from) filter.$gte = from;
  if (to) filter.$lte = to;
  return filter;
}

/**
 * Apply a date-range filter to an existing match object.
 * Mutates `matchFilter` in place for convenience.
 */
export function applyDateRangeFilter(
  matchFilter: MongoFilter,
  from: string | undefined | null,
  to: string | undefined | null,
  field: string = "timestamp",
): void {
  const range = buildDateRangeFilter(from, to);
  if (range) matchFilter[field] = range;
}

/**
 * Standard pagination parameters parsed from Express query strings.
 */
export interface PaginationParams {
  skip: number;
  limit: number;
  page: number;
  sortDirection: 1 | -1;
}

/**
 * Parse pagination and sort parameters from Express query strings.
 * Handles the `parseInt` casting and default values consistently.
 */
export function parsePaginationParams(query: {
  page?: unknown;
  limit?: unknown;
  order?: unknown;
}): PaginationParams {
  const page = parseInt(String(query.page || "1"), 10);
  const limit = parseInt(String(query.limit || "50"), 10);
  const sortDirection: 1 | -1 = query.order === "asc" ? 1 : -1;
  const skip = (page - 1) * limit;
  return { skip, limit, page, sortDirection };
}

/**
 * Core MongoDB projection fields shared across conversation list endpoints.
 * Both the user-facing and admin conversation routes must include these fields
 * to ensure feature parity (sub-agent hierarchy, cost display, etc.).
 *
 * Each consumer spreads this base and adds route-specific overrides
 * (e.g. computed $ifNull expressions or additional metadata fields).
 */
export const CONVERSATION_LIST_BASE_PROJECTION: Record<string, 1> = {
  id: 1,
  project: 1,
  username: 1,
  title: 1,
  createdAt: 1,
  updatedAt: 1,
  modalities: 1,
  providers: 1,
  totalCost: 1,
  agent: 1,
  parentConversationId: 1,
  hasSubAgents: 1,
};
