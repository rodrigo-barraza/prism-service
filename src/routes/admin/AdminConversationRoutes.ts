import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { Document } from "mongodb";
import { COLLECTIONS, SSE_KEEPALIVE_INTERVAL_MS } from "../../constants.ts";
import ChangeStreamService from "../../services/ChangeStreamService.ts";
import BenchmarkService from "../../services/BenchmarkService.ts";
import ActiveGenerationTracker from "../../services/ActiveGenerationTracker.ts";
import AgentPersonaRegistry from "../../services/AgentPersonaRegistry.ts";
import ToolOrchestratorService from "../../services/ToolOrchestratorService.ts";
import logger from "../../utils/logger.ts";
import { getErrorMessage } from "../../utils/ErrorHelpers.ts";
import { applyDateRangeFilter, parsePaginationParams } from "../../utils/QueryBuilders.ts";
import requireDb from "../../middleware/RequireDbMiddleware.ts";
import { MS_PER_MINUTE, MS_PER_HOUR, minutes } from "@rodrigo-barraza/utilities-library";

const router = express.Router();
const {
  REQUESTS: REQUESTS_COL,
  MODEL_CONVERSATIONS: CONVERSATIONS_COL,
} = COLLECTIONS;

router.use(requireDb);

// ─── GET /conversations — cross-project conversation list ─
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        project,
        username,
        search,
        provider,
        model,
        trace,
        from,
        to,
        sort = "updatedAt",
        order = "desc",
        agent,
        type,
      } = req.query;

      const { skip, limit, sortDirection } = parsePaginationParams(req.query);

      const filter: Record<string, unknown> = {};
      if (trace) filter.traceId = trace;
      if (project) filter.project = project;
      if (username) filter.username = username;

      if (search) {
        const regex = { $regex: search, $options: "i" };
        const orClauses: Record<string, unknown>[] = [
          { title: regex },
          { project: regex },
          { username: regex },
        ];

        if (/^[\d.:a-f]+$/i.test((search as string).trim())) {
          const matchingConvIds = await req.db
            .collection(REQUESTS_COL)
            .distinct("conversationId", { clientIp: regex });
          if (matchingConvIds.length > 0) {
            orClauses.push({ id: { $in: matchingConvIds } });
          }
        }
        filter.$or = orClauses;
      }

      if (provider) filter.providers = provider;
      if (model) filter["messages.model"] = model;
      applyDateRangeFilter(filter, from as string, to as string, "updatedAt");

      const sortDir = sortDirection;

      const isDirectOnly = type === "direct" || agent === "NONE";
      const isAgentOnly = agent && agent !== "NONE" && agent !== "ALL";

      const shouldFetchConvs = !isAgentOnly;
      const shouldFetchSessions = !isDirectOnly;

      const agentFilter = { ...filter };
      if (isAgentOnly) {
        agentFilter.agent = agent;
      }

      let convs: Document[] = [];
      let sessions: Document[] = [];

      const queryPromises: Promise<void>[] = [];

      if (shouldFetchConvs) {
        queryPromises.push(
          req.db
            .collection(CONVERSATIONS_COL)
            .find(filter)
            .project({
              id: 1,
              project: 1,
              username: 1,
              title: 1,
              createdAt: 1,
              updatedAt: 1,
              modalities: 1,
              providers: 1,
              messageCount: { $size: { $ifNull: ["$messages", []] } },
              totalCost: { $ifNull: ["$totalCost", 0] },
            })
            .sort({ [sort as string]: sortDir })
            .limit(skip + limit)
            .toArray()
            .then((result) => {
              convs = result;
            })
        );
      }

      if (shouldFetchSessions) {
        queryPromises.push(
          req.db
            .collection(COLLECTIONS.AGENT_CONVERSATIONS)
            .find(agentFilter)
            .project({
              id: 1,
              project: 1,
              username: 1,
              title: 1,
              createdAt: 1,
              updatedAt: 1,
              modalities: 1,
              providers: 1,
              messageCount: { $size: { $ifNull: ["$messages", []] } },
              totalCost: { $ifNull: ["$totalCost", 0] },
              agent: 1,
            })
            .sort({ [sort as string]: sortDir })
            .limit(skip + limit)
            .toArray()
            .then((result) => {
              sessions = result;
            })
        );
      }

      await Promise.all(queryPromises);

      let totalConvs = 0;
      let totalSessions = 0;
      const countPromises: Promise<void>[] = [];

      if (shouldFetchConvs) {
        countPromises.push(
          req.db
            .collection(CONVERSATIONS_COL)
            .countDocuments(filter)
            .then((result) => {
              totalConvs = result;
            })
        );
      }

      if (shouldFetchSessions) {
        countPromises.push(
          req.db
            .collection(COLLECTIONS.AGENT_CONVERSATIONS)
            .countDocuments(agentFilter)
            .then((result) => {
              totalSessions = result;
            })
        );
      }

      await Promise.all(countPromises);

      const merged = [
        ...convs.map((item) => ({ ...item, type: "direct" as const })),
        ...sessions.map((session) => ({ ...session, type: "agent" as const })),
      ].sort((firstItem, secondItem) => {
        const valueA = String((firstItem as Record<string, unknown>)[sort as string] ?? "");
        const valueB = String((secondItem as Record<string, unknown>)[sort as string] ?? "");
        if (valueA < valueB) return -sortDir;
        if (valueA > valueB) return sortDir;
        return 0;
      });

      const paginatedDocuments = merged.slice(skip, skip + limit);

      const paginatedDocumentIds = paginatedDocuments.map((document) => (document as Document).id);
      const agentSessionIds = paginatedDocuments
        .filter((document) => document.type === "agent")
        .map((document) => (document as Record<string, unknown>).id as string)
        .filter(Boolean);

      const requests = await req.db
        .collection(REQUESTS_COL)
        .find({
          $or: [
            { conversationId: { $in: paginatedDocumentIds } },
            { agentSessionId: { $in: agentSessionIds } },
            { parentAgentSessionId: { $in: agentSessionIds } },
          ],
        })
        .project({
          conversationId: 1,
          agentSessionId: 1,
          parentAgentSessionId: 1,
          inputTokens: 1,
          outputTokens: 1,
          model: 1,
          tokensPerSec: 1,
          totalTime: 1,
          toolDisplayNames: 1,
          toolApiNames: 1,
          estimatedCost: 1,
        })
        .toArray();

      const requestLogMap = new Map<string, Document[]>();
      for (const requestItem of requests) {
        let targetId = "";
        if (
          requestItem.parentAgentSessionId &&
          agentSessionIds.includes(requestItem.parentAgentSessionId)
        ) {
          targetId = requestItem.parentAgentSessionId;
        } else if (
          requestItem.agentSessionId &&
          agentSessionIds.includes(requestItem.agentSessionId)
        ) {
          targetId = requestItem.agentSessionId;
        } else if (requestItem.conversationId) {
          targetId = requestItem.conversationId;
        }

        if (targetId) {
          if (!requestLogMap.has(targetId)) {
            requestLogMap.set(targetId, []);
          }
          requestLogMap.get(targetId)!.push(requestItem);
        }
      }

      const enrichedDocuments = paginatedDocuments.map((document: Record<string, unknown>) => {
        const associatedRequests = requestLogMap.get(document.id as string) || ([] as Document[]);
        const models = Array.from(
          new Set(associatedRequests.map((requestItem: Document) => requestItem.model).filter(Boolean))
        );
        const toolDisplayNames = Array.from(
          new Set(
            associatedRequests
              .flatMap((requestItem: Document) => (requestItem.toolDisplayNames as string[]) || [])
              .filter(Boolean)
          )
        );
        const toolApiNames = Array.from(
          new Set(
            associatedRequests
              .flatMap((requestItem: Document) => (requestItem.toolApiNames as string[]) || [])
              .filter(Boolean)
          )
        );

        let inputTokens = 0;
        let outputTokens = 0;
        let totalLatency = 0;
        let tokensPerSecondSum = 0;
        let tokensPerSecondCount = 0;
        let aggregatedCost = 0;

        for (const requestItem of associatedRequests) {
          inputTokens += requestItem.inputTokens || 0;
          outputTokens += requestItem.outputTokens || 0;
          totalLatency += requestItem.totalTime || 0;
          aggregatedCost += requestItem.estimatedCost || 0;
          if (requestItem.tokensPerSec && requestItem.tokensPerSec > 0) {
            tokensPerSecondSum += requestItem.tokensPerSec;
            tokensPerSecondCount++;
          }
        }

        // Apply cost overlay for agent sessions
        const originalCost = (document.totalCost as number) || 0;
        const totalCost =
          document.type === "agent" && aggregatedCost > 0
            ? Math.max(originalCost, aggregatedCost)
            : originalCost;

        return {
          ...document,
          totalCost,
          requestCount: associatedRequests.length,
          inputTokens,
          outputTokens,
          models,
          toolDisplayNames,
          toolApiNames,
          avgTokensPerSec: tokensPerSecondCount > 0 ? tokensPerSecondSum / tokensPerSecondCount : null,
          totalLatency,
        };
      });

      res.json({
        data: enrichedDocuments,
        total: totalConvs + totalSessions,
        page: parsePaginationParams(req.query).page,
        limit,
      });
    } catch (error: unknown) {
      logger.error("Admin /conversations error: " + getErrorMessage(error));
      next(error);
    }
  }),
);

