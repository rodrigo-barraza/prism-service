// @ts-ignore
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express from "express";
import { basename } from "node:path";
// @ts-ignore
import { TOOLS_SERVICE_URL } from "../../config.js";
import ToolOrchestratorService from "../services/ToolOrchestratorService.js";
import logger from "../utils/logger.js";
const router = express.Router();
/**
 * GET /workspaces
 * Returns the list of configured workspace roots from tools-api.
 * Each entry has: { id, name, path, isPinned }
 *   - id: the full absolute path (used as stable identifier)
 *   - name: last path segment (e.g. "sun")
 *   - path: full absolute path
 *   - isPinned: true if from config.js (non-removable)
 *
 * Always refreshes from tools-api to pick up dynamically-registered
 * agent roots (workspace-service agents add roots at connection time).
 */
router.get("/", asyncHandler(async (_req, res) => {
    try {
        // Refresh from tools-api to pick up agent-registered roots
        await ToolOrchestratorService.refreshWorkspaceRoots();
        const roots = ToolOrchestratorService.getWorkspaceRoots();
        const staticRoots = ToolOrchestratorService.getStaticRoots();
        const workspaces = roots.map((rootPath) => ({
            id: rootPath,
            // @ts-ignore - TODO: strict typing
            name: basename(rootPath),
            path: rootPath,
            isPinned: staticRoots.includes(rootPath),
        }));
        res.json(workspaces);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`GET /workspaces error: ${error.message}`);
        res.status(500).json({ error: "Failed to retrieve workspace roots" });
    }
}));
/**
 * GET /workspaces/full
 * Returns the full workspace config including connected agent metadata.
 * Used by the Settings page for the richer workspace management UI.
 * Shape: { workspaces: [...], agents: [...], staticRoots: string[] }
 */
router.get("/full", asyncHandler(async (_req, res) => {
    try {
        const roots = ToolOrchestratorService.getWorkspaceRoots();
        const staticRoots = ToolOrchestratorService.getStaticRoots();
        // Fetch full config from tools-api to get agent metadata
        let agents = [];
        try {
            const configRes = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
                signal: AbortSignal.timeout(3000),
            });
            if (configRes.ok) {
                const config = await configRes.json();
                // @ts-ignore
                agents = config.agents || [];
            }
        }
        catch (agentErr) {
            logger.warn(
            // @ts-ignore - TODO: strict typing
            `GET /workspaces/full agent fetch failed: ${agentErr.message}`);
        }
        // Build a set of agent-served roots for quick lookup
        const agentRootSet = new Set();
        // @ts-ignore
        for (const agent of agents) {
            // @ts-ignore
            for (const root of agent.roots || []) {
                agentRootSet.add(root);
            }
        }
        const workspaces = roots.map((rootPath) => ({
            id: rootPath,
            // @ts-ignore - TODO: strict typing
            name: basename(rootPath),
            path: rootPath,
            isPinned: staticRoots.includes(rootPath),
            isAgentServed: agentRootSet.has(rootPath),
        }));
        res.json({ workspaces, agents, staticRoots });
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`GET /workspaces/full error: ${error.message}`);
        res
            .status(500)
            .json({ error: "Failed to retrieve full workspace config" });
    }
}));
/**
 * PUT /workspaces
 * Update user-configured workspace roots. Proxies to tools-api.
 * Body: { roots: string[] }
 * Returns the updated workspace list with isPinned metadata.
 */
router.put("/", asyncHandler(async (req, res) => {
    try {
        const result = await ToolOrchestratorService.updateWorkspaceRoots(req.body?.roots || []);
        res.json(result);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`PUT /workspaces error: ${error.message}`);
        res.status(500).json({ error: "Failed to update workspace roots" });
    }
}));
/**
 * POST /workspaces/validate
 * Validate a single workspace path without persisting.
 * Body: { path: string }
 */
router.post("/validate", asyncHandler(async (req, res) => {
    try {
        const result = await ToolOrchestratorService.validateWorkspacePath(req.body?.path);
        res.json(result);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`POST /workspaces/validate error: ${error.message}`);
        res.status(500).json({ error: "Failed to validate workspace path" });
    }
}));
/**
 * GET /workspaces/tree?path=...&maxDepth=...
 * Returns the directory tree for a workspace path.
 * Proxies to tools-service /agentic/project/summary which routes through
 * workspace-service agents via JSON-RPC (project.summary).
 */
router.get("/tree", asyncHandler(async (req, res) => {
    const { path: workspacePath, maxDepth } = req.query;
    if (!workspacePath) {
        return res
            .status(400)
            .json({ error: "'path' query parameter is required" });
    }
    try {
        const toolsRes = await fetch(`${TOOLS_SERVICE_URL}/agentic/project/summary`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                path: workspacePath,
                // @ts-ignore - TODO: strict typing
                maxDepth: maxDepth ? parseInt(maxDepth, 10) : 3,
            }),
            signal: AbortSignal.timeout(10_000),
        });
        if (!toolsRes.ok) {
            const errorBody = await toolsRes.json().catch(() => ({}));
            // @ts-ignore
            return res.status(toolsRes.status).json({
                // @ts-ignore
                error: errorBody.error || `tools-service returned ${toolsRes.status}`,
            });
        }
        const result = await toolsRes.json();
        res.json(result);
    }
    catch (error) {
        // @ts-ignore - TODO: strict typing
        logger.error(`GET /workspaces/tree error: ${error.message}`);
        res.status(500).json({ error: "Failed to fetch workspace tree" });
    }
}));
export default router;
//# sourceMappingURL=WorkspacesRoutes.js.map