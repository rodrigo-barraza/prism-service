// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import MongoWrapper from "../wrappers/MongoWrapper.js";
// @ts-ignore
import { MONGO_DB_NAME } from "../../config.js";
import { getProvider } from "../providers/index.js";
import ChangeStreamService from "../services/ChangeStreamService.js";
import BenchmarkService from "../services/BenchmarkService.js";
import ActiveGenerationTracker from "../services/ActiveGenerationTracker.js";
import logger from "../utils/logger.js";
import { resolveArchParams, estimateMemory } from "../utils/gguf-arch.js";
import { COLLECTIONS, COST_SUM_EXPR, TOTAL_TOKENS_EXPR, AVG_TOKENS_PER_SEC_EXPR, SSE_KEEPALIVE_INTERVAL_MS, } from "../constants.js";
import AgentPersonaRegistry from "../services/AgentPersonaRegistry.js";
import ToolOrchestratorService from "../services/ToolOrchestratorService.js";
// @ts-ignore
import { MS_PER_MINUTE, MS_PER_HOUR, hours as hoursToMs, minutes,
// @ts-ignore
 } from "@rodrigo-barraza/utilities-library";
import os from "os";
const router = express.Router();
const { REQUESTS: REQUESTS_COL, CONVERSATIONS: CONVERSATIONS_COL, WORKFLOWS: WORKFLOWS_COL, } = COLLECTIONS;
// ─── GET /admin/requests — paginated, filtered request logs ─
router.get("/requests", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { page = 1, limit = 50, project, username, provider, model, endpoint, operation, success, from, to, sort = "timestamp", order = "desc", } = req.query;
        const filter = {};
        // @ts-ignore
        if (project)
            filter.project = project;
        // @ts-ignore
        if (username)
            filter.username = username;
        // @ts-ignore
        if (provider)
            filter.provider = provider;
        // @ts-ignore
        if (model)
            filter.model = model;
        // @ts-ignore
        if (endpoint)
            filter.endpoint = endpoint;
        // @ts-ignore
        if (operation)
            filter.operation = operation;
        // @ts-ignore
        if (success !== undefined)
            filter.success = success === "true";
        if (from || to) {
            // @ts-ignore
            filter.timestamp = {};
            // @ts-ignore
            if (from)
                filter.timestamp.$gte = from;
            // @ts-ignore
            if (to)
                filter.timestamp.$lte = to;
        }
        // @ts-ignore - TODO: strict typing
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        // @ts-ignore - TODO: strict typing
        const lim = parseInt(limit, 10);
        const sortDir = order === "asc" ? 1 : -1;
        const [docs, total] = await Promise.all([
            db
                .collection(REQUESTS_COL)
                .find(filter, {
                projection: { requestPayload: 0, responsePayload: 0 },
            })
                // @ts-ignore - TODO: strict typing
                .sort({ [sort]: sortDir })
                .skip(skip)
                .limit(lim)
                .toArray(),
            db.collection(REQUESTS_COL).countDocuments(filter),
        ]);
        // @ts-ignore - TODO: strict typing
        res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /requests error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/requests/:id — single request detail ────────
router.get("/requests/:id", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const document = await db
            .collection(REQUESTS_COL)
            .findOne({ requestId: req.params.id });
        if (!document)
            return res.status(404).json({ error: "Request not found" });
        res.json(document);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /requests/:id error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/requests/:id/associations — conversations, workflows & traces ─
router.get("/requests/:id/associations", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const request = await db
            .collection(REQUESTS_COL)
            .findOne({ requestId: req.params.id });
        if (!request)
            return res.status(404).json({ error: "Request not found" });
        let conversations = [];
        let workflows = [];
        let traces = [];
        if (request.conversationId) {
            // Find conversations matching this conversationId
            conversations = await db
                .collection(CONVERSATIONS_COL)
                .find({ id: request.conversationId })
                .project({
                id: 1,
                title: 1,
                project: 1,
                traceId: 1,
                model: 1,
                totalCost: 1,
                modalities: 1,
                providers: 1,
                updatedAt: 1,
                createdAt: 1,
                username: 1,
            })
                .toArray();
            // Find workflows that contain this conversationId
            workflows = await db
                .collection(WORKFLOWS_COL)
                .find({ conversationIds: request.conversationId })
                .project({ _id: 1, name: 1, nodeCount: 1, edgeCount: 1, source: 1 })
                .toArray();
            // Normalize _id to string id
            workflows = workflows.map((w) => ({
                // @ts-ignore - TODO: strict typing
                id: w._id.toString(),
                name: w.name || "Untitled Workflow",
                nodeCount: w.nodeCount || 0,
                edgeCount: w.edgeCount || 0,
                source: w.source || "prism-client",
            }));
            // Derive traces from requests — traces are no longer a collection
            const traceIds = new Set();
            // @ts-ignore
            for (const c of conversations) {
                if (c.traceId)
                    traceIds.add(c.traceId);
            }
            if (traceIds.size > 0) {
                // Count requests per traceId to build trace summary
                const traceAgg = await db
                    .collection(REQUESTS_COL)
                    .aggregate([
                    { $match: { traceId: { $in: [...traceIds] } } },
                    {
                        $group: {
                            _id: "$traceId",
                            requestCount: { $sum: 1 },
                            project: { $first: "$project" },
                            username: { $first: "$username" },
                            createdAt: { $min: "$timestamp" },
                            updatedAt: { $max: "$timestamp" },
                        },
                    },
                ])
                    .toArray();
                traces = traceAgg.map((s) => ({
                    id: s._id,
                    project: s.project,
                    username: s.username,
                    requestCount: s.requestCount,
                    createdAt: s.createdAt,
                    updatedAt: s.updatedAt,
                }));
            }
        }
        res.json({ conversations, workflows, traces });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /requests/:id/associations error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/stats — aggregate stats ─────────────────────
router.get("/stats", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { from, to, project } = req.query;
        const match = {};
        // @ts-ignore
        if (project)
            match.project = project;
        if (from || to) {
            // @ts-ignore
            match.timestamp = {};
            // @ts-ignore
            if (from)
                match.timestamp.$gte = from;
            // @ts-ignore
            if (to)
                match.timestamp.$lte = to;
        }
        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: null,
                    totalRequests: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR,
                    totalDuration: { $sum: { $ifNull: ["$totalTime", 0] } },
                    successCount: {
                        $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                    errorCount: {
                        $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
                    },
                },
            },
        ];
        // Tool call count: sum the lengths of toolApiNames arrays across all matching requests
        const toolCallPipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            { $match: { toolApiNames: { $exists: true, $ne: [] } } },
            { $unwind: "$toolApiNames" },
            { $count: "total" },
        ];
        // Count total traces and conversations (respecting date + project filters)
        const convMatch = {};
        // @ts-ignore
        if (project)
            convMatch.project = project;
        if (from || to) {
            // @ts-ignore
            convMatch.createdAt = {};
            // @ts-ignore
            if (from)
                convMatch.createdAt.$gte = from;
            // @ts-ignore
            if (to)
                convMatch.createdAt.$lte = to;
        }
        // Traces: count distinct traceIds from requests that match filters
        const traceMatch = { traceId: { $ne: null } };
        // @ts-ignore
        if (project)
            traceMatch.project = project;
        if (from || to) {
            // @ts-ignore
            traceMatch.timestamp = {};
            // @ts-ignore
            if (from)
                traceMatch.timestamp.$gte = from;
            // @ts-ignore
            if (to)
                traceMatch.timestamp.$lte = to;
        }
        const traceCountPipeline = [
            { $match: traceMatch },
            { $group: { _id: "$traceId" } },
            { $count: "total" },
        ];
        // Count agents: the registry includes both built-in and custom agents loaded at startup
        const agentCount = AgentPersonaRegistry.list().length;
        const workspaceCount = ToolOrchestratorService.getWorkspaceRoots().length;
        const [result, toolCallResult, traceResult, conversationCount] = await Promise.all([
            db
                .collection(REQUESTS_COL)
                .aggregate(pipeline)
                .toArray()
                // @ts-ignore - TODO: strict typing
                .then((r) => r[0]),
            db.collection(REQUESTS_COL).aggregate(toolCallPipeline).toArray(),
            db.collection(REQUESTS_COL).aggregate(traceCountPipeline).toArray(),
            db.collection(CONVERSATIONS_COL).countDocuments(convMatch),
        ]);
        const traceCount = traceResult[0]?.total || 0;
        const totalToolCalls = toolCallResult[0]?.total || 0;
        res.json({
            totalRequests: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCost: 0,
            avgLatency: 0,
            avgTokensPerSec: 0,
            totalDuration: 0,
            successCount: 0,
            errorCount: 0,
            // @ts-ignore - TODO: strict typing
            ...result,
            traceCount,
            conversationCount,
            totalToolCalls,
            agentCount,
            workspaceCount,
        });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /stats error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/stats/projects — per-project breakdown ──────
router.get("/stats/projects", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { from, to, project } = req.query;
        const match = {};
        // @ts-ignore
        if (project)
            match.project = project;
        if (from || to) {
            // @ts-ignore
            match.timestamp = {};
            // @ts-ignore
            if (from)
                match.timestamp.$gte = from;
            // @ts-ignore
            if (to)
                match.timestamp.$lte = to;
        }
        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: "$project",
                    totalRequests: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalTokens: TOTAL_TOKENS_EXPR,
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR,
                    lastRequest: { $max: "$timestamp" },
                    _models: { $addToSet: "$model" },
                    _providers: { $addToSet: "$provider" },
                },
            },
            {
                $addFields: {
                    modelCount: { $size: "$_models" },
                    providerCount: { $size: "$_providers" },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];
        // Count workflows per project via conversationIds → conversations.project
        const workflowPipeline = [
            { $match: { conversationIds: { $exists: true, $ne: [] } } },
            {
                $lookup: {
                    from: CONVERSATIONS_COL,
                    localField: "conversationIds",
                    foreignField: "id",
                    as: "_convs",
                    pipeline: [{ $project: { project: 1 } }],
                },
            },
            { $unwind: "$_convs" },
            {
                $group: {
                    _id: "$_convs.project",
                    workflowIds: { $addToSet: "$_id" },
                },
            },
            { $project: { _id: 1, workflowCount: { $size: "$workflowIds" } } },
        ];
        // Count conversations per project
        const convPipeline = [
            { $group: { _id: "$project", conversationCount: { $sum: 1 } } },
        ];
        // Count traces per project — derived from requests
        const tracePipeline = [
            { $match: { traceId: { $ne: null } } },
            { $group: { _id: { project: "$project", traceId: "$traceId" } } },
            { $group: { _id: "$_id.project", traceCount: { $sum: 1 } } },
        ];
        const [results, workflowCounts, convCounts, traceCounts] = await Promise.all([
            db.collection(REQUESTS_COL).aggregate(pipeline).toArray(),
            db.collection(WORKFLOWS_COL).aggregate(workflowPipeline).toArray(),
            db.collection(CONVERSATIONS_COL).aggregate(convPipeline).toArray(),
            db.collection(REQUESTS_COL).aggregate(tracePipeline).toArray(),
        ]);
        // Build a project → workflowCount map
        const wfMap = {};
        // @ts-ignore
        for (const wc of workflowCounts) {
            // @ts-ignore
            wfMap[wc._id || "unknown"] = wc.workflowCount;
        }
        // Build a project → conversationCount map
        const convMap = {};
        // @ts-ignore
        for (const cc of convCounts) {
            // @ts-ignore
            convMap[cc._id || "unknown"] = cc.conversationCount;
        }
        // Build a project → traceCount map
        const traceMap = {};
        // @ts-ignore
        for (const tc of traceCounts) {
            // @ts-ignore
            traceMap[tc._id || "unknown"] = tc.traceCount;
        }
        res.json(results.map((r) => ({
            project: r._id || "unknown",
            totalRequests: r.totalRequests,
            totalInputTokens: r.totalInputTokens,
            totalOutputTokens: r.totalOutputTokens,
            totalTokens: r.totalTokens,
            totalCost: r.totalCost,
            avgLatency: r.avgLatency,
            avgTokensPerSec: r.avgTokensPerSec,
            lastRequest: r.lastRequest,
            modelCount: r.modelCount,
            providerCount: r.providerCount,
            // @ts-ignore - TODO: strict typing
            models: (r._models || []).filter(Boolean),
            // @ts-ignore - TODO: strict typing
            providers: (r._providers || []).filter(Boolean),
            // @ts-ignore
            workflowCount: wfMap[r._id || "unknown"] || 0,
            // @ts-ignore
            conversationCount: convMap[r._id || "unknown"] || 0,
            // @ts-ignore
            traceCount: traceMap[r._id || "unknown"] || 0,
        })));
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /stats/projects error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/stats/users — per-user breakdown ────────────
router.get("/stats/users", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const pipeline = [
            {
                $group: {
                    _id: "$username",
                    totalRequests: { $sum: 1 },
                    totalTokens: TOTAL_TOKENS_EXPR,
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    lastRequest: { $max: "$timestamp" },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];
        const results = await db
            .collection(REQUESTS_COL)
            .aggregate(pipeline)
            .toArray();
        res.json(results.map((r) => ({
            username: r._id || "unknown",
            totalRequests: r.totalRequests,
            totalTokens: r.totalTokens,
            totalCost: r.totalCost,
            avgLatency: r.avgLatency,
            lastRequest: r.lastRequest,
        })));
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /stats/users error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/stats/models — per-model breakdown ──────────
router.get("/stats/models", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { from, to, project } = req.query;
        const match = {};
        // @ts-ignore
        if (project)
            match.project = project;
        if (from || to) {
            // @ts-ignore
            match.timestamp = {};
            // @ts-ignore
            if (from)
                match.timestamp.$gte = from;
            // @ts-ignore
            if (to)
                match.timestamp.$lte = to;
        }
        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: { model: "$model", provider: "$provider" },
                    totalRequests: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalTokens: TOTAL_TOKENS_EXPR,
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR,
                    _convIds: { $addToSet: "$conversationId" },
                    toolsUsed: {
                        $max: { $cond: [{ $eq: ["$toolsUsed", true] }, true, false] },
                    },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];
        const results = await db
            .collection(REQUESTS_COL)
            .aggregate(pipeline)
            .toArray();
        // Collect all distinct conversationIds to look up workflow links
        const allConvIds = new Set();
        // @ts-ignore
        for (const r of results) {
            // @ts-ignore
            for (const cid of r._convIds || []) {
                if (cid)
                    allConvIds.add(cid);
            }
        }
        // Count workflows per conversationId
        const wfByConv = {};
        if (allConvIds.size > 0) {
            const wfResults = await db
                .collection(WORKFLOWS_COL)
                .aggregate([
                {
                    $match: {
                        conversationIds: { $elemMatch: { $in: [...allConvIds] } },
                    },
                },
                { $unwind: "$conversationIds" },
                { $match: { conversationIds: { $in: [...allConvIds] } } },
                {
                    $group: { _id: "$conversationIds", wfIds: { $addToSet: "$_id" } },
                },
                { $project: { _id: 1, workflowCount: { $size: "$wfIds" } } },
            ])
                .toArray();
            // @ts-ignore
            for (const w of wfResults) {
                // @ts-ignore
                wfByConv[w._id] = w.workflowCount;
            }
        }
        // Map conversationId → traceId for trace counting
        const traceByConv = {};
        if (allConvIds.size > 0) {
            const convDocs = await db
                .collection(CONVERSATIONS_COL)
                .find({
                id: { $in: [...allConvIds] },
                traceId: { $exists: true, $ne: null },
            })
                .project({ id: 1, traceId: 1 })
                .toArray();
            // @ts-ignore
            for (const c of convDocs) {
                // @ts-ignore
                traceByConv[c.id] = c.traceId;
            }
        }
        res.json(results.map((r) => {
            // @ts-ignore - TODO: strict typing
            const convIds = (r._convIds || []).filter(Boolean);
            const conversationCount = convIds.length;
            let workflowCount = 0;
            const traceSet = new Set();
            // @ts-ignore
            for (const cid of convIds) {
                // @ts-ignore
                workflowCount += wfByConv[cid] || 0;
                // @ts-ignore
                if (traceByConv[cid])
                    traceSet.add(traceByConv[cid]);
            }
            return {
                // @ts-ignore - TODO: strict typing
                model: r._id.model,
                // @ts-ignore - TODO: strict typing
                provider: r._id.provider,
                totalRequests: r.totalRequests,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalTokens: r.totalTokens,
                totalCost: r.totalCost,
                avgLatency: r.avgLatency,
                avgTokensPerSec: r.avgTokensPerSec,
                toolsUsed: r.toolsUsed || false,
                conversationCount,
                workflowCount,
                traceCount: traceSet.size,
            };
        }));
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /stats/models error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/stats/tools — per-tool lifetime usage breakdown ─
router.get("/stats/tools", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { from, to, project, tool } = req.query;
        const match = { toolApiNames: { $exists: true, $ne: [] } };
        // @ts-ignore
        if (project)
            match.project = project;
        if (from || to) {
            // @ts-ignore
            match.timestamp = {};
            // @ts-ignore
            if (from)
                match.timestamp.$gte = from;
            // @ts-ignore
            if (to)
                match.timestamp.$lte = to;
        }
        const pipeline = [
            { $match: match },
            { $unwind: "$toolApiNames" },
            // Optional: filter to a single tool
            ...(tool ? [{ $match: { toolApiNames: tool } }] : []),
            {
                $group: {
                    _id: "$toolApiNames",
                    totalCalls: { $sum: 1 },
                    totalRequests: { $addToSet: "$requestId" },
                    totalCost: COST_SUM_EXPR,
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    firstUsed: { $min: "$timestamp" },
                    lastUsed: { $max: "$timestamp" },
                    _models: { $push: "$model" },
                    _agents: { $push: "$agent" },
                    _providers: { $addToSet: "$provider" },
                    successCount: {
                        $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                    failureCount: {
                        $sum: { $cond: [{ $eq: ["$success", false] }, 1, 0] },
                    },
                },
            },
            {
                $addFields: {
                    totalRequests: { $size: "$totalRequests" },
                },
            },
            { $sort: { totalCalls: -1 } },
        ];
        const results = await db
            .collection(REQUESTS_COL)
            .aggregate(pipeline)
            .toArray();
        res.json(results.map((r) => {
            // Count top models
            const modelCounts = {};
            // @ts-ignore
            for (const m of r._models || []) {
                // @ts-ignore
                if (m)
                    modelCounts[m] = (modelCounts[m] || 0) + 1;
            }
            const topModels = Object.entries(modelCounts)
                // @ts-ignore - TODO: strict typing
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                // @ts-ignore - TODO: strict typing
                .map(([model, count]) => ({ model, count }));
            // Count top agents
            const agentCounts = {};
            // @ts-ignore
            for (const a of r._agents || []) {
                // @ts-ignore
                if (a)
                    agentCounts[a] = (agentCounts[a] || 0) + 1;
            }
            const topAgents = Object.entries(agentCounts)
                // @ts-ignore - TODO: strict typing
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                // @ts-ignore - TODO: strict typing
                .map(([agent, count]) => ({ agent, count }));
            return {
                tool: r._id,
                totalCalls: r.totalCalls,
                totalRequests: r.totalRequests,
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                avgLatency: r.avgLatency,
                firstUsed: r.firstUsed,
                lastUsed: r.lastUsed,
                // @ts-ignore - TODO: strict typing
                providers: r._providers?.filter(Boolean) || [],
                topModels,
                topAgents,
                successCount: r.successCount,
                failureCount: r.failureCount,
            };
        }));
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /stats/tools error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/stats/endpoints — per-endpoint breakdown ────
router.get("/stats/endpoints", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { from, to } = req.query;
        const match = {};
        if (from || to) {
            // @ts-ignore
            match.timestamp = {};
            // @ts-ignore
            if (from)
                match.timestamp.$gte = from;
            // @ts-ignore
            if (to)
                match.timestamp.$lte = to;
        }
        const pipeline = [
            ...(Object.keys(match).length ? [{ $match: match }] : []),
            {
                $group: {
                    _id: "$endpoint",
                    totalRequests: { $sum: 1 },
                    totalTokens: TOTAL_TOKENS_EXPR,
                    totalCost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", 0] } },
                    successRate: {
                        $avg: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                },
            },
            { $sort: { totalRequests: -1 } },
        ];
        const results = await db
            .collection(REQUESTS_COL)
            .aggregate(pipeline)
            .toArray();
        res.json(results.map((r) => ({
            endpoint: r._id || "unknown",
            totalRequests: r.totalRequests,
            totalTokens: r.totalTokens,
            totalCost: r.totalCost,
            avgLatency: r.avgLatency,
            successRate: r.successRate,
        })));
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /stats/endpoints error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/stats/costs — comprehensive cost breakdown ──
router.get("/stats/costs", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { from, to } = req.query;
        const match = {};
        if (from || to) {
            // @ts-ignore
            match.timestamp = {};
            // @ts-ignore
            if (from)
                match.timestamp.$gte = from;
            // @ts-ignore
            if (to)
                match.timestamp.$lte = to;
        }
        const matchStage = Object.keys(match).length ? [{ $match: match }] : [];
        // Shared $group accumulators — reused across all facets
        const groupFields = {
            totalCost: COST_SUM_EXPR,
            totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
            totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
            totalRequests: { $sum: 1 },
            avgTokensPerSec: AVG_TOKENS_PER_SEC_EXPR,
        };
        // Single $facet pipeline — scans the collection once instead of 8 times
        const [result] = await db
            .collection(REQUESTS_COL)
            .aggregate([
            ...matchStage,
            {
                $facet: {
                    totals: [{ $group: { _id: null, ...groupFields } }],
                    byProject: [
                        { $group: { _id: "$project", ...groupFields } },
                        { $sort: { totalCost: -1 } },
                    ],
                    byProvider: [
                        { $group: { _id: "$provider", ...groupFields } },
                        { $sort: { totalCost: -1 } },
                    ],
                    byModel: [
                        {
                            $group: {
                                _id: { model: "$model", provider: "$provider" },
                                ...groupFields,
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ],
                    byEndpoint: [
                        { $group: { _id: "$endpoint", ...groupFields } },
                        { $sort: { totalCost: -1 } },
                    ],
                    byProjectProvider: [
                        {
                            $group: {
                                _id: { project: "$project", provider: "$provider" },
                                ...groupFields,
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ],
                    byProjectEndpoint: [
                        {
                            $group: {
                                _id: { project: "$project", endpoint: "$endpoint" },
                                ...groupFields,
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ],
                    byProjectModel: [
                        {
                            $group: {
                                _id: {
                                    project: "$project",
                                    model: "$model",
                                    provider: "$provider",
                                },
                                ...groupFields,
                            },
                        },
                        { $sort: { totalCost: -1 } },
                    ],
                },
            },
        ])
            .toArray();
        const { totals, byProject, byProvider, byModel, byEndpoint, byProjectProvider, byProjectEndpoint, byProjectModel, } = result;
        // Nest provider breakdown under each project
        const providersByProject = {};
        // @ts-ignore
        for (const row of byProjectProvider) {
            const proj = row._id.project || "unknown";
            // @ts-ignore
            if (!providersByProject[proj])
                providersByProject[proj] = [];
            // @ts-ignore
            providersByProject[proj].push({
                provider: row._id.provider || "unknown",
                totalCost: row.totalCost,
                totalInputTokens: row.totalInputTokens,
                totalOutputTokens: row.totalOutputTokens,
                totalRequests: row.totalRequests,
                avgTokensPerSec: row.avgTokensPerSec,
            });
        }
        // Nest endpoint breakdown under each project
        const endpointsByProject = {};
        // @ts-ignore
        for (const row of byProjectEndpoint) {
            const proj = row._id.project || "unknown";
            // @ts-ignore
            if (!endpointsByProject[proj])
                endpointsByProject[proj] = [];
            // @ts-ignore
            endpointsByProject[proj].push({
                endpoint: row._id.endpoint || "unknown",
                totalCost: row.totalCost,
                totalInputTokens: row.totalInputTokens,
                totalOutputTokens: row.totalOutputTokens,
                totalRequests: row.totalRequests,
                avgTokensPerSec: row.avgTokensPerSec,
            });
        }
        // Nest model breakdown under each project
        const modelsByProject = {};
        // @ts-ignore
        for (const row of byProjectModel) {
            const proj = row._id.project || "unknown";
            // @ts-ignore
            if (!modelsByProject[proj])
                modelsByProject[proj] = [];
            // @ts-ignore
            modelsByProject[proj].push({
                model: row._id.model || "unknown",
                provider: row._id.provider || "unknown",
                totalCost: row.totalCost,
                totalInputTokens: row.totalInputTokens,
                totalOutputTokens: row.totalOutputTokens,
                totalRequests: row.totalRequests,
                avgTokensPerSec: row.avgTokensPerSec,
            });
        }
        const t = totals[0] || {
            totalCost: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalRequests: 0,
        };
        res.json({
            totals: {
                totalCost: t.totalCost,
                totalInputTokens: t.totalInputTokens,
                totalOutputTokens: t.totalOutputTokens,
                totalRequests: t.totalRequests,
                avgTokensPerSec: t.avgTokensPerSec,
            },
            byProject: byProject.map((r) => ({
                project: r._id || "unknown",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
                avgTokensPerSec: r.avgTokensPerSec,
                // @ts-ignore
                byProvider: providersByProject[r._id || "unknown"] || [],
                // @ts-ignore
                byEndpoint: endpointsByProject[r._id || "unknown"] || [],
                // @ts-ignore
                byModel: modelsByProject[r._id || "unknown"] || [],
            })),
            byProvider: byProvider.map((r) => ({
                provider: r._id || "unknown",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
            })),
            byModel: byModel.map((r) => ({
                // @ts-ignore - TODO: strict typing
                model: r._id.model || "unknown",
                // @ts-ignore - TODO: strict typing
                provider: r._id.provider || "unknown",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
                avgTokensPerSec: r.avgTokensPerSec,
            })),
            byEndpoint: byEndpoint.map((r) => ({
                endpoint: r._id || "unknown",
                totalCost: r.totalCost,
                totalInputTokens: r.totalInputTokens,
                totalOutputTokens: r.totalOutputTokens,
                totalRequests: r.totalRequests,
                avgTokensPerSec: r.avgTokensPerSec,
            })),
        });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /stats/costs error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/stats/timeline — requests grouped by 10min/hour/day ─
router.get("/stats/timeline", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { hours = 24, from, to, project } = req.query;
        let sinceDate, untilDate;
        if (from) {
            // @ts-ignore - TODO: strict typing
            sinceDate = new Date(from);
        }
        else {
            // @ts-ignore - TODO: strict typing
            sinceDate = new Date(Date.now() - hoursToMs(parseInt(hours, 10)));
        }
        if (to) {
            // @ts-ignore - TODO: strict typing
            untilDate = new Date(to);
        }
        // @ts-ignore - TODO: strict typing
        const spanMs = (untilDate || new Date()) - sinceDate;
        const spanMinutes = spanMs / (1000 * 60);
        const spanHours = spanMinutes / 60;
        const spanDays = spanHours / 24;
        // Eight-tier granularity — targets ~200 data points for every time range.
        // Each tier boundary is chosen so the maximum bin count stays in the 120–288 range.
        let granularity, groupId;
        if (spanMinutes <= 2) {
            // ≤ 2 minutes → 1-second bins  (max 120 pts)  "2026-04-02T22:05:31"
            // @ts-ignore - TODO: strict typing
            granularity = "1s";
            groupId = {
                $dateToString: {
                    format: "%Y-%m-%dT%H:%M:%S",
                    date: { $toDate: "$timestamp" },
                    timezone: "UTC",
                },
            };
        }
        else if (spanMinutes <= 10) {
            // ≤ 10 minutes → 5-second bins  (max 120 pts)  "2026-04-02T22:05:05"
            // @ts-ignore - TODO: strict typing
            granularity = "5s";
            groupId = {
                $concat: [
                    {
                        $dateToString: {
                            format: "%Y-%m-%dT%H:%M:",
                            date: { $toDate: "$timestamp" },
                            timezone: "UTC",
                        },
                    },
                    {
                        $cond: [
                            {
                                $lt: [
                                    {
                                        $multiply: [
                                            {
                                                $floor: {
                                                    $divide: [
                                                        { $second: { $toDate: "$timestamp" } },
                                                        5,
                                                    ],
                                                },
                                            },
                                            5,
                                        ],
                                    },
                                    10,
                                ],
                            },
                            {
                                $concat: [
                                    "0",
                                    {
                                        $toString: {
                                            $multiply: [
                                                {
                                                    $floor: {
                                                        $divide: [
                                                            { $second: { $toDate: "$timestamp" } },
                                                            5,
                                                        ],
                                                    },
                                                },
                                                5,
                                            ],
                                        },
                                    },
                                ],
                            },
                            {
                                $toString: {
                                    $multiply: [
                                        {
                                            $floor: {
                                                $divide: [{ $second: { $toDate: "$timestamp" } }, 5],
                                            },
                                        },
                                        5,
                                    ],
                                },
                            },
                        ],
                    },
                ],
            };
        }
        else if (spanHours <= 1) {
            // ≤ 1 hour → 15-second bins  (max 240 pts)  "2026-04-02T22:05:15"
            // @ts-ignore - TODO: strict typing
            granularity = "15s";
            groupId = {
                $concat: [
                    {
                        $dateToString: {
                            format: "%Y-%m-%dT%H:%M:",
                            date: { $toDate: "$timestamp" },
                            timezone: "UTC",
                        },
                    },
                    {
                        $cond: [
                            {
                                $lt: [
                                    {
                                        $multiply: [
                                            {
                                                $floor: {
                                                    $divide: [
                                                        { $second: { $toDate: "$timestamp" } },
                                                        15,
                                                    ],
                                                },
                                            },
                                            15,
                                        ],
                                    },
                                    10,
                                ],
                            },
                            {
                                $concat: [
                                    "0",
                                    {
                                        $toString: {
                                            $multiply: [
                                                {
                                                    $floor: {
                                                        $divide: [
                                                            { $second: { $toDate: "$timestamp" } },
                                                            15,
                                                        ],
                                                    },
                                                },
                                                15,
                                            ],
                                        },
                                    },
                                ],
                            },
                            {
                                $toString: {
                                    $multiply: [
                                        {
                                            $floor: {
                                                $divide: [{ $second: { $toDate: "$timestamp" } }, 15],
                                            },
                                        },
                                        15,
                                    ],
                                },
                            },
                        ],
                    },
                ],
            };
        }
        else if (spanHours <= 4) {
            // ≤ 4 hours → 1-minute bins  (max 240 pts)  "2026-04-02T22:05"
            // @ts-ignore - TODO: strict typing
            granularity = "1min";
            groupId = {
                $dateToString: {
                    format: "%Y-%m-%dT%H:%M",
                    date: { $toDate: "$timestamp" },
                    timezone: "UTC",
                },
            };
        }
        else if (spanDays <= 1) {
            // ≤ 24 hours → 5-minute bins  (max 288 pts)
            // @ts-ignore - TODO: strict typing
            granularity = "5min";
            groupId = {
                $concat: [
                    { $substr: ["$timestamp", 0, 14] },
                    {
                        $toString: {
                            $multiply: [
                                {
                                    $floor: {
                                        $divide: [
                                            { $toInt: { $substr: ["$timestamp", 14, 2] } },
                                            5,
                                        ],
                                    },
                                },
                                5,
                            ],
                        },
                    },
                ],
            };
        }
        else if (spanDays <= 7) {
            // 1–7 days → hourly bins  (max 168 pts)
            // @ts-ignore - TODO: strict typing
            granularity = "hour";
            groupId = { $substr: ["$timestamp", 0, 13] }; // "2026-03-21T14"
        }
        else if (spanDays <= 60) {
            // 7–60 days → 6-hour bins  (max 240 pts)
            // @ts-ignore - TODO: strict typing
            granularity = "6h";
            groupId = {
                $concat: [
                    {
                        $dateToString: {
                            format: "%Y-%m-%dT",
                            date: { $toDate: "$timestamp" },
                            timezone: "UTC",
                        },
                    },
                    {
                        $cond: [
                            {
                                $lt: [
                                    {
                                        $multiply: [
                                            {
                                                $floor: {
                                                    $divide: [{ $hour: { $toDate: "$timestamp" } }, 6],
                                                },
                                            },
                                            6,
                                        ],
                                    },
                                    10,
                                ],
                            },
                            {
                                $concat: [
                                    "0",
                                    {
                                        $toString: {
                                            $multiply: [
                                                {
                                                    $floor: {
                                                        $divide: [
                                                            { $hour: { $toDate: "$timestamp" } },
                                                            6,
                                                        ],
                                                    },
                                                },
                                                6,
                                            ],
                                        },
                                    },
                                ],
                            },
                            {
                                $toString: {
                                    $multiply: [
                                        {
                                            $floor: {
                                                $divide: [{ $hour: { $toDate: "$timestamp" } }, 6],
                                            },
                                        },
                                        6,
                                    ],
                                },
                            },
                        ],
                    },
                ],
            };
        }
        else {
            // > 60 days → daily bins
            // @ts-ignore - TODO: strict typing
            granularity = "day";
            groupId = { $substr: ["$timestamp", 0, 10] }; // "2026-03-21"
        }
        // @ts-ignore - TODO: strict typing
        const timeMatch = { $gte: sinceDate.toISOString() };
        // @ts-ignore
        if (untilDate)
            timeMatch.$lte = untilDate.toISOString();
        const matchFilter = { timestamp: timeMatch };
        // @ts-ignore
        if (project)
            matchFilter.project = project;
        const pipeline = [
            { $match: matchFilter },
            {
                $group: {
                    _id: groupId,
                    requests: { $sum: 1 },
                    tokens: {
                        $sum: {
                            $add: [
                                { $ifNull: ["$inputTokens", 0] },
                                { $ifNull: ["$outputTokens", 0] },
                            ],
                        },
                    },
                    cost: COST_SUM_EXPR,
                    avgLatency: { $avg: { $ifNull: ["$totalTime", null] } },
                    successes: {
                        $sum: { $cond: [{ $eq: ["$success", true] }, 1, 0] },
                    },
                },
            },
            { $sort: { _id: 1 } },
        ];
        const results = await db
            .collection(REQUESTS_COL)
            .aggregate(pipeline)
            .toArray();
        res.json({
            granularity,
            data: results.map((r) => ({
                hour: r._id,
                requests: r.requests,
                tokens: r.tokens,
                cost: r.cost,
                // @ts-ignore - TODO: strict typing
                avgLatency: r.avgLatency ? Math.round(r.avgLatency) : 0,
                successRate: 
                // @ts-ignore - TODO: strict typing
                r.requests > 0 ? Math.round((r.successes / r.requests) * 100) : 100,
            })),
        });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /stats/timeline error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/conversations — cross-project conversation list ─
router.get("/conversations", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { page = 1, limit = 50, project, username, search, provider, model, trace, from, to, sort = "updatedAt", order = "desc", } = req.query;
        const filter = {};
        // @ts-ignore
        if (trace)
            filter.traceId = trace;
        // @ts-ignore
        if (project)
            filter.project = project;
        // @ts-ignore
        if (username)
            filter.username = username;
        if (search) {
            const regex = { $regex: search, $options: "i" };
            const orClauses = [
                { title: regex },
                { project: regex },
                { username: regex },
            ];
            // IP lives on requests, not conversations — resolve matching
            // conversationIds first, then fold them into the $or filter.
            // @ts-ignore - TODO: strict typing
            if (/^[\d.:a-f]+$/i.test(search.trim())) {
                const matchingConvIds = await db
                    .collection(REQUESTS_COL)
                    .distinct("conversationId", { clientIp: regex });
                if (matchingConvIds.length > 0) {
                    // @ts-ignore
                    orClauses.push({ id: { $in: matchingConvIds } });
                }
            }
            // @ts-ignore
            filter.$or = orClauses;
        }
        // @ts-ignore
        if (provider)
            filter.providers = provider;
        // @ts-ignore
        if (model)
            filter["messages.model"] = model;
        if (from || to) {
            // @ts-ignore
            filter.updatedAt = {};
            // @ts-ignore
            if (from)
                filter.updatedAt.$gte = from;
            // @ts-ignore
            if (to)
                filter.updatedAt.$lte = to;
        }
        // @ts-ignore - TODO: strict typing
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        // @ts-ignore - TODO: strict typing
        const lim = parseInt(limit, 10);
        const sortDir = order === "asc" ? 1 : -1;
        const pipeline = [
            ...(Object.keys(filter).length ? [{ $match: filter }] : []),
            // @ts-ignore - TODO: strict typing
            { $sort: { [sort]: sortDir } },
            {
                $project: {
                    id: 1,
                    project: 1,
                    username: 1,
                    title: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    modalities: 1,
                    providers: 1,
                    messageCount: { $size: { $ifNull: ["$messages", []] } },
                    totalCost: {
                        $ifNull: [
                            "$totalCost",
                            {
                                $reduce: {
                                    input: { $ifNull: ["$messages", []] },
                                    initialValue: 0,
                                    in: {
                                        $add: [
                                            "$$value",
                                            { $ifNull: ["$$this.estimatedCost", 0] },
                                        ],
                                    },
                                },
                            },
                        ],
                    },
                },
            },
            { $skip: skip },
            { $limit: lim },
            // Join requests for telemetry rollup
            {
                $lookup: {
                    from: REQUESTS_COL,
                    localField: "id",
                    foreignField: "conversationId",
                    as: "_requests",
                    pipeline: [
                        {
                            $project: {
                                inputTokens: 1,
                                outputTokens: 1,
                                model: 1,
                                tokensPerSec: 1,
                                totalTime: 1,
                                toolDisplayNames: 1,
                                toolApiNames: 1,
                            },
                        },
                    ],
                },
            },
            {
                $addFields: {
                    requestCount: { $size: "$_requests" },
                    inputTokens: {
                        $reduce: {
                            input: "$_requests",
                            initialValue: 0,
                            in: {
                                $add: ["$$value", { $ifNull: ["$$this.inputTokens", 0] }],
                            },
                        },
                    },
                    outputTokens: {
                        $reduce: {
                            input: "$_requests",
                            initialValue: 0,
                            in: {
                                $add: ["$$value", { $ifNull: ["$$this.outputTokens", 0] }],
                            },
                        },
                    },
                    models: {
                        $setUnion: {
                            $filter: {
                                input: "$_requests.model",
                                cond: { $ne: ["$$this", null] },
                            },
                        },
                    },
                    toolDisplayNames: {
                        $setUnion: {
                            $reduce: {
                                input: "$_requests",
                                initialValue: [],
                                in: {
                                    $concatArrays: [
                                        "$$value",
                                        { $ifNull: ["$$this.toolDisplayNames", []] },
                                    ],
                                },
                            },
                        },
                    },
                    toolApiNames: {
                        $setUnion: {
                            $reduce: {
                                input: "$_requests",
                                initialValue: [],
                                in: {
                                    $concatArrays: [
                                        "$$value",
                                        { $ifNull: ["$$this.toolApiNames", []] },
                                    ],
                                },
                            },
                        },
                    },
                    avgTokensPerSec: {
                        $cond: [
                            { $gt: [{ $size: "$_requests" }, 0] },
                            {
                                $avg: {
                                    $filter: {
                                        input: "$_requests.tokensPerSec",
                                        as: "tps",
                                        cond: {
                                            $and: [{ $ne: ["$$tps", null] }, { $gt: ["$$tps", 0] }],
                                        },
                                    },
                                },
                            },
                            null,
                        ],
                    },
                    totalLatency: {
                        $reduce: {
                            input: "$_requests",
                            initialValue: 0,
                            in: {
                                $add: ["$$value", { $ifNull: ["$$this.totalTime", 0] }],
                            },
                        },
                    },
                },
            },
            // Drop raw request docs from response
            { $project: { _requests: 0 } },
        ];
        const [docs, total] = await Promise.all([
            db.collection(CONVERSATIONS_COL).aggregate(pipeline).toArray(),
            db.collection(CONVERSATIONS_COL).countDocuments(filter),
        ]);
        // @ts-ignore - TODO: strict typing
        res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /conversations error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/conversations/filters — distinct project & username values ─
router.get("/conversations/filters", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const [convProjects, reqProjects, usernames] = await Promise.all([
            db.collection(CONVERSATIONS_COL).distinct("project"),
            db.collection(REQUESTS_COL).distinct("project"),
            db.collection(CONVERSATIONS_COL).distinct("username"),
        ]);
        // Merge and deduplicate projects from both collections
        const projects = [...new Set([...convProjects, ...reqProjects])];
        res.json({
            projects: projects.filter(Boolean).sort(),
            usernames: usernames.filter(Boolean).sort(),
        });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /conversations/filters error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/conversations/stats — quick stats snapshot ──
router.get("/conversations/stats", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const project = req.query.project || null;
        const filter = project ? { project } : {};
        const oneHourAgo = new Date(Date.now() - MS_PER_HOUR).toISOString();
        const fiveMinAgo = new Date(Date.now() - minutes(5)).toISOString();
        const [generatingCount, recentCount] = await Promise.all([
            db.collection(CONVERSATIONS_COL).countDocuments({
                ...filter,
                isGenerating: true,
                updatedAt: { $gte: fiveMinAgo },
            }),
            db
                .collection(CONVERSATIONS_COL)
                .countDocuments({ ...filter, updatedAt: { $gte: oneHourAgo } }),
        ]);
        res.json({
            generatingCount: generatingCount +
                BenchmarkService.activeGenerationCount +
                ActiveGenerationTracker.count,
            recentCount,
        });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /conversations/stats error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/conversations/stream — SSE for real-time stats ─
router.get("/conversations/stream", asyncHandler(async (req, res) => {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!db)
        return res.status(503).json({ error: "Database not available" });
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
                db.collection(CONVERSATIONS_COL).countDocuments({
                    ...filter,
                    isGenerating: true,
                    updatedAt: { $gte: fiveMinAgo },
                }),
                db
                    .collection(CONVERSATIONS_COL)
                    .countDocuments({ ...filter, updatedAt: { $gte: oneHourAgo } }),
            ]);
            // Auto-clear stale isGenerating flags (> 5 min without update)
            db.collection(CONVERSATIONS_COL)
                .updateMany({ isGenerating: true, updatedAt: { $lt: fiveMinAgo } }, { $set: { isGenerating: false } })
                // @ts-ignore - TODO: strict typing
                .then(({ modifiedCount }) => {
                // @ts-ignore - TODO: strict typing
                if (modifiedCount > 0)
                    logger.info(`Auto-cleared ${modifiedCount} stale isGenerating flag(s)`);
            })
                .catch(() => { });
            const payload = JSON.stringify({
                generatingCount: generatingCount +
                    BenchmarkService.activeGenerationCount +
                    ActiveGenerationTracker.count,
                recentCount,
            });
            // Only send if data changed
            if (payload !== lastPayload) {
                lastPayload = payload;
                res.write(`data: ${payload}\n\n`);
            }
        }
        catch (error) {
            // @ts-ignore - TODO: strict typing
            logger.error(`SSE conversations/stream error: ${error.message}`);
        }
    };
    // Initial send
    await sendStats();
    if (ChangeStreamService.available) {
        // Change Stream-driven: re-query stats only when conversations change
        const onEvent = (event) => {
            if (event.collection === "conversations") {
                sendStats();
            }
        };
        // @ts-ignore - TODO: strict typing
        ChangeStreamService.subscribe(onEvent);
        // Secondary poll: catch generation activity not tracked via Change
        // Streams (benchmarks skip conversation persistence, and provider
        // calls from skipConversation requests like Lupos are tracked by
        // ActiveGenerationTracker instead of isGenerating on a conversation doc).
        let prevNonConvCount = 0;
        const generationPoll = setInterval(() => {
            const count = BenchmarkService.activeGenerationCount +
                ActiveGenerationTracker.count;
            if (count > 0 || prevNonConvCount > 0)
                sendStats();
            prevNonConvCount = count;
        }, 1000);
        const keepAlive = setInterval(() => {
            try {
                res.write(": ping\n\n");
            }
            catch {
                /* ignore */
            }
        }, SSE_KEEPALIVE_INTERVAL_MS);
        req.on("close", () => {
            // @ts-ignore - TODO: strict typing
            ChangeStreamService.unsubscribe(onEvent);
            clearInterval(generationPoll);
            clearInterval(keepAlive);
        });
    }
    else {
        // Fallback: poll every 2 seconds
        const interval = setInterval(sendStats, 2000);
        const keepAlive = setInterval(() => {
            res.write(": ping\n\n");
        }, SSE_KEEPALIVE_INTERVAL_MS);
        req.on("close", () => {
            clearInterval(interval);
            clearInterval(keepAlive);
        });
    }
}));
// ─── GET /admin/changes/stream — SSE for real-time collection changes ─
router.get("/changes/stream", asyncHandler(async (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    // Immediately tell the client whether change streams are active
    res.write(`data: ${JSON.stringify({ type: "status", changeStreams: ChangeStreamService.available })}\n\n`);
    if (ChangeStreamService.available) {
        // Push change events as they arrive from MongoDB
        const onEvent = (event) => {
            try {
                res.write(`data: ${JSON.stringify({ type: "change", ...event })}\n\n`);
            }
            catch {
                // Client disconnected
            }
        };
        // @ts-ignore - TODO: strict typing
        ChangeStreamService.subscribe(onEvent);
        // Keep-alive ping every 30s
        const keepAlive = setInterval(() => {
            try {
                res.write(": ping\n\n");
            }
            catch {
                // ignore
            }
        }, SSE_KEEPALIVE_INTERVAL_MS);
        req.on("close", () => {
            // @ts-ignore - TODO: strict typing
            ChangeStreamService.unsubscribe(onEvent);
            clearInterval(keepAlive);
        });
    }
    else {
        // No Change Streams — just keep the connection alive.
        // The client will detect changeStreams: false from the status event
        // and fall back to polling.
        const keepAlive = setInterval(() => {
            try {
                res.write(": ping\n\n");
            }
            catch {
                // ignore
            }
        }, SSE_KEEPALIVE_INTERVAL_MS);
        req.on("close", () => {
            clearInterval(keepAlive);
        });
    }
}));
// ─── GET /admin/conversations/:id — single conversation, full msgs ─
router.get("/conversations/:id", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const document = await db
            .collection(CONVERSATIONS_COL)
            .findOne({ id: req.params.id });
        if (!document)
            return res.status(404).json({ error: "Conversation not found" });
        res.json(document);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /conversations/:id error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/live — conversations updated in last N minutes ─
router.get("/live", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { minutes: minParam = 5 } = req.query;
        const since = new Date(
        // @ts-ignore - TODO: strict typing
        Date.now() - parseInt(minParam, 10) * MS_PER_MINUTE).toISOString();
        const [rawConversations, recentRequests] = await Promise.all([
            db
                .collection(CONVERSATIONS_COL)
                .find({ updatedAt: { $gte: since } })
                .project({
                id: 1,
                project: 1,
                username: 1,
                title: 1,
                updatedAt: 1,
                messages: 1,
                modalities: 1,
                providers: 1,
                isGenerating: 1,
            })
                .sort({ updatedAt: -1 })
                .toArray(),
            db
                .collection(REQUESTS_COL)
                .find({ timestamp: { $gte: since } })
                .sort({ timestamp: -1 })
                .limit(20)
                .toArray(),
        ]);
        // Enrich conversations with lastMessage info and remap fields
        const conversations = rawConversations.map((c) => {
            const msgs = c.messages || [];
            // @ts-ignore - TODO: strict typing
            const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
            let lastMessageText = null;
            if (lastMsg) {
                const content = lastMsg.content;
                if (typeof content === "string") {
                    lastMessageText = content;
                }
                else if (Array.isArray(content)) {
                    const textPart = content.find((p) => p.type === "text");
                    lastMessageText = textPart?.text || null;
                }
            }
            // Compute totalCost from messages (covers docs saved before totalCost field existed)
            const totalCost = c.totalCost ||
                // @ts-ignore - TODO: strict typing
                msgs.reduce((sum, m) => sum + (m.estimatedCost || 0), 0);
            return {
                id: c.id,
                project: c.project,
                username: c.username,
                title: c.title,
                lastActivity: c.updatedAt,
                // @ts-ignore - TODO: strict typing
                messageCount: msgs.length,
                lastMessage: lastMessageText,
                lastMessageRole: lastMsg?.role || null,
                isGenerating: c.isGenerating || false,
                modalities: c.modalities || null,
                providers: c.providers || [],
                totalCost,
            };
        });
        // Calc requests per minute
        const totalRecent = await db
            .collection(REQUESTS_COL)
            .countDocuments({ timestamp: { $gte: since } });
        // @ts-ignore - TODO: strict typing
        const requestsPerMinute = totalRecent / parseInt(minParam, 10);
        res.json({
            conversations,
            recentRequests,
            requestsPerMinute: Math.round(requestsPerMinute * 100) / 100,
            activeCount: conversations.length,
        });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /live error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/health — system health ──────────────────────
router.get("/health", asyncHandler(async (_req, res) => {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    const mongoStatus = db ? "connected" : "disconnected";
    let dbStats = null;
    if (db) {
        try {
            const [requestCount, conversationCount] = await Promise.all([
                db.collection(REQUESTS_COL).estimatedDocumentCount(),
                db.collection(CONVERSATIONS_COL).estimatedDocumentCount(),
            ]);
            dbStats = { requestCount, conversationCount };
        }
        catch {
            // ignore
        }
    }
    res.json({
        status: mongoStatus === "connected" ? "healthy" : "degraded",
        mongo: mongoStatus,
        dbStats,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        system: {
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
        },
    });
}));
// ─── Model Management ───────────────────────────────────────
/**
 * GET /admin/lm-studio/models
 * List all models available in LM Studio (loaded + downloaded).
 */
router.get("/lm-studio/models", asyncHandler(async (_req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const provider = getProvider("lm-studio");
        const data = await provider.listModels();
        res.json(data);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /lm-studio/models error: ${error.message}`);
        next(error);
    }
}));
/**
 * POST /admin/lm-studio/load
 * Load a model into LM Studio. Auto-unloads any other loaded model first
 * to enforce single-model-at-a-time.
 * Body: { model: "model-key" }
 */
router.post("/lm-studio/load", asyncHandler(async (req, res, next) => {
    try {
        const { model, context_length, flash_attention, offload_kv_cache_to_gpu, } = req.body;
        if (!model) {
            return res
                .status(400)
                .json({ error: "Missing 'model' in request body" });
        }
        // @ts-ignore - TODO: strict typing
        const provider = getProvider("lm-studio");
        // Build load options from request body
        const loadOptions = {};
        // @ts-ignore
        if (context_length != null)
            loadOptions.context_length = context_length;
        // @ts-ignore
        if (flash_attention != null)
            // @ts-ignore
            loadOptions.flash_attention = flash_attention;
        // @ts-ignore
        if (offload_kv_cache_to_gpu != null)
            // @ts-ignore
            loadOptions.offload_kv_cache_to_gpu = offload_kv_cache_to_gpu;
        // ensureModelLoaded handles: skip if already loaded, unload others, then load
        const { alreadyLoaded } = await provider.ensureModelLoaded(model, loadOptions);
        if (alreadyLoaded) {
            logger.info(`[admin/lm-studio/load] Model ${model} already loaded — skipping`);
        }
        res.json({ model, alreadyLoaded });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /lm-studio/load error: ${error.message}`);
        next(error);
    }
}));
/**
 * POST /admin/lm-studio/unload
 * Unload a model from LM Studio memory.
 * Body: { instance_id: "model-instance-id" }
 */
router.post("/lm-studio/unload", asyncHandler(async (req, res, next) => {
    try {
        const { instance_id } = req.body;
        if (!instance_id) {
            return res.status(400).json({
                error: "Missing 'instance_id' in request body",
            });
        }
        // @ts-ignore - TODO: strict typing
        const provider = getProvider("lm-studio");
        const data = await provider.unloadModel(instance_id);
        res.json(data);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /lm-studio/unload error: ${error.message}`);
        next(error);
    }
}));
/**
 * POST /admin/lm-studio/estimate
 * Estimate VRAM usage for a model with given configuration.
 * Body: { model, contextLength, gpuLayers, flashAttention, offloadKvCache }
 */
router.post("/lm-studio/estimate", asyncHandler(async (req, res, next) => {
    try {
        const { model, contextLength, gpuLayers, flashAttention, offloadKvCache, } = req.body;
        if (!model) {
            return res
                .status(400)
                .json({ error: "Missing 'model' in request body" });
        }
        // @ts-ignore - TODO: strict typing
        const provider = getProvider("lm-studio");
        const result = await provider.listModels();
        const allModels = result?.data || result?.models || [];
        const modelData = allModels.find((m) => m.id === model || m.path === model || m.key === model);
        if (!modelData) {
            return res.status(404).json({ error: `Model '${model}' not found` });
        }
        const sizeBytes = modelData.size_bytes || 0;
        const bpw = modelData.quantization?.bits_per_weight || 4;
        const archParams = resolveArchParams(modelData.architecture, modelData.params_string, sizeBytes, bpw);
        const totalLayers = archParams.layers;
        const memory = estimateMemory({
            sizeBytes,
            archParams,
            gpuLayers: gpuLayers ?? totalLayers,
            contextLength: contextLength ?? 4096,
            offloadKvCache: offloadKvCache ?? true,
            flashAttention: flashAttention ?? true,
            vision: modelData.capabilities?.vision || false,
        });
        res.json({
            ...memory,
            archParams,
            totalLayers,
        });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /lm-studio/estimate error: ${error.message}`);
        next(error);
    }
}));
// ─── admin read-only views (POST lives at /workflows) ───────
/**
 * GET /admin/workflows — paginated workflow list
 */
router.get("/workflows", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { page = 1, limit = 50, project, provider, model, guildId, userId, userName, from, to, sort = "createdAt", order = "desc", } = req.query;
        const filter = {};
        // @ts-ignore
        if (guildId)
            filter.guildId = guildId;
        // @ts-ignore
        if (userId)
            filter.userId = userId;
        // @ts-ignore
        if (userName)
            filter.userName = { $regex: userName, $options: "i" };
        if (from || to) {
            // @ts-ignore
            filter.createdAt = {};
            // @ts-ignore
            if (from)
                filter.createdAt.$gte = from;
            // @ts-ignore
            if (to)
                filter.createdAt.$lte = to;
        }
        // If project, provider, or model is specified, find matching conversation IDs
        // and filter workflows that reference those conversations
        if (project || provider || model) {
            const convFilter = {};
            // @ts-ignore
            if (project)
                convFilter.project = project;
            // @ts-ignore
            if (provider)
                convFilter.providers = provider;
            // @ts-ignore
            if (model)
                convFilter["messages.model"] = model;
            const convIds = await db
                .collection(CONVERSATIONS_COL)
                .distinct("id", convFilter);
            // @ts-ignore
            filter.conversationIds = { $elemMatch: { $in: convIds } };
        }
        // @ts-ignore - TODO: strict typing
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        // @ts-ignore - TODO: strict typing
        const lim = parseInt(limit, 10);
        const sortDir = order === "asc" ? 1 : -1;
        const [docs, total] = await Promise.all([
            db
                .collection(WORKFLOWS_COL)
                .find(filter)
                .project({
                _id: 1,
                name: 1,
                messageId: 1,
                guildId: 1,
                guildName: 1,
                channelId: 1,
                channelName: 1,
                userId: 1,
                userName: 1,
                userContent: 1,
                stepCount: 1,
                totalDuration: 1,
                totalCost: 1,
                modalities: 1,
                providers: 1,
                source: 1,
                createdAt: 1,
                updatedAt: 1,
            })
                // @ts-ignore - TODO: strict typing
                .sort({ [sort]: sortDir })
                .skip(skip)
                .limit(lim)
                .toArray(),
            db.collection(WORKFLOWS_COL).countDocuments(filter),
        ]);
        // @ts-ignore - TODO: strict typing
        res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin GET /workflows error: ${error.message}`);
        next(error);
    }
}));
/**
 * GET /admin/workflows/:id — full workflow detail
 */
router.get("/workflows/:id", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { ObjectId } = await import("mongodb");
        let objectId;
        try {
            // @ts-ignore - TODO: strict typing
            objectId = new ObjectId(req.params.id);
        }
        catch {
            return res.status(400).json({ error: "Invalid workflow ID" });
        }
        const document = await db.collection(WORKFLOWS_COL).findOne({ _id: objectId });
        if (!document)
            return res.status(404).json({ error: "Workflow not found" });
        res.json(document);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin GET /workflows/:id error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/media — extract media from all conversations ─
router.get("/media", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { page = 1, limit = 100, type, origin, search, project, username, from, to, } = req.query;
        // @ts-ignore - TODO: strict typing
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        // @ts-ignore - TODO: strict typing
        const lim = parseInt(limit, 10);
        // Get distinct projects and usernames for filter dropdowns
        const [convProjects, convUsernames, reqProjects, reqUsernames] = await Promise.all([
            db.collection(CONVERSATIONS_COL).distinct("project"),
            db.collection(CONVERSATIONS_COL).distinct("username"),
            db.collection(REQUESTS_COL).distinct("project", {
                operation: { $in: ["agent:image", "agent:iteration"] },
                success: true,
                "responsePayload.images": { $exists: true, $ne: [] },
            }),
            db.collection(REQUESTS_COL).distinct("username", {
                operation: { $in: ["agent:image", "agent:iteration"] },
                success: true,
                "responsePayload.images": { $exists: true, $ne: [] },
            }),
        ]);
        const allProjects = [...new Set([...convProjects, ...reqProjects])]
            .filter(Boolean)
            .sort();
        const allUsernames = [...new Set([...convUsernames, ...reqUsernames])]
            .filter(Boolean)
            .sort();
        // Use aggregation to unwind messages and extract media in one query
        const preMatch = {};
        // @ts-ignore
        if (project)
            preMatch.project = project;
        // @ts-ignore
        if (username)
            preMatch.username = username;
        if (from || to) {
            // @ts-ignore
            preMatch.updatedAt = {};
            // @ts-ignore
            if (from)
                preMatch.updatedAt.$gte = from;
            // @ts-ignore
            if (to)
                preMatch.updatedAt.$lte = to;
        }
        const pipeline = [
            ...(Object.keys(preMatch).length ? [{ $match: preMatch }] : []),
            { $unwind: "$messages" },
            {
                $project: {
                    convId: "$id",
                    convTitle: "$title",
                    project: 1,
                    username: 1,
                    role: "$messages.role",
                    content: "$messages.content",
                    images: { $ifNull: ["$messages.images", []] },
                    audio: "$messages.audio",
                    toolCalls: { $ifNull: ["$messages.toolCalls", []] },
                    timestamp: { $ifNull: ["$messages.timestamp", "$updatedAt"] },
                    model: "$messages.model",
                },
            },
            // Search across conversation title AND message content
            ...(search
                ? [
                    {
                        $match: {
                            $or: [
                                { convTitle: { $regex: search, $options: "i" } },
                                { content: { $regex: search, $options: "i" } },
                            ],
                        },
                    },
                ]
                : []),
            // Expand images array into individual items
            {
                $facet: {
                    imageItems: [
                        { $unwind: "$images" },
                        {
                            $project: {
                                url: "$images",
                                mediaType: "image",
                                convId: 1,
                                convTitle: 1,
                                project: 1,
                                username: 1,
                                role: 1,
                                timestamp: 1,
                                model: 1,
                            },
                        },
                    ],
                    audioItems: [
                        { $match: { audio: { $ne: null, $exists: true } } },
                        {
                            $project: {
                                url: "$audio",
                                mediaType: "audio",
                                convId: 1,
                                convTitle: 1,
                                project: 1,
                                username: 1,
                                role: 1,
                                timestamp: 1,
                                model: 1,
                            },
                        },
                    ],
                    // Extract browser screenshots from toolCalls[].result.screenshotRef
                    screenshotItems: [
                        { $unwind: "$toolCalls" },
                        {
                            $match: {
                                "toolCalls.result.screenshotRef": {
                                    $exists: true,
                                    $ne: null,
                                },
                            },
                        },
                        {
                            $project: {
                                url: "$toolCalls.result.screenshotRef",
                                mediaType: "image",
                                convId: 1,
                                convTitle: 1,
                                project: 1,
                                username: 1,
                                role: 1,
                                timestamp: 1,
                                model: 1,
                            },
                        },
                    ],
                },
            },
            // Merge all streams
            {
                $project: {
                    allMedia: {
                        $concatArrays: ["$imageItems", "$audioItems", "$screenshotItems"],
                    },
                },
            },
            { $unwind: "$allMedia" },
            { $replaceRoot: { newRoot: "$allMedia" } },
            { $sort: { timestamp: -1 } },
        ];
        // Apply filters
        if (type) {
            pipeline.push({ $match: { mediaType: type } });
        }
        if (origin === "user") {
            pipeline.push({ $match: { role: "user" } });
        }
        else if (origin === "ai") {
            pipeline.push({ $match: { role: "assistant" } });
        }
        // ── Conversation-based media ──────────────────────────────
        const convItems = await db
            .collection(CONVERSATIONS_COL)
            .aggregate(pipeline)
            .toArray();
        // ── Agent-generated images from requests (captures skipConversation callers) ──
        let requestGenItems = [];
        if (!type || type === "image") {
            if (origin !== "user") {
                const reqMatch = {
                    operation: { $in: ["agent:image", "agent:iteration"] },
                    success: true,
                    "responsePayload.images": { $exists: true, $ne: [] },
                };
                // @ts-ignore
                if (project)
                    reqMatch.project = project;
                // @ts-ignore
                if (username)
                    reqMatch.username = username;
                if (from || to) {
                    // @ts-ignore
                    reqMatch.timestamp = {};
                    // @ts-ignore
                    if (from)
                        reqMatch.timestamp.$gte = from;
                    // @ts-ignore
                    if (to)
                        reqMatch.timestamp.$lte = to;
                }
                if (search) {
                    // @ts-ignore
                    reqMatch["requestPayload.messages.content"] = {
                        $regex: search,
                        $options: "i",
                    };
                }
                const reqPipeline = [
                    { $match: reqMatch },
                    { $unwind: "$responsePayload.images" },
                    {
                        $match: {
                            "responsePayload.images": {
                                $regex: "^(minio://|https?://|data:)",
                            },
                        },
                    },
                    {
                        $project: {
                            url: "$responsePayload.images",
                            mediaType: "image",
                            convId: { $ifNull: ["$conversationId", null] },
                            convTitle: "Agent Generation",
                            project: 1,
                            username: 1,
                            role: "assistant",
                            timestamp: 1,
                            model: 1,
                            agent: 1,
                        },
                    },
                    { $sort: { timestamp: -1 } },
                ];
                requestGenItems = await db
                    .collection(REQUESTS_COL)
                    .aggregate(reqPipeline)
                    .toArray();
            }
        }
        // ── Merge and deduplicate ──────────────────────────────────
        const seenUrls = new Set(convItems.map((i) => i.url));
        const mergedItems = [...convItems];
        // @ts-ignore
        for (const item of requestGenItems) {
            if (!seenUrls.has(item.url)) {
                seenUrls.add(item.url);
                mergedItems.push(item);
            }
        }
        mergedItems.sort((a, b) => {
            const ta = a.timestamp || "";
            const tb = b.timestamp || "";
            return ta < tb ? 1 : ta > tb ? -1 : 0;
        });
        const total = mergedItems.length;
        const paginatedItems = mergedItems.slice(skip, skip + lim);
        const data = paginatedItems.map((item) => ({
            url: item.url,
            mediaType: item.mediaType,
            origin: item.role === "assistant" ? "ai" : "user",
            convId: item.convId,
            convTitle: item.convTitle || "Untitled",
            project: item.project,
            username: item.username,
            model: item.model,
            timestamp: item.timestamp,
            // @ts-ignore - TODO: strict typing
            ...(item.agent && { agent: item.agent }),
        }));
        res.json({
            data,
            total,
            // @ts-ignore - TODO: strict typing
            page: parseInt(page, 10),
            limit: lim,
            projects: allProjects,
            usernames: allUsernames,
        });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /media error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/text — extract text content from conversations ─
router.get("/text", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { page = 1, limit = 50, origin, search, project, from, to, } = req.query;
        // @ts-ignore - TODO: strict typing
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        // @ts-ignore - TODO: strict typing
        const lim = parseInt(limit, 10);
        const preMatch = {};
        // @ts-ignore
        if (project)
            preMatch.project = project;
        if (from || to) {
            // @ts-ignore
            preMatch.updatedAt = {};
            // @ts-ignore
            if (from)
                preMatch.updatedAt.$gte = from;
            // @ts-ignore
            if (to)
                preMatch.updatedAt.$lte = to;
        }
        const pipeline = [
            ...(Object.keys(preMatch).length ? [{ $match: preMatch }] : []),
            { $unwind: "$messages" },
            {
                $match: {
                    "messages.content": { $exists: true, $nin: [null, ""] },
                },
            },
            {
                $project: {
                    convId: "$id",
                    convTitle: "$title",
                    project: 1,
                    username: 1,
                    role: "$messages.role",
                    content: "$messages.content",
                    timestamp: { $ifNull: ["$messages.timestamp", "$updatedAt"] },
                    model: "$messages.model",
                    estimatedCost: "$messages.estimatedCost",
                    images: { $size: { $ifNull: ["$messages.images", []] } },
                },
            },
            { $sort: { timestamp: -1 } },
        ];
        // Filters
        if (origin === "user") {
            pipeline.push({ $match: { role: "user" } });
        }
        else if (origin === "ai") {
            pipeline.push({ $match: { role: "assistant" } });
        }
        if (search) {
            pipeline.push({
                $match: { content: { $regex: search, $options: "i" } },
            });
        }
        const countPipeline = [...pipeline, { $count: "total" }];
        const [countResult] = await db
            .collection(CONVERSATIONS_COL)
            .aggregate(countPipeline)
            .toArray();
        const total = countResult?.total || 0;
        // @ts-ignore
        pipeline.push({ $skip: skip }, { $limit: lim });
        const items = await db
            .collection(CONVERSATIONS_COL)
            .aggregate(pipeline)
            .toArray();
        const data = items.map((item) => ({
            content: item.content,
            origin: item.role === "assistant" ? "ai" : "user",
            role: item.role,
            convId: item.convId,
            convTitle: item.convTitle || "Untitled",
            project: item.project,
            username: item.username,
            model: item.model,
            estimatedCost: item.estimatedCost,
            // @ts-ignore - TODO: strict typing
            hasImages: item.images > 0,
            timestamp: item.timestamp,
        }));
        // @ts-ignore - TODO: strict typing
        res.json({ data, total, page: parseInt(page, 10), limit: lim });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /text error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/traces — paginated trace list (derived from requests) ─
router.get("/traces", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { page = 1, limit = 50, project, username, from, to, sort = "createdAt", order = "desc", } = req.query;
        // Base filter: only requests with a traceId
        const match = { traceId: { $ne: null } };
        // @ts-ignore
        if (project)
            match.project = project;
        // @ts-ignore
        if (username)
            match.username = username;
        if (from || to) {
            // @ts-ignore
            match.timestamp = {};
            // @ts-ignore
            if (from)
                match.timestamp.$gte = from;
            // @ts-ignore
            if (to)
                match.timestamp.$lte = to;
        }
        // @ts-ignore - TODO: strict typing
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        // @ts-ignore - TODO: strict typing
        const lim = parseInt(limit, 10);
        const sortDir = order === "asc" ? 1 : -1;
        const pipeline = [
            { $match: match },
            // Group all requests by traceId
            {
                $group: {
                    _id: "$traceId",
                    project: { $first: "$project" },
                    username: { $first: "$username" },
                    createdAt: { $min: "$timestamp" },
                    updatedAt: { $max: "$timestamp" },
                    requestCount: { $sum: 1 },
                    totalInputTokens: { $sum: { $ifNull: ["$inputTokens", 0] } },
                    totalOutputTokens: { $sum: { $ifNull: ["$outputTokens", 0] } },
                    totalCost: COST_SUM_EXPR,
                    totalLatency: { $sum: { $ifNull: ["$totalTime", 0] } },
                    totalMessages: { $sum: { $ifNull: ["$messageCount", 0] } },
                    _models: { $addToSet: "$model" },
                    _providers: { $addToSet: "$provider" },
                    _agents: { $addToSet: "$agent" },
                    _toolArrays: { $push: { $ifNull: ["$toolDisplayNames", []] } },
                    _toolCallArrays: { $push: { $ifNull: ["$toolApiNames", []] } },
                    _tpsValues: { $push: "$tokensPerSec" },
                    _modalities: { $push: "$modalities" },
                    _requests: {
                        $push: {
                            requestId: "$requestId",
                            conversationId: "$conversationId",
                            traceId: "$traceId",
                            inputTokens: "$inputTokens",
                            outputTokens: "$outputTokens",
                            model: "$model",
                            provider: "$provider",
                            project: "$project",
                            username: "$username",
                            endpoint: "$endpoint",
                            operation: "$operation",
                            estimatedCost: "$estimatedCost",
                            success: "$success",
                            modalities: "$modalities",
                            messageCount: "$messageCount",
                            tokensPerSec: "$tokensPerSec",
                            totalTime: "$totalTime",
                            toolsUsed: "$toolsUsed",
                            toolDisplayNames: "$toolDisplayNames",
                            toolApiNames: "$toolApiNames",
                            agent: "$agent",
                            timestamp: "$timestamp",
                        },
                    },
                },
            },
            // Shape the output
            {
                $addFields: {
                    id: "$_id",
                    models: { $setDifference: ["$_models", [null]] },
                    providers: { $setDifference: ["$_providers", [null]] },
                    agents: { $setDifference: ["$_agents", [null]] },
                    toolDisplayNames: {
                        $setUnion: {
                            $reduce: {
                                input: "$_toolArrays",
                                initialValue: [],
                                in: { $concatArrays: ["$$value", "$$this"] },
                            },
                        },
                    },
                    toolApiNames: {
                        $setUnion: {
                            $reduce: {
                                input: "$_toolCallArrays",
                                initialValue: [],
                                in: { $concatArrays: ["$$value", "$$this"] },
                            },
                        },
                    },
                    avgTokensPerSec: {
                        $avg: {
                            $filter: {
                                input: "$_tpsValues",
                                as: "tps",
                                cond: {
                                    $and: [{ $ne: ["$$tps", null] }, { $gt: ["$$tps", 0] }],
                                },
                            },
                        },
                    },
                    startedAt: "$createdAt",
                    finishedAt: "$updatedAt",
                    modalities: {
                        $reduce: {
                            input: "$_modalities",
                            initialValue: {},
                            in: {
                                $mergeObjects: [
                                    "$$value",
                                    {
                                        $cond: [
                                            { $ne: ["$$this", null] },
                                            {
                                                $arrayToObject: {
                                                    $filter: {
                                                        input: { $objectToArray: "$$this" },
                                                        as: "kv",
                                                        cond: { $eq: ["$$kv.v", true] },
                                                    },
                                                },
                                            },
                                            {},
                                        ],
                                    },
                                ],
                            },
                        },
                    },
                    requests: "$_requests",
                },
            },
            // Remove intermediate fields
            {
                $project: {
                    _id: 0,
                    _models: 0,
                    _providers: 0,
                    _agents: 0,
                    _toolArrays: 0,
                    _toolCallArrays: 0,
                    _tpsValues: 0,
                    _modalities: 0,
                    _requests: 0,
                },
            },
            // @ts-ignore - TODO: strict typing
            { $sort: { [sort]: sortDir } },
        ];
        // Count total matching traces
        const countPipeline = [...pipeline, { $count: "total" }];
        // Add pagination to the data pipeline
        // @ts-ignore
        pipeline.push({ $skip: skip }, { $limit: lim });
        const [docs, countResult] = await Promise.all([
            db.collection(REQUESTS_COL).aggregate(pipeline).toArray(),
            db.collection(REQUESTS_COL).aggregate(countPipeline).toArray(),
        ]);
        const total = countResult[0]?.total || 0;
        // @ts-ignore - TODO: strict typing
        res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /traces error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/traces/:id — single trace derived from requests ─
router.get("/traces/:id", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const requests = await db
            .collection(REQUESTS_COL)
            .find({ traceId: req.params.id })
            .toArray();
        if (requests.length === 0) {
            return res.status(404).json({ error: "Trace not found" });
        }
        // Derive trace metadata from requests
        const trace = {
            id: req.params.id,
            project: requests[0].project,
            username: requests[0].username,
            requestCount: requests.length,
            totalCost: requests.reduce(
            // @ts-ignore - TODO: strict typing
            (sum, r) => sum + (r.estimatedCost || 0), 
            // @ts-ignore - TODO: strict typing
            0),
            totalInputTokens: requests.reduce(
            // @ts-ignore - TODO: strict typing
            (sum, r) => sum + (r.inputTokens || 0), 
            // @ts-ignore - TODO: strict typing
            0),
            totalOutputTokens: requests.reduce(
            // @ts-ignore - TODO: strict typing
            (sum, r) => sum + (r.outputTokens || 0), 
            // @ts-ignore - TODO: strict typing
            0),
            createdAt: requests.reduce(
            // @ts-ignore - TODO: strict typing
            (min, r) => (!min || r.timestamp < min ? r.timestamp : min), null),
            updatedAt: requests.reduce(
            // @ts-ignore - TODO: strict typing
            (max, r) => (!max || r.timestamp > max ? r.timestamp : max), null),
            requests,
        };
        res.json(trace);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /traces/:id error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/sessions/:id/stats — aggregate stats for an agent session ─
router.get("/sessions/:id/stats", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const sessionId = req.params.id;
        // Recursively discover all descendant session IDs (multi-level workers)
        const allSessionIds = new Set([sessionId]);
        let frontier = [sessionId];
        for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
            const childIds = await db
                .collection(REQUESTS_COL)
                .distinct("agentSessionId", {
                parentAgentSessionId: { $in: frontier },
                agentSessionId: { $nin: [...allSessionIds] },
            });
            if (childIds.length === 0)
                break;
            const newIds = childIds.filter(Boolean);
            // @ts-ignore
            for (const id of newIds)
                allSessionIds.add(id);
            frontier = newIds;
        }
        const requests = await db
            .collection(REQUESTS_COL)
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
        })
            .toArray();
        if (requests.length === 0) {
            return res
                .status(404)
                .json({ error: "No requests found for this session" });
        }
        // Aggregate
        const providers = new Set();
        const models = new Set();
        const operations = new Set();
        let totalCost = 0;
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalCacheReadInputTokens = 0;
        let totalCacheCreationInputTokens = 0;
        let totalReasoningOutputTokens = 0;
        const mergedModalities = {};
        const toolCounts = {};
        // @ts-ignore
        for (const r of requests) {
            totalCost += r.estimatedCost || 0;
            totalInputTokens += r.inputTokens || 0;
            totalOutputTokens += r.outputTokens || 0;
            totalCacheReadInputTokens += r.cacheReadInputTokens || 0;
            totalCacheCreationInputTokens += r.cacheCreationInputTokens || 0;
            totalReasoningOutputTokens += r.reasoningOutputTokens || 0;
            if (r.provider)
                providers.add(r.provider);
            if (r.model)
                models.add(r.model);
            if (r.operation)
                operations.add(r.operation);
            // Merge modalities
            if (r.modalities) {
                // @ts-ignore
                for (const [k, v] of Object.entries(r.modalities)) {
                    // @ts-ignore
                    if (v)
                        mergedModalities[k] = true;
                }
            }
            // Count tool usage
            if (r.toolApiNames?.length > 0) {
                // @ts-ignore
                for (const name of r.toolApiNames) {
                    // @ts-ignore
                    toolCounts[name] = (toolCounts[name] || 0) + 1;
                }
            }
        }
        const workerRequestCount = requests.filter((r) => r.agentSessionId !== sessionId).length;
        const createdAt = requests.reduce(
        // @ts-ignore - TODO: strict typing
        (min, r) => (!min || r.timestamp < min ? r.timestamp : min), null);
        const updatedAt = requests.reduce(
        // @ts-ignore - TODO: strict typing
        (max, r) => (!max || r.timestamp > max ? r.timestamp : max), null);
        // Wall-clock elapsed time: from first request to last request (includes workers)
        const totalElapsedTime = createdAt && updatedAt
            ? Math.max(0, 
            // @ts-ignore - TODO: strict typing
            (new Date(updatedAt).getTime() - new Date(createdAt).getTime()) /
                1000)
            : 0;
        res.json({
            agentSessionId: sessionId,
            requestCount: requests.length,
            workerRequestCount,
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
            createdAt,
            updatedAt,
        });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /sessions/:id/stats error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/sessions/:id/requests — all requests for a session (recursive) ─
router.get("/sessions/:id/requests", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const rootSessionId = req.params.id;
        // Recursively discover all descendant session IDs by walking the
        // parentAgentSessionId chain. Each level's workers have their own
        // agentSessionId but reference the parent via parentAgentSessionId.
        const allSessionIds = new Set([rootSessionId]);
        let frontier = [rootSessionId];
        // Safety limit to prevent infinite loops (max 10 levels deep)
        for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
            // Find all requests whose parentAgentSessionId is in the current frontier
            const childRequests = await db
                .collection(REQUESTS_COL)
                .distinct("agentSessionId", {
                parentAgentSessionId: { $in: frontier },
                agentSessionId: { $nin: [...allSessionIds] },
            });
            if (childRequests.length === 0)
                break;
            const newIds = childRequests.filter(Boolean);
            // @ts-ignore
            for (const id of newIds)
                allSessionIds.add(id);
            frontier = newIds;
        }
        // Fetch all requests across all discovered session IDs
        const requests = await db
            .collection(REQUESTS_COL)
            .find({ agentSessionId: { $in: [...allSessionIds] } })
            .project({
            requestId: 1,
            timestamp: 1,
            provider: 1,
            model: 1,
            operation: 1,
            endpoint: 1,
            success: 1,
            errorMessage: 1,
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 1,
            cacheCreationInputTokens: 1,
            reasoningOutputTokens: 1,
            estimatedCost: 1,
            tokensPerSec: 1,
            totalTime: 1,
            toolsUsed: 1,
            toolDisplayNames: 1,
            toolApiNames: 1,
            modalities: 1,
            agentSessionId: 1,
            parentAgentSessionId: 1,
            traceId: 1,
            agent: 1,
        })
            .sort({ timestamp: 1 })
            .toArray();
        res.json({
            rootSessionId,
            sessionIds: [...allSessionIds],
            total: requests.length,
            requests,
        });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /sessions/:id/requests error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/agent-sessions — list all agent sessions (cross-user) ─
router.get("/agent-sessions", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const { page = 1, limit = 50, project, from, to, sort = "updatedAt", order = "desc", } = req.query;
        const filter = {};
        // @ts-ignore
        if (project)
            filter.project = project;
        if (from || to) {
            // @ts-ignore
            filter.updatedAt = {};
            // @ts-ignore
            if (from)
                filter.updatedAt.$gte = from;
            // @ts-ignore
            if (to)
                filter.updatedAt.$lte = to;
        }
        // @ts-ignore - TODO: strict typing
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        // @ts-ignore - TODO: strict typing
        const lim = parseInt(limit, 10);
        const sortDir = order === "asc" ? 1 : -1;
        const [docs, total] = await Promise.all([
            db
                .collection(COLLECTIONS.AGENT_SESSIONS)
                .find(filter, {
                // Exclude full message history for the list view — too heavy
                projection: { messages: 0 },
            })
                // @ts-ignore - TODO: strict typing
                .sort({ [sort]: sortDir })
                .skip(skip)
                .limit(lim)
                .toArray(),
            db.collection(COLLECTIONS.AGENT_SESSIONS).countDocuments(filter),
        ]);
        // @ts-ignore - TODO: strict typing
        res.json({ data: docs, total, page: parseInt(page, 10), limit: lim });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /agent-sessions error: ${error.message}`);
        next(error);
    }
}));
// ─── GET /admin/agent-sessions/:id — single agent session (with messages) ─
router.get("/agent-sessions/:id", asyncHandler(async (req, res, next) => {
    try {
        const db = MongoWrapper.getDb(MONGO_DB_NAME);
        if (!db)
            return res.status(503).json({ error: "Database not available" });
        const document = await db
            .collection(COLLECTIONS.AGENT_SESSIONS)
            .findOne({ id: req.params.id });
        if (!document)
            return res.status(404).json({ error: "Agent session not found" });
        res.json(document);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Admin /agent-sessions/:id error: ${error.message}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=AdminRoutes.js.map