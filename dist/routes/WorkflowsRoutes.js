import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router } from "express";
import { ObjectId } from "mongodb";
import logger from "../utils/logger.js";
import requireDb from "../middleware/RequireDbMiddleware.js";
import FileService from "../services/FileService.js";
import MinioWrapper from "../wrappers/MinioWrapper.js";
import { assembleGraph } from "../services/WorkflowAssembler.js";
import { COLLECTIONS } from "../constants.js";
const router = Router();
router.use(requireDb);
const WORKFLOWS_COL = COLLECTIONS.WORKFLOWS;
/** Media fields on messages that may contain base64 data URLs. */
const MEDIA_FIELDS = ["images", "audio", "video", "pdf"];
/**
 * Upload a single value if it's a base64 data URL, returning the minio:// ref.
 * Non-data-URL strings (minio://, http://, etc.) pass through unchanged.
 */
async function uploadIfDataUrl(value, category = "uploads", project = null, username = null) {
    if (typeof value === "string" && value.startsWith("data:")) {
        try {
            const { ref } = await FileService.uploadFile(value, category, project, username);
            return ref;
        }
        catch (error) {
            logger.error(`Workflow file upload failed: ${error.message}`);
            return value;
        }
    }
    return value;
}
/**
 * Walk all workflow nodes and upload any base64 data URLs to MinIO,
 * replacing them with minio:// refs.  Mirrors the extractFiles pattern
 * used by ConversationService for chat messages.
 */
async function extractWorkflowFiles(nodes, project = null, username = null) {
    if (!Array.isArray(nodes) || !FileService.isExternalStorage())
        return nodes;
    const processed = [];
    for (const node of nodes) {
        const updated = { ...node };
        // 1. Node-level content (asset input nodes store content as a data URL)
        if (typeof updated.content === "string" &&
            updated.content.startsWith("data:")) {
            updated.content = await uploadIfDataUrl(updated.content, "uploads", project, username);
        }
        // 2. Messages array (conversation / model nodes)
        if (Array.isArray(updated.messages)) {
            const newMessages = [];
            for (const message of updated.messages) {
                const m = { ...message };
                for (const field of MEDIA_FIELDS) {
                    const value = m[field];
                    if (Array.isArray(value)) {
                        const array = [];
                        for (const item of value) {
                            array.push(await uploadIfDataUrl(item, "uploads", project, username));
                        }
                        m[field] = array;
                    }
                    else if (typeof value === "string" && value.startsWith("data:")) {
                        m[field] = await uploadIfDataUrl(value, "uploads", project, username);
                    }
                }
                newMessages.push(m);
            }
            updated.messages = newMessages;
        }
        // 3. Viewer nodes store receivedOutputs — same { modality: data } shape
        if (updated.receivedOutputs &&
            typeof updated.receivedOutputs === "object") {
            const newReceived = {};
            for (const [mod, data] of Object.entries(updated.receivedOutputs)) {
                newReceived[mod] = await uploadIfDataUrl(data, "uploads", project, username);
            }
            updated.receivedOutputs = newReceived;
        }
        processed.push(updated);
    }
    return processed;
}
/**
 * Walk nodeResults and upload any base64 data URLs to MinIO.
 * Shape: { [nodeId]: { [modality]: dataUrl | messagesArray } }
 */
async function extractNodeResultFiles(nodeResults, project = null, username = null) {
    if (!nodeResults ||
        typeof nodeResults !== "object" ||
        !FileService.isExternalStorage())
        return nodeResults;
    const processed = {};
    for (const [nodeId, outputs] of Object.entries(nodeResults)) {
        if (!outputs || typeof outputs !== "object") {
            processed[nodeId] = outputs;
            continue;
        }
        const newOutputs = {};
        for (const [mod, data] of Object.entries(outputs)) {
            // conversation modality is an array of message objects with nested media
            if (mod === "conversation" && Array.isArray(data)) {
                const msgs = [];
                for (const message of data) {
                    const m = { ...message };
                    for (const field of MEDIA_FIELDS) {
                        const value = m[field];
                        if (Array.isArray(value)) {
                            const array = [];
                            for (const item of value) {
                                array.push(await uploadIfDataUrl(item, "uploads", project, username));
                            }
                            m[field] = array;
                        }
                        else if (typeof value === "string" && value.startsWith("data:")) {
                            m[field] = await uploadIfDataUrl(value, "uploads", project, username);
                        }
                    }
                    msgs.push(m);
                }
                newOutputs[mod] = msgs;
            }
            else {
                newOutputs[mod] = await uploadIfDataUrl(data, "uploads", project, username);
            }
        }
        processed[nodeId] = newOutputs;
    }
    return processed;
}
/**
 * Convert a minio:// ref to an HTTP /files/ URL.
 * Non-minio strings (data URLs, http URLs, etc.) pass through unchanged.
 */