// ─── GET /conversations/filters — distinct filter values for admin dropdowns ─
router.get(
  "/filters",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const [convProjects, reqProjects, usernames, models, providers] = await Promise.all([
        req.db.collection(CONVERSATIONS_COL).distinct("project"),
        req.db.collection(REQUESTS_COL).distinct("project"),
        req.db.collection(CONVERSATIONS_COL).distinct("username"),
        req.db.collection(REQUESTS_COL).distinct("model"),
        req.db.collection(REQUESTS_COL).distinct("provider"),
      ]);

      const projects = [...new Set([...convProjects, ...reqProjects])];
      const workspaceRoots = ToolOrchestratorService.getWorkspaceRoots() as string[];
      const agentPersonas = AgentPersonaRegistry.list().map((persona) => ({
        id: persona.id,
        name: persona.name,
      }));

      res.json({
        projects: projects.filter(Boolean).sort(),
        usernames: usernames.filter(Boolean).sort(),
        models: models.filter(Boolean).sort(),
        providers: providers.filter(Boolean).sort(),
        workspaces: workspaceRoots.filter(Boolean).sort(),
        agents: agentPersonas,
      });
    } catch (error: unknown) {
      logger.error(`Admin /conversations/filters error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /conversations/stats — quick stats snapshot ──
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = req.query.project || null;
      const filter = project ? { project } : {};
      const oneHourAgo = new Date(Date.now() - MS_PER_HOUR).toISOString();
      const fiveMinAgo = new Date(Date.now() - minutes(5)).toISOString();

      const [generatingCount, recentCount] = await Promise.all([
        req.db.collection(CONVERSATIONS_COL).countDocuments({
          ...filter,
          isGenerating: true,
          updatedAt: { $gte: fiveMinAgo },
        }),
        req.db
          .collection(CONVERSATIONS_COL)
          .countDocuments({ ...filter, updatedAt: { $gte: oneHourAgo } }),
      ]);

      res.json({
        generatingCount:
          generatingCount +
          BenchmarkService.activeGenerationCount +
          ActiveGenerationTracker.count,
        recentCount,
      });
    } catch (error: unknown) {
      logger.error(`Admin /conversations/stats error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

// ─── GET /conversations/stream — SSE for real-time stats ─
router.get(
  "/stream",
  asyncHandler(async (req: Request, res: Response) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("\n");

    const project = req.query.project || null;
    let lastPayload = "";

    const sendStats = async () => {
      try {
        const filter = project ? { project } : {};
        const oneHourAgo = new Date(Date.now() - MS_PER_HOUR).toISOString();
        const fiveMinAgo = new Date(Date.now() - minutes(5)).toISOString();

        const [generatingCount, recentCount] = await Promise.all([
          req.db.collection(CONVERSATIONS_COL).countDocuments({
            ...filter,
            isGenerating: true,
            updatedAt: { $gte: fiveMinAgo },
          }),
          req.db
            .collection(CONVERSATIONS_COL)
            .countDocuments({ ...filter, updatedAt: { $gte: oneHourAgo } }),
        ]);

        req.db.collection(CONVERSATIONS_COL)
          .updateMany(
            { isGenerating: true, updatedAt: { $lt: fiveMinAgo } },
            { $set: { isGenerating: false } },
          )
          .then(({ modifiedCount }: { modifiedCount: number }) => {
            if (modifiedCount > 0)
              logger.info(
                `Auto-cleared ${modifiedCount} stale isGenerating flag(s)`,
              );
          })
          .catch(() => {});

        const payload = JSON.stringify({
          generatingCount:
            generatingCount +
            BenchmarkService.activeGenerationCount +
            ActiveGenerationTracker.count,
          recentCount,
        });
        if (payload !== lastPayload) {
          lastPayload = payload;
          res.write(`data: ${payload}\n\n`);
        }
      } catch (error: unknown) {
        logger.error(`SSE conversations/stream error: ${getErrorMessage(error)}`);
      }
    };

    await sendStats();

    if (ChangeStreamService.available) {
      const onEvent = (event: import("../../services/ChangeStreamService.ts").ChangeStreamEventPayload) => {
        if (event.collection === CONVERSATIONS_COL || event.collection === COLLECTIONS.AGENT_CONVERSATIONS) {
          sendStats();
        }
      };
      ChangeStreamService.subscribe(onEvent);

      let previousNonConversationCount = 0;
      const generationPoll = setInterval(() => {
        const count =
          BenchmarkService.activeGenerationCount +
          ActiveGenerationTracker.count;
        if (count > 0 || previousNonConversationCount > 0) sendStats();
        previousNonConversationCount = count;
      }, 1000);

      const keepAlive = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {
          /* ignore */
        }
      }, SSE_KEEPALIVE_INTERVAL_MS);

      req.on("close", () => {
        ChangeStreamService.unsubscribe(onEvent);
        clearInterval(generationPoll);
        clearInterval(keepAlive);
      });
    } else {
      const interval = setInterval(sendStats, 2000);
      const keepAlive = setInterval(() => {
        res.write(": ping\n\n");
      }, SSE_KEEPALIVE_INTERVAL_MS);

      req.on("close", () => {
        clearInterval(interval);
        clearInterval(keepAlive);
      });
    }
  }),
);

// ─── GET /conversations/:id — single conversation, full msgs ─
router.get(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      let conversationDocument = await req.db
        .collection(CONVERSATIONS_COL)
        .findOne({ id: req.params.id });
      if (conversationDocument) {
        return res.json({ ...conversationDocument, type: "direct" });
      }

      conversationDocument = await req.db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .findOne({ id: req.params.id });
      if (conversationDocument) {
        return res.json({ ...conversationDocument, type: "agent" });
      }

      res.status(404).json({ error: "Conversation not found" });
    } catch (error: unknown) {
      logger.error(`Admin /conversations/:id error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

export default router;

