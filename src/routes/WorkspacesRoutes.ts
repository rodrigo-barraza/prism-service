import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response } from "express";
import { basename } from "node:path";
import { TOOLS_SERVICE_URL } from "../../config.ts";
import ToolOrchestratorService from "../services/ToolOrchestratorService.ts";
import logger from "../utils/logger.ts";

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
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      // Refresh from tools-api to pick up agent-registered roots
      await ToolOrchestratorService.refreshWorkspaceRoots();

      const roots = ToolOrchestratorService.getWorkspaceRoots();
      const staticRoots = ToolOrchestratorService.getStaticRoots();

      const workspaces = roots.map((rootPath: any) => ({
        id: rootPath,
                name: basename((rootPath as any)),
        path: rootPath,
        isPinned: staticRoots.includes(rootPath),
      }));

      res.json(workspaces);
    } catch (error: any) {
            logger.error(`GET /workspaces error: ${(error as Error).message}`);
      res.status(500).json({ error: "Failed to retrieve workspace roots" });
    }
  }),
);

/**
 * GET /workspaces/full
 * Returns the full workspace config including connected agent metadata.
 * Used by the Settings page for the richer workspace management UI.
 * Shape: { workspaces: [...], agents: [...], staticRoots: string[] }
 */
router.get(
  "/full",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const roots = ToolOrchestratorService.getWorkspaceRoots();
      const staticRoots = ToolOrchestratorService.getStaticRoots();

      // Fetch full config from tools-api to get agent metadata
      let agents: any[] = [];
      try {
        const configRes = await fetch(`${TOOLS_SERVICE_URL}/admin/config`, {
          signal: AbortSignal.timeout(3000),
        });
        if (configRes.ok) {
          const config = await configRes.json();
                    agents = (config as any).agents || [];
        }
      } catch (agentErr: any) {
        logger.warn(
                    `GET /workspaces/full agent fetch failed: ${(agentErr as Error).message}`,
        );
      }

      // Build a set of agent-served roots for quick lookup
      const agentRootSet = new Set();
            for ( const agent of agents) {
                for ( const root of agent.roots || []) {
          agentRootSet.add(root);
        }
      }

      const workspaces = roots.map((rootPath: any) => ({
        id: rootPath,
                name: basename((rootPath as any)),
        path: rootPath,
        isPinned: staticRoots.includes(rootPath),
        isAgentServed: agentRootSet.has(rootPath),
      }));

      res.json({ workspaces, agents, staticRoots });
    } catch (error: any) {
            logger.error(`GET /workspaces/full error: ${(error as Error).message}`);
      res
        .status(500)
        .json({ error: "Failed to retrieve full workspace config" });
    }
  }),
);

/**
 * PUT /workspaces
 * Update user-configured workspace roots. Proxies to tools-api.
 * Body: { roots: string[] }
 * Returns the updated workspace list with isPinned metadata.
 */
router.put(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const result = await ToolOrchestratorService.updateWorkspaceRoots(
        req.body?.roots || [],
      );
      res.json(result);
    } catch (error: any) {
            logger.error(`PUT /workspaces error: ${(error as Error).message}`);
      res.status(500).json({ error: "Failed to update workspace roots" });
    }
  }),
);

/**
 * POST /workspaces/validate
 * Validate a single workspace path without persisting.
 * Body: { path: string }
 */
router.post(
  "/validate",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const result = await ToolOrchestratorService.validateWorkspacePath(
        req.body?.path,
      );
      res.json(result);
    } catch (error: any) {
            logger.error(`POST /workspaces/validate error: ${(error as Error).message}`);
      res.status(500).json({ error: "Failed to validate workspace path" });
    }
  }),
);

/**
 * GET /workspaces/tree?path=...&maxDepth=...
 * Returns the directory tree for a workspace path.
 * Proxies to tools-service /agentic/project/summary which routes through
 * workspace-service agents via JSON-RPC (project.summary).
 */
router.get(
  "/tree",
  asyncHandler(async (req: Request, res: Response) => {
    const { path: workspacePath, maxDepth } = req.query;
    if (!workspacePath) {
      return res
        .status(400)
        .json({ error: "'path' query parameter is required" });
    }

    try {
      const toolsRes = await fetch(
        `${TOOLS_SERVICE_URL}/agentic/project/summary`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: workspacePath,
                        maxDepth: maxDepth ? parseInt((maxDepth as any), 10) : 3,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!toolsRes.ok) {
        const errorBody = await toolsRes.json().catch(() => ({}));
                return res.status(toolsRes.status).json({
                    error: (errorBody as any).error || `tools-service returned ${toolsRes.status}`,
        });
      }

      const result = await toolsRes.json();
      res.json(result);
    } catch (error: any) {
            logger.error(`GET /workspaces/tree error: ${(error as Error).message}`);
      res.status(500).json({ error: "Failed to fetch workspace tree" });
    }
  }),
);

export default router;
