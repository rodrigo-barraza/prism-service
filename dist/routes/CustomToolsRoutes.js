import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { ObjectId } from "mongodb";
import requireDb from "../middleware/RequireDbMiddleware.js";
import logger from "../utils/logger.js";
import { COLLECTIONS } from "../constants.js";
const router = express.Router();
router.use(requireDb);
const COLLECTION = COLLECTIONS.CUSTOM_TOOLS;
/**
 * GET /custom-tools
 * List all custom tools for the given project + username.
 */
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        const { project, username, db } = req;
        const tools = await db
            .collection(COLLECTION)
            .find({ project, username })
            .sort({ createdAt: -1 })
            .toArray();
        res.json(tools.map((t) => ({ ...t, id: t._id.toString() })));
    }
    catch (error) {
        next(error);
    }
}));
/**
 * POST /custom-tools
 * Create a new custom tool.
 */
router.post("/", asyncHandler(async (req, res, next) => {
    try {
        const { project, username, db } = req;
        const document = {
            project,
            username,
            name: req.body.name,
            description: req.body.description || "",
            code: req.body.code || "",
            endpoint: req.body.endpoint || "",
            method: req.body.method || "GET",
            parameters: req.body.parameters || [],
            execution: req.body.execution === "privileged" ? "privileged" : "sandboxed",
            enabled: req.body.enabled !== false,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const result = await db.collection(COLLECTION).insertOne(document);
        logger.info(`Custom tool created: ${document.name} (${result.insertedId})`);
        res.status(201).json({ ...document, id: result.insertedId.toString() });
    }
    catch (error) {
        next(error);
    }
}));
/**
 * PUT /custom-tools/:id
 * Update an existing custom tool.
 */
router.put("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const updates = {
            ...(req.body.name !== undefined && { name: req.body.name }),
            ...(req.body.description !== undefined && {
                description: req.body.description,
            }),
            ...(req.body.code !== undefined && { code: req.body.code }),
            ...(req.body.endpoint !== undefined && { endpoint: req.body.endpoint }),
            ...(req.body.method !== undefined && { method: req.body.method }),
            ...(req.body.parameters !== undefined && {
                parameters: req.body.parameters,
            }),
            ...(req.body.execution !== undefined && {
                execution: req.body.execution === "privileged" ? "privileged" : "sandboxed",
            }),
            ...(req.body.enabled !== undefined && { enabled: req.body.enabled }),
            updatedAt: new Date(),
        };
        const result = await db
            .collection(COLLECTION)
            .findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: updates }, { returnDocument: "after" });
        if (!result) {
            return res.status(404).json({ error: "Tool not found" });
        }
        logger.info(`Custom tool updated: ${result.name} (${req.params.id})`);
        res.json({ ...result, id: result._id.toString() });
    }
    catch (error) {
        next(error);
    }
}));
/**
 * DELETE /custom-tools/:id
 * Delete a custom tool.
 */
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        const { db } = req;
        const result = await db
            .collection(COLLECTION)
            .findOneAndDelete({ _id: new ObjectId(req.params.id) });
        if (!result) {
            return res.status(404).json({ error: "Tool not found" });
        }
        logger.info(`Custom tool deleted: ${result.name} (${req.params.id})`);
        res.json({ success: true });
    }
    catch (error) {
        next(error);
    }
}));
export default router;
//# sourceMappingURL=CustomToolsRoutes.js.map