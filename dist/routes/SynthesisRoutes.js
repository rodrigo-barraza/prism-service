// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import requireDb from "../middleware/RequireDbMiddleware.js";
import logger from "../utils/logger.js";
import { COLLECTIONS } from "../constants.js";
const router = express.Router();
router.use(requireDb);
const COLLECTION = COLLECTIONS.SYNTHESIS;
/**
 * GET /synthesis
 * List all synthesis runs for the current project/user.
 */
router.get("/", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { project, username, db } = req;
        const runs = await db
            .collection(COLLECTION)
            .find({ project, username })
            .sort({ updatedAt: -1 })
            .toArray();
        res.json(runs);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error fetching synthesis runs: ${error.message}`);
        next(error);
    }
}));
/**
 * GET /synthesis/:id
 * Get a specific synthesis run.
 */
router.get("/:id", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { project, username, db } = req;
        const run = await db
            .collection(COLLECTION)
            .findOne({ id: req.params.id, project, username });
        if (!run) {
            return res.status(404).json({ error: "Synthesis run not found" });
        }
        res.json(run);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error fetching synthesis run: ${error.message}`);
        next(error);
    }
}));
/**
 * POST /synthesis
 * Create a new synthesis run.
 */
router.post("/", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { project, username, db } = req;
        const { id, title, systemPrompt, userPersona, category, targetTurns, seedMessages, settings, conversationId, } = req.body;
        if (!id) {
            return res.status(400).json({ error: "id is required" });
        }
        const now = new Date().toISOString();
        const document = {
            id,
            project,
            username,
            title: title || "Untitled Synthesis",
            systemPrompt: systemPrompt || "",
            userPersona: userPersona || "",
            category: category || "Chat",
            targetTurns: targetTurns || 4,
            seedMessages: seedMessages || [],
            settings: settings || {},
            conversationId: conversationId || null,
            createdAt: now,
            updatedAt: now,
        };
        await db.collection(COLLECTION).insertOne(document);
        res.json(document);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error creating synthesis run: ${error.message}`);
        next(error);
    }
}));
/**
 * PATCH /synthesis/:id
 * Update specific fields of a synthesis run.
 */
router.patch("/:id", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { project, username, db } = req;
        const allowedFields = [
            "title",
            "systemPrompt",
            "assistantPersona",
            "userPersona",
            "category",
            "targetTurns",
            "seedMessages",
            "settings",
            "conversationId",
        ];
        const setFields = { updatedAt: new Date().toISOString() };
        // @ts-ignore
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) {
                // @ts-ignore
                setFields[field] = req.body[field];
            }
        }
        const result = await db
            .collection(COLLECTION)
            .updateOne({ id: req.params.id, project, username }, { $set: setFields });
        if (result.matchedCount === 0) {
            return res.status(404).json({ error: "Synthesis run not found" });
        }
        const updated = await db
            .collection(COLLECTION)
            .findOne({ id: req.params.id, project, username });
        res.json(updated);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error patching synthesis run: ${error.message}`);
        next(error);
    }
}));
/**
 * DELETE /synthesis/:id
 * Delete a specific synthesis run.
 */
router.delete("/:id", asyncHandler(async (req, res, next) => {
    try {
        // @ts-ignore - TODO: strict typing
        const { project, username, db } = req;
        const result = await db
            .collection(COLLECTION)
            .deleteOne({ id: req.params.id, project, username });
        if (result.deletedCount === 0) {
            return res.status(404).json({ error: "Synthesis run not found" });
        }
        res.json({ success: true, id: req.params.id });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`Error deleting synthesis run: ${error.message}`);
        next(error);
    }
}));
export default router;
//# sourceMappingURL=SynthesisRoutes.js.map