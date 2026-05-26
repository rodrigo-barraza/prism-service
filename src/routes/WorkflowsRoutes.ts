import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { Router, Request, Response, NextFunction } from "express";
import { ObjectId, type Document, type Db } from "mongodb";
import logger from "../utils/logger.ts";
import requireDb from "../middleware/RequireDbMiddleware.ts";
import FileService from "../services/FileService.ts";
import MinioWrapper from "../wrappers/MinioWrapper.ts";
import { assembleGraph } from "../services/WorkflowAssembler.ts";
import { COLLECTIONS } from "../constants.ts";


interface CustomRequest extends Request {
  db: Db;
  project?: string;
  username?: string;
}

const router = Router();
router.use(requireDb);

const WORKFLOWS_COL = COLLECTIONS.WORKFLOWS;

/** Media fields on messages that may contain base64 data URLs. */
const MEDIA_FIELDS = ["images", "audio", "video", "pdf"];

/**
 * Upload a single value if it's a base64 data URL, returning the minio:// ref.
 * Non-data-URL strings (minio://, http://, etc.) pass through unchanged.
 */
async function uploadIfDataUrl(
  value: unknown,
  category = "uploads",
  project: string | null = null,
  username: string | null = null,
) {
  if (typeof value === "string" && value.startsWith("data:")) {
    try {
      const { ref } = await FileService.uploadFile(
        value,
        category,
        project,
        username,
      );
      return ref;
    } catch (error: unknown) {
      logger.error(`Workflow file upload failed: ${(error as Error).message}`);
      return value;
    }
  }
  return value;
}

/**
 * Walk all workflow nodes and upload any base64 data URLs to MinIO,
 * replacing them with minio:// refs. Mirrors the extractFiles pattern
 * used by ConversationService for chat messages.
 */