function resolveMinioRef(value, baseUrl) {
    if (typeof value === "string" && value.startsWith("minio://")) {
        const key = value.replace("minio://", "");
        // Use direct MinIO URL when available, otherwise proxy through Prism
        const minioBase = MinioWrapper.getBucketUrl();
        if (minioBase)
            return `${minioBase}/${key}`;
        return `${baseUrl}/files/${key}`;
    }
    return value;
}
/**
 * Walk a workflow document and replace all minio:// refs with HTTP /files/ URLs
 * so the frontend receives browser-renderable URLs directly.
 */
function resolveWorkflowFileRefs(workflow, baseUrl) {
    // Resolve nodes
    if (Array.isArray(workflow.nodes)) {
        for (const node of workflow.nodes) {
            // Node-level content (asset input nodes)
            if (typeof node.content === "string") {
                node.content = resolveMinioRef(node.content, baseUrl);
            }
            // Messages array (conversation / model nodes)
            if (Array.isArray(node.messages)) {
                for (const message of node.messages) {
                    for (const field of MEDIA_FIELDS) {
                        const value = message[field];
                        if (Array.isArray(value)) {
                            message[field] = value.map((item) => resolveMinioRef(item, baseUrl));
                        }
                        else if (typeof value === "string") {
                            message[field] = resolveMinioRef(value, baseUrl);
                        }
                    }
                }
            }
            // Viewer receivedOutputs
            if (node.receivedOutputs && typeof node.receivedOutputs === "object") {
                for (const [mod, data] of Object.entries(node.receivedOutputs)) {
                    node.receivedOutputs[mod] = resolveMinioRef(data, baseUrl);
                }
            }
        }
    }
    // Resolve nodeResults: { [nodeId]: { [modality]: value | messagesArray } }
    if (workflow.nodeResults && typeof workflow.nodeResults === "object") {
        for (const outputs of Object.values(workflow.nodeResults)) {
            if (!outputs || typeof outputs !== "object")
                continue;
            for (const [mod, data] of Object.entries(outputs)) {
                // conversation modality is an array of message objects with nested media
                if (mod === "conversation" && Array.isArray(data)) {
                    for (const message of data) {
                        for (const field of MEDIA_FIELDS) {
                            const value = message[field];
                            if (Array.isArray(value)) {
                                message[field] = value.map((item) => resolveMinioRef(item, baseUrl));
                            }
                            else if (typeof value === "string") {
                                message[field] = resolveMinioRef(value, baseUrl);
                            }
                        }
                    }
                }
                else {
                    outputs[mod] = resolveMinioRef(data, baseUrl);
                }
            }
        }
    }
    return workflow;
}
/**
 * Build the external base URL from the request (handles proxies, HTTPS, etc.).
 */
function getBaseUrl(req) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
    const host = req.headers["x-forwarded-host"] || req.get("host");
    return `${proto}://${host}`;
}
/**
 * Compute list-display metadata from workflow nodes.
 * Single source of truth for providers and modalities.
 * Cost is computed separately from linked conversations (PATCH endpoint).
 */
function computeWorkflowMeta(nodes) {
    const providers = [
        ...new Set((nodes || [])
            .filter((n) => !n.nodeType && n.provider)
            .map((n) => n.provider)),
    ];
    const modalities = {};
    for (const n of nodes || []) {
        // Only include boundary nodes: input assets define workflow inputs,
        // viewer nodes define workflow outputs
        if (n.nodeType === "input") {
            for (const t of n.outputTypes || [])
                modalities[`${t}In`] = true;
        }
        else if (n.nodeType === "viewer") {
            for (const t of n.inputTypes || [])
                modalities[`${t}Out`] = true;
        }
    }
    return { providers, modalities };
}
/**
 * GET /workflows
 * List all saved workflows (metadata only).
 */
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const source = req.query.source || "prism-client";
        const query = source === "all" ? {} : { source };
        const workflows = await db
            .collection(WORKFLOWS_COL)
            .find(query)
            .sort({ updatedAt: -1 })
            .project({ nodes: 0, edges: 0, nodeResults: 0, nodeStatuses: 0 })
            .toArray();
        res.json(workflows);
    }
    catch (error) {
        logger.error(`GET /workflows error: ${error.message}`);
        next(error);
    }
}));
/**
 * GET /workflows/:id
 * Get a single workflow by ID (full document).
 */
router.get("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        }
        catch {
            filter = { workflowId: req.params.id };
        }
        const workflow = await db.collection(WORKFLOWS_COL).findOne(filter);
        if (!workflow)
            return res.status(404).json({ error: "Workflow not found" });
        const baseUrl = getBaseUrl(req);
        resolveWorkflowFileRefs(workflow, baseUrl);
        res.json(workflow);
    }
    catch (error) {
        logger.error(`GET /workflows/:id error: ${error.message}`);
        next(error);
    }
}));
/**
 * POST /workflows
 * Save a new workflow document.
 *
 * Accepts two payload formats:
 * 1. Raw steps (from Lupos/bots): { steps, messageId, ... }
 *    → Prism assembles the visual graph using WorkflowAssembler
 * 2. Pre-built graph (from Prism Client editor): { nodes, edges, ... }
 *    → Passes through unchanged
 */
