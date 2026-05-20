import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response, NextFunction } from "express";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import { buildConversationPatchFields } from "../services/ConversationService.ts";
import { COLLECTIONS } from "../constants.ts";
import logger from "../utils/logger.ts";

const router = express.Router();
router.use(requireDb);

const COLLECTION = COLLECTIONS.AGENT_SESSIONS;

/**
 * GET /agent-sessions
 * List agent sessions for the given project with cursor-based pagination.
 * Enriches each session with toolCounts from request logs (single aggregation).
 *
 * Query params:
 *   limit  — page size (default 50, max 200)
 *   cursor — ISO date string (updatedAt of last item from previous page)
 *
 * Returns: { items, nextCursor, hasMore }
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const { project, username, db } = req;
      const limit = Math.min(
                Math.max(parseInt((req.query.limit as any), 10) || 50, 1),
        200,
      );
      const cursor = req.query.cursor || null;
      const agent = req.query.agent || null;

      const filter: any = { project, username };
      // Match sessions belonging to this agent OR legacy sessions that
      // predate the agent field (backward compat for unique-project agents
      // like Lupos where all sessions belong to the same agent).
      if (agent) {
        filter.$or = [
          { agent },
          { agent: { $exists: false } },
        ];
      }
      if (cursor) {
        // updatedAt is stored as ISO-8601 strings — compare string-to-string
        // to match BSON type and allow index range scan
        filter.updatedAt = { $lt: cursor };
      }

      // Fetch limit + 1 to detect if there's a next page
      const rows = await db
        .collection(COLLECTION)
        .find(filter)
        .project({
          id: 1,
          project: 1,
          username: 1,
          agent: 1,
          title: 1,
          createdAt: 1,
          updatedAt: 1,
          modalities: 1,
          providers: 1,
          totalCost: 1,
          isGenerating: 1,
          settings: 1,
          traceId: 1,
          parentAgentSessionId: 1,
          workspaceRoot: 1,
        })
        .sort({ updatedAt: -1 })
        .limit(limit + 1)
        .toArray();

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1].updatedAt : null;

      // ── Enrich session items from request logs (single aggregation) ──
      // Collects authoritative cost, unique models/providers, merged modalities,
      // and per-tool counts in one pipeline pass rather than separate queries.
      const sessionIds = items.map((s: any) => s.id);

      const enrichDocs =
        sessionIds.length > 0
          ? await db
              .collection(COLLECTIONS.REQUESTS)
              .aggregate([
                { $match: { agentSessionId: { $in: sessionIds } } },
                {
                  $group: {
                    _id: "$agentSessionId",
                    totalCost: { $sum: { $ifNull: ["$estimatedCost", 0] } },
                    models: { $addToSet: "$model" },
                    providers: { $addToSet: "$provider" },
                    // Merge per-request modality flags into arrays of distinct true keys
                    modalityKeys: {
                      $addToSet: {
                        $reduce: {
                          input: {
                            $objectToArray: { $ifNull: ["$modalities", {}] },
                          },
                          initialValue: [],
                          in: {
                            $cond: [
                              { $eq: ["$$this.v", true] },
                              { $concatArrays: ["$$value", ["$$this.k"]] },
                              "$$value",
                            ],
                          },
                        },
                      },
                    },
                    // Flatten all toolApiNames for per-tool counting
                    allToolApiNames: {
                      $push: { $ifNull: ["$toolApiNames", []] },
                    },
                  },
                },
              ])
              .toArray()
          : [];

      // Build sessionId → enrichment map
      const enrichMap = new Map();
            for ( const document of enrichDocs) {
        // Unique non-null models and providers
        const models = document.models.filter(Boolean);
        const providers = document.providers.filter(Boolean);

        // Merge modality keys from all requests into a single flags object
        const mergedModalities: any = {};
                for ( const keySet of document.modalityKeys) {
                    for ( const k of keySet) mergedModalities[k] = true;
        }

        // Count per-tool occurrences
        const toolCounts: any = {};
                for ( const array of document.allToolApiNames) {
                    for ( const name of array) {
                        toolCounts[name] = (toolCounts[name] || 0) + 1;
          }
        }

        enrichMap.set(document._id, {
          totalCost: document.totalCost,
          models,
          providers,
          modalities: mergedModalities,
          toolCounts: Object.keys(toolCounts).length > 0 ? toolCounts : null,
        });
      }

      // Merge enriched data into each session
            for ( const session of items) {
        const enrichment = enrichMap.get(session.id);
        if (!enrichment) continue;

        session.toolCounts = enrichment.toolCounts;

        // Overlay request-log cost when it's higher than the document-level cost.
        // Request-log aggregation is authoritative for NEW sessions (includes background
        // costs like memory extraction). For OLD sessions with the cache-token NaN bug,
        // per-iteration request logs under-report cost — the document's message-level
        // totalCost (computed from overallUsage) is more accurate in that case.
        session.totalCost = Math.max(
          session.totalCost || 0,
          enrichment.totalCost,
        );

        // Authoritative models/providers from request logs — the document-level
        // fields may be stale or absent because they're only recomputed from messages.
        if (enrichment.models.length > 0)
          session.modelNames = enrichment.models;
        if (enrichment.providers.length > 0)
          session.providers = enrichment.providers;

        // Merge request-log modalities into the document-level modalities.
        // Request logs capture per-request modalities (e.g. imageOut from DALL-E,
        // thinking from Claude) that the document-level field may miss because
        // it's computed only from persisted messages.
        if (Object.keys(enrichment.modalities).length > 0) {
          session.modalities = {
            ...(session.modalities || {}),
            ...enrichment.modalities,
          };
        }
      }

      res.json({ items, nextCursor, hasMore });
    } catch (error: any) {
            logger.error(`Error fetching agent sessions: ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * GET /agent-sessions/:id
 * Get a specific agent session, including aggregated stats from request logs.
 */
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const { project, username, db } = req;
      const session = await db
        .collection(COLLECTION)
        .findOne({ id: req.params.id, project, username });

      if (!session) {
        return res.status(404).json({ error: "Agent session not found" });
      }

      // ── Aggregate stats from request logs (single source of truth) ──
      // Recursively discover all descendant session IDs (multi-level workers)
      const sessionId = req.params.id;
      const allSessionIds = new Set([sessionId]);
      let frontier = [sessionId];
      for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
        const childIds = await db
          .collection(COLLECTIONS.REQUESTS)
          .distinct("agentSessionId", {
            parentAgentSessionId: { $in: frontier },
            agentSessionId: { $nin: [...allSessionIds] },
          });
        if (childIds.length === 0) break;
        const newIds = childIds.filter(Boolean);
                for ( const id of newIds) allSessionIds.add(id);
        frontier = newIds;
      }

      const requests = await db
        .collection(COLLECTIONS.REQUESTS)
        .find({ agentSessionId: { $in: [...allSessionIds] } })
        .project({
          estimatedCost: 1,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 1,
          reasoningOutputTokens: 1,
          provider: 1,
          model: 1,
          operation: 1,
          timestamp: 1,
          modalities: 1,
          toolApiNames: 1,
          success: 1,
          agentSessionId: 1,
          parentAgentSessionId: 1,
          tokensPerSec: 1,
          generationTime: 1,
          timeToGeneration: 1,
        })
        .toArray();

      // ── Shared aggregation helper ───────────────────────────────
      const aggregateRequests = (reqs: any) => {
        if (reqs.length === 0) return null;
        const providers = new Set();
        const models = new Set();
        const operations = new Set();
        let totalCost = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheReadInputTokens = 0;
        let totalCacheCreationInputTokens = 0;
        let totalReasoningOutputTokens = 0;
        const mergedModalities: any = {};
        const toolCounts: any = {};
        // Collect per-request tok/s for generation-only average
        const tpsValues: any[] = [];
        const ttftValues: any[] = [];

                for ( const r of reqs) {
          totalCost += r.estimatedCost || 0;
          totalInputTokens += r.inputTokens || 0;
          totalOutputTokens += r.outputTokens || 0;
          totalCacheReadInputTokens += r.cacheReadInputTokens || 0;
          totalCacheCreationInputTokens += r.cacheCreationInputTokens || 0;
          totalReasoningOutputTokens += r.reasoningOutputTokens || 0;
          if (r.provider) providers.add(r.provider);
          if (r.model) models.add(r.model);
          if (r.operation) operations.add(r.operation);
          if (r.modalities) {
                        for ( const [k, v] of Object.entries(r.modalities)) {
                            if (v) mergedModalities[k] = true;
            }
          }
          if (r.toolApiNames?.length > 0) {
                        for ( const name of r.toolApiNames) {
                            toolCounts[name] = (toolCounts[name] || 0) + 1;
            }
          }
          // Per-request generation metrics (null-safe)
          if (r.tokensPerSec != null && r.tokensPerSec > 0) {
            tpsValues.push(r.tokensPerSec);
          }
          if (r.timeToGeneration != null && r.timeToGeneration > 0) {
            ttftValues.push(r.timeToGeneration);
          }
        }

                const earliest = (reqs as any).reduce(
                    (min: any, r: any) => (!min || (r as any).timestamp < min ? r.timestamp : min),
          null,
        );
                const latest = (reqs as any).reduce(
                    (max: any, r: any) => (!max || (r as any).timestamp > max ? r.timestamp : max),
          null,
        );
        const totalElapsedTime =
          earliest && latest
            ? Math.max(
                0,
                (new Date(latest).getTime() - new Date(earliest).getTime()) /
                  1000,
              )
            : 0;

        // Average tok/s across all requests — naturally handles concurrency
        // (each request measures its own generation speed) and excludes idle
        // time (only generation phases contribute measurements).
        const avgTokensPerSec =
          tpsValues.length > 0
                        ? tpsValues.reduce((a: any, b: any) => a + b, 0) / tpsValues.length
            : null;
        const avgTimeToGeneration =
          ttftValues.length > 0
                        ? ttftValues.reduce((a: any, b: any) => a + b, 0) /
              ttftValues.length
            : null;

        return {
          requestCount: reqs.length,
          totalCost,
          totalInputTokens,
          totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
          totalCacheReadInputTokens,
          totalCacheCreationInputTokens,
          totalReasoningOutputTokens,
          providers: [...providers],
          models: [...models],
          operations: [...operations],
          modalities: mergedModalities,
          toolCounts,
          totalElapsedTime,
          avgTokensPerSec,
          avgTimeToGeneration,
          createdAt: earliest,
          updatedAt: latest,
        };
      };

      // ── Split requests into orchestrator vs worker buckets ────
      const orchestratorRequests = requests.filter(
        (r: any) => r.agentSessionId === sessionId,
      );
      const workerRequests = requests.filter(
        (r: any) => r.agentSessionId !== sessionId,
      );

      let stats = null;
      if (requests.length > 0) {
        const allStats = aggregateRequests(requests);
                allStats.workerRequestCount = workerRequests.length;
        // Guard against old sessions where per-iteration request logs under-report
        // cost due to the NaN cache token bug — prefer the higher of request-log
        // aggregate vs document-level message cost.
                allStats.totalCost = Math.max(
                    allStats.totalCost,
          session.totalCost || 0,
        );
        stats = {
          ...allStats,
          orchestrator: aggregateRequests(orchestratorRequests),
          workers: aggregateRequests(workerRequests),
        };
      }

      res.json({ ...session, stats });
    } catch (error: any) {
            logger.error(`Error fetching agent session: ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * PATCH /agent-sessions/:id
 * Update specific fields of an agent session.
 */
router.patch(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const { project, username, db } = req;
      const setFields = buildConversationPatchFields(req.body);

      const result = await db
        .collection(COLLECTION)
        .updateOne(
          { id: req.params.id, project, username },
          { $set: setFields },
        );

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Agent session not found" });
      }

      const session = await db
        .collection(COLLECTION)
        .findOne({ id: req.params.id, project, username });

      res.json(session);
    } catch (error: any) {
            logger.error(`Error patching agent session: ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * DELETE /agent-sessions/:id
 * Delete a specific agent session.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
            const { project, username, db } = req;
      const result = await db
        .collection(COLLECTION)
        .deleteOne({ id: req.params.id, project, username });

      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Agent session not found" });
      }

      res.json({ success: true, id: req.params.id });
    } catch (error: any) {
            logger.error(`Error deleting agent session: ${(error as Error).message}`);
      next(error);
    }
  }),
);

export default router;