async function extractWorkflowFiles(
  nodes: unknown[],
  project: string | null = null,
  username: string | null = null,
) {
  if (!Array.isArray(nodes) || !FileService.isExternalStorage()) return nodes;

  const processed: Record<string, unknown>[] = [];
  for (const node of nodes) {
    const updated = { ...(node as Record<string, unknown>) };

    // 1. Node-level content (asset input nodes store content as a data URL)
    if (
      typeof updated.content === "string" &&
      updated.content.startsWith("data:")
    ) {
      updated.content = await uploadIfDataUrl(
        updated.content,
        "uploads",
        project,
        username,
      );
    }

    // 2. Messages array (conversation / model nodes)
    if (Array.isArray(updated.messages)) {
      const newMessages: Record<string, unknown>[] = [];
      for (const message of updated.messages) {
        const sanitizedMessage = { ...(message as Record<string, unknown>) };
        for (const field of MEDIA_FIELDS) {
          const value = sanitizedMessage[field];
          if (Array.isArray(value)) {
            const array: string[] = [];
            for (const item of value) {
              array.push(
                await uploadIfDataUrl(item, "uploads", project, username) as string,
              );
            }
            sanitizedMessage[field] = array;
          } else if (typeof value === "string" && value.startsWith("data:")) {
            sanitizedMessage[field] = await uploadIfDataUrl(value, "uploads", project, username);
          }
        }
        newMessages.push(sanitizedMessage);
      }
      updated.messages = newMessages;
    }

    // 3. Viewer nodes store receivedOutputs — same { modality: data } shape
    if (
      updated.receivedOutputs &&
      typeof updated.receivedOutputs === "object"
    ) {
      const newReceived: Record<string, unknown> = {};
      for (const [modObject, data] of Object.entries(updated.receivedOutputs)) {
        newReceived[modObject] = await uploadIfDataUrl(
          data,
          "uploads",
          project,
          username,
        );
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
async function extractNodeResultFiles(
  nodeResults: Record<string, unknown>,
  project: string | null = null,
  username: string | null = null,
) {
  if (
    !nodeResults ||
    typeof nodeResults !== "object" ||
    !FileService.isExternalStorage()
  ) {
    return nodeResults;
  }

  const processed: Record<string, unknown> = {};
  for (const [nodeId, outputs] of Object.entries(nodeResults)) {
    if (!outputs || typeof outputs !== "object") {
      processed[nodeId] = outputs;
      continue;
    }
    const newOutputs: Record<string, unknown> = {};
    for (const [modObject, data] of Object.entries(outputs)) {
      // conversation modality is an array of message objects with nested media
      if (modObject === "conversation" && Array.isArray(data)) {
        const msgs: Record<string, unknown>[] = [];
        for (const message of data) {
          const sanitizedMessage = { ...(message as Record<string, unknown>) };
          for (const field of MEDIA_FIELDS) {
            const value = sanitizedMessage[field];
            if (Array.isArray(value)) {
              const array: string[] = [];
              for (const item of value) {
                array.push(
                  await uploadIfDataUrl(item, "uploads", project, username) as string,
                );
              }
              sanitizedMessage[field] = array;
            } else if (typeof value === "string" && value.startsWith("data:")) {
              sanitizedMessage[field] = await uploadIfDataUrl(
                value,
                "uploads",
                project,
                username,
              );
            }
          }
          msgs.push(sanitizedMessage);
        }
        newOutputs[modObject] = msgs;
      } else {
        newOutputs[modObject] = await uploadIfDataUrl(
          data,
          "uploads",
          project,
          username,
        );
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
function resolveMinioRef(value: unknown, baseUrl: string) {
  if (typeof value === "string" && value.startsWith("minio://")) {
    const key = value.replace("minio://", "");
    // Use direct MinIO URL when available, otherwise proxy through Prism
    const minioBase = MinioWrapper.getBucketUrl();
    if (minioBase) return `${minioBase}/${key}`;
    return `${baseUrl}/files/${key}`;
  }
  return value;
}

/**
 * Walk a workflow document and replace all minio:// refs with HTTP /files/ URLs
 * so the frontend receives browser-renderable URLs directly.
 */
function resolveWorkflowFileRefs(workflow: Record<string, unknown>, baseUrl: string) {
  // Resolve nodes
  if (Array.isArray(workflow.nodes)) {
    for (const node of workflow.nodes) {
      // Node-level content (asset input nodes)
      if (typeof (node as Record<string, unknown>).content === "string") {
        (node as Record<string, unknown>).content = resolveMinioRef((node as Record<string, unknown>).content, baseUrl);
      }

      // Messages array (conversation / model nodes)
      if (Array.isArray((node as Record<string, unknown>).messages)) {
        for (const message of ((node as Record<string, unknown>).messages as Record<string, unknown>[])) {
          for (const field of MEDIA_FIELDS) {
            const value = (message as Record<string, unknown>)[field];
            if (Array.isArray(value)) {
              (message as Record<string, unknown>)[field] = value.map((item: unknown) =>
                resolveMinioRef(item, baseUrl),
              );
            } else if (typeof value === "string") {
              (message as Record<string, unknown>)[field] = resolveMinioRef(value, baseUrl);
            }
          }
        }
      }

      // Viewer receivedOutputs
      if ((node as Record<string, unknown>).receivedOutputs && typeof (node as Record<string, unknown>).receivedOutputs === "object") {
        for (const [modObject, data] of Object.entries((node as Record<string, unknown>).receivedOutputs as Record<string, unknown>)) {
          ((node as Record<string, unknown>).receivedOutputs as Record<string, unknown>)[modObject] = resolveMinioRef(data, baseUrl);
        }
      }
    }
  }

  // Resolve nodeResults: { [nodeId]: { [modality]: value | messagesArray } }
  if (workflow.nodeResults && typeof workflow.nodeResults === "object") {
    for (const outputs of Object.values(workflow.nodeResults) as Record<string, unknown>[]) {
      if (!outputs || typeof outputs !== "object") continue;
      for (const [modObject, data] of Object.entries(outputs)) {
        // conversation modality is an array of message objects with nested media
        if (modObject === "conversation" && Array.isArray(data)) {
          for (const message of data) {
            for (const field of MEDIA_FIELDS) {
              const value = (message as Record<string, unknown>)[field];
              if (Array.isArray(value)) {
                (message as Record<string, unknown>)[field] = value.map((item: unknown) =>
                  resolveMinioRef(item, baseUrl),
                );
              } else if (typeof value === "string") {
                (message as Record<string, unknown>)[field] = resolveMinioRef(value, baseUrl);
              }
            }
          }
        } else {
          (outputs as Record<string, unknown>)[modObject] = resolveMinioRef(data, baseUrl);
        }
      }
    }
  }

  return workflow;
}

function getBaseUrl(req: Request) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

/**
 * Compute list-display metadata from workflow nodes.
 * Single source of truth for providers and modalities.
 * Cost is computed separately from linked conversations (PATCH endpoint).
 */
function computeWorkflowMeta(nodes: Record<string, unknown>[]) {
  const providers = [
    ...new Set(
      (nodes || [])
        .filter((n: Record<string, unknown>) => !n.nodeType && n.provider)
        .map((n: Record<string, unknown>) => n.provider as string),
    ),
  ];
  const modalities: Record<string, boolean> = {};
  for (const n of nodes || []) {
    // Only include boundary nodes: input assets define workflow inputs,
    // viewer nodes define workflow outputs
    if (n.nodeType === "input") {
      for (const t of (n.outputTypes as string[]) || []) modalities[`${t}In`] = true;
    } else if (n.nodeType === "viewer") {
      for (const t of (n.inputTypes as string[]) || []) modalities[`${t}Out`] = true;
    }
  }
  return { providers, modalities };
}

/**
 * GET /workflows
 * List all saved workflows (metadata only).
 */
router.get(
  "/",
  asyncHandler(async (req: CustomRequest, res: Response, next: NextFunction) => {
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
    } catch (error: unknown) {
            logger.error(`GET /workflows error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * GET /workflows/:id
 * Get a single workflow by ID (full document).
 */
router.get(
  "/:id",
  asyncHandler(async (req: CustomRequest, res: Response, next: NextFunction) => {
    try {
            const { db } = req;

      let filter: Record<string, unknown>;
      try {
                filter = { _id: new ObjectId(req.params.id as string) };
      } catch {
        filter = { workflowId: req.params.id };
      }

      const workflow = await db.collection(WORKFLOWS_COL).findOne(filter);
      if (!workflow)
        return res.status(404).json({ error: "Workflow not found" });

      const baseUrl = getBaseUrl(req);
            resolveWorkflowFileRefs(workflow, baseUrl);

      res.json(workflow);
    } catch (error: unknown) {
            logger.error(`GET /workflows/:id error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

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
router.post(
  "/",
  asyncHandler(async (req: CustomRequest, res: Response, next: NextFunction) => {
    try {
            const { db } = req;

      const project = req.project;
      const username = req.username || null;

      let { nodes, edges, nodeResults } = req.body;

      // If the payload has steps but no pre-built nodes, assemble the graph
      if (
        Array.isArray(req.body.steps) &&
        req.body.steps.length > 0 &&
        !Array.isArray(nodes)
      ) {
        const graph = assembleGraph(req.body.steps);
        nodes = graph.nodes;
        edges = graph.edges;
        nodeResults = graph.nodeResults;
      }

      const processedNodes = await extractWorkflowFiles(
        nodes,
                project,
        username,
      );
      const processedResults = await extractNodeResultFiles(
        nodeResults,
                project,
        username,
      );

      const now = new Date().toISOString();
      const finalNodes = processedNodes || nodes;

            const meta = computeWorkflowMeta(finalNodes as Record<string, unknown>[]);

      // Compute totalCost from linked conversations (source of truth for cost)
      let totalCost = 0;
      const convIds = req.body.conversationIds;
      if (Array.isArray(convIds) && convIds.length > 0) {
        const conversations = await db
          .collection(COLLECTIONS.MODEL_CONVERSATIONS)
          .find({ id: { $in: convIds } })
          .project({ totalCost: 1 })
          .toArray();
        totalCost = conversations.reduce(
                    (sum: number, c: Record<string, unknown>) => sum + ((c.totalCost as number) || 0),
          0,
        );
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
    } catch (error: unknown) {
            logger.error(`POST /workflows error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * PUT /workflows/:id
 * Update an existing workflow.
 */
router.put(
  "/:id",
  asyncHandler(async (req: CustomRequest, res: Response, next: NextFunction) => {
    try {
            const { db } = req;

      let filter: Record<string, unknown>;
      try {
                filter = { _id: new ObjectId(req.params.id as string) };
      } catch {
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
        body.nodeResults = await extractNodeResultFiles(
          body.nodeResults,
                    project,
          username,
        );
      }
      if (Array.isArray(body.edges)) body.edgeCount = body.edges.length;
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
    } catch (error: unknown) {
            logger.error(`PUT /workflows/:id error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

/**
 * PATCH /workflows/:id/conversations
 * Append conversation IDs generated during workflow execution.
 * Body: { conversationIds: string[] }
 */
router.patch(
  "/:id/conversations",
  asyncHandler(async (req: CustomRequest, res: Response, next: NextFunction) => {
    try {
            const { db } = req;

      let filter: Record<string, unknown>;
      try {
                filter = { _id: new ObjectId(req.params.id as string) };
      } catch {
        filter = { workflowId: req.params.id };
      }

      const { conversationIds } = req.body;
      if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
        return res
          .status(400)
          .json({ error: "conversationIds array required" });
      }

      const result = await db.collection(WORKFLOWS_COL).updateOne(filter, {
        // MongoDB PushOperator typing is overly strict for dynamic schemas — cast to Document
        $push: { conversationIds: { $each: conversationIds } } as Document,
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
          .collection(COLLECTIONS.MODEL_CONVERSATIONS)
          .find({ id: { $in: allConvIds } })
          .project({ totalCost: 1 })
          .toArray();
        const totalCost = conversations.reduce(
                    (sum: number, c: Record<string, unknown>) => sum + ((c.totalCost as number) || 0),
          0,
        );
        await db.collection(WORKFLOWS_COL).updateOne(filter, {
          $set: { totalCost },
        });
      }

      res.json({ success: true });
    } catch (error: unknown) {
      logger.error(
                `PATCH /workflows/:id/conversations error: ${(error as Error).message}`,
      );
      next(error);
    }
  }),
);

/**
 * DELETE /workflows/:id
 * Delete a workflow by ID.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: CustomRequest, res: Response, next: NextFunction) => {
    try {
            const { db } = req;

      let filter: Record<string, unknown>;
      try {
                filter = { _id: new ObjectId(req.params.id as string) };
      } catch {
        filter = { workflowId: req.params.id };
      }

      await db.collection(WORKFLOWS_COL).deleteOne(filter);
      res.json({ success: true });
    } catch (error: unknown) {
            logger.error(`DELETE /workflows/:id error: ${(error as Error).message}`);
      next(error);
    }
  }),
);

export default router;