router.post("/", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const project = req.project;
        const username = req.username || null;
        let { nodes, edges, nodeResults } = req.body;
        // If the payload has steps but no pre-built nodes, assemble the graph
        if (Array.isArray(req.body.steps) &&
            req.body.steps.length > 0 &&
            !Array.isArray(nodes)) {
            const graph = assembleGraph(req.body.steps);
            nodes = graph.nodes;
            edges = graph.edges;
            nodeResults = graph.nodeResults;
        }
        const processedNodes = await extractWorkflowFiles(nodes, project, username);
        const processedResults = await extractNodeResultFiles(nodeResults, project, username);
        const now = new Date().toISOString();
        const finalNodes = processedNodes || nodes;
        const meta = computeWorkflowMeta(finalNodes);
        // Compute totalCost from linked conversations (source of truth for cost)
        let totalCost = 0;
        const convIds = req.body.conversationIds;
        if (Array.isArray(convIds) && convIds.length > 0) {
            const conversations = await db
                .collection(COLLECTIONS.CONVERSATIONS)
                .find({ id: { $in: convIds } })
                .project({ totalCost: 1 })
                .toArray();
            totalCost = conversations.reduce((sum, c) => sum + (c.totalCost || 0), 0);
        }
        const workflow = {
            ...req.body,
            nodes: finalNodes,
            edges: edges || req.body.edges,
            nodeResults: processedResults || nodeResults,
            source: req.body.source || "prism-client",
            nodeCount: Array.isArray(finalNodes) ? finalNodes.length : 0,
            edgeCount: Array.isArray(edges) ? edges.length : 0,
            ...meta,
            totalCost,
            createdAt: now,
            updatedAt: now,
        };
        const result = await db.collection(WORKFLOWS_COL).insertOne(workflow);
        res.json({ success: true, id: result.insertedId.toString() });
    }
    catch (error) {
        logger.error(`POST /workflows error: ${error.message}`);
        next(error);
    }
}));
/**
 * PUT /workflows/:id
 * Update an existing workflow.
 */
router.put("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        }
        catch {
            filter = { workflowId: req.params.id };
        }
        const project = req.project;
        const username = req.username || null;
        const body = { ...req.body };
        if (Array.isArray(body.nodes)) {
            body.nodes = await extractWorkflowFiles(body.nodes, project, username);
            body.nodeCount = body.nodes.length;
            // Recompute metadata
            Object.assign(body, computeWorkflowMeta(body.nodes));
        }
        if (body.nodeResults && typeof body.nodeResults === "object") {
            body.nodeResults = await extractNodeResultFiles(body.nodeResults, project, username);
        }
        if (Array.isArray(body.edges))
            body.edgeCount = body.edges.length;
        const update = {
            $set: {
                ...body,
                updatedAt: new Date().toISOString(),
            },
        };
        delete update.$set._id; // prevent overwriting _id
        const result = await db
            .collection(WORKFLOWS_COL)
            .updateOne(filter, update);
        if (result.matchedCount === 0)
            return res.status(404).json({ error: "Workflow not found" });
        res.json({ success: true });
    }
    catch (error) {
        logger.error(`PUT /workflows/:id error: ${error.message}`);
        next(error);
    }
}));
/**
 * PATCH /workflows/:id/conversations
 * Append conversation IDs generated during workflow execution.
 * Body: { conversationIds: string[] }
 */
router.patch("/:id/conversations", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        }
        catch {
            filter = { workflowId: req.params.id };
        }
        const { conversationIds } = req.body;
        if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
            return res
                .status(400)
                .json({ error: "conversationIds array required" });
        }
        const result = await db.collection(WORKFLOWS_COL).updateOne(filter, {
            $push: { conversationIds: { $each: conversationIds } },
            $set: { updatedAt: new Date().toISOString() },
        });
        if (result.matchedCount === 0)
            return res.status(404).json({ error: "Workflow not found" });
        // Recompute totalCost from all linked conversations
        // Conversations are the source of truth for cost (they track estimatedCost per message)
        const workflow = await db.collection(WORKFLOWS_COL).findOne(filter);
        const allConvIds = workflow?.conversationIds || [];
        if (allConvIds.length > 0) {
            const conversations = await db
                .collection(COLLECTIONS.CONVERSATIONS)
                .find({ id: { $in: allConvIds } })
                .project({ totalCost: 1 })
                .toArray();
            const totalCost = conversations.reduce((sum, c) => sum + (c.totalCost || 0), 0);
            await db.collection(WORKFLOWS_COL).updateOne(filter, {
                $set: { totalCost },
            });
        }
        res.json({ success: true });
    }
    catch (error) {
        logger.error(`PATCH /workflows/:id/conversations error: ${error.message}`);
        next(error);
    }
}));
/**
 * DELETE /workflows/:id
 * Delete a workflow by ID.
 */
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        let filter;
        try {
            filter = { _id: new ObjectId(req.params.id) };
        }
        catch {
            filter = { workflowId: req.params.id };
        }
        await db.collection(WORKFLOWS_COL).deleteOne(filter);
        res.json({ success: true });
    }
    catch (error) {
        logger.error(`DELETE /workflows/:id error: ${error.message}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=WorkflowsRoutes.js.map