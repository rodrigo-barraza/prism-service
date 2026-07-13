import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { Request, Response } from "express";
import { basename } from "node:path";
import { TOOLS_SERVICE_URL } from "#config";
import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import logger from "#src/utils/logger";
import {
  PutWorkspacesSchema,
  ValidateWorkspaceSchema,
} from "#src/types/index";
import { getErrorMessage } from "#src/utils/ErrorHelpers";
import { TOOL_CONFIG_FETCH_TIMEOUT_MILLISECONDS } from "#src/constants";

const router = express.Router();

interface MappedWorkspace {
  id: string;
  name: string;
  path: string;
  isAgentServed: boolean;
  agentId: string | null;
  agentName: string | null;
  hostname: string | null;
  platform: string | null;
  arch: string | null;
  clientIp: string | null;
}

function disambiguateWorkspaceNames(workspaces: MappedWorkspace[]): void {
  const nameOccurrences = new Map<string, MappedWorkspace[]>();
  for (const workspace of workspaces) {
    const normalizedName = workspace.name.toLowerCase();
    if (!nameOccurrences.has(normalizedName)) {
      nameOccurrences.set(normalizedName, []);
    }
    nameOccurrences.get(normalizedName)!.push(workspace);
  }

  for (const [, duplicates] of nameOccurrences) {
    if (duplicates.length <= 1) continue;

    for (const workspace of duplicates) {
      if (workspace.hostname) {
        workspace.name = `${workspace.name} (${workspace.hostname})`;
      } else if (
        workspace.agentName &&
        workspace.agentName !== workspace.name
      ) {
        workspace.name = `${workspace.name} (${workspace.agentName})`;
      } else {
        const parentSegment = workspace.path
          .split("/")
          .filter(Boolean)
          .slice(-2, -1)[0];
        if (parentSegment) {
          workspace.name = `${workspace.name} (${parentSegment})`;
        }
      }
    }
  }
}

interface WorkspaceAgent {
  id: string;
  name: string;
  roots?: string[];
  displayRoots?: string[];
  [key: string]: unknown;
}

interface WorkspaceConfig {
  agents?: WorkspaceAgent[];
  [key: string]: unknown;
}

/**
 * GET /workspaces
 * Returns the list of workspace roots from connected agents.
 * Each entry has: { id, name, path, isAgentServed, agentId, ... }
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

      let connectedAgents: WorkspaceAgent[] = [];
      try {
        const configApiResponse = await fetch(
          `${TOOLS_SERVICE_URL}/admin/config`,
          {
            signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MILLISECONDS),
          },
        );
        if (configApiResponse.ok) {
          const workspaceConfig =
            (await configApiResponse.json()) as WorkspaceConfig;
          connectedAgents = workspaceConfig.agents || [];
        }
      } catch (error: unknown) {
        logger.warn(
          `GET /workspaces agent fetch failed: ${getErrorMessage(error)}`,
        );
      }

      // Build workspace entries from each agent's displayRoots so that
      // multiple agents sharing the same raw root (e.g. both "/") each
      // contribute distinct workspace entries to the selector.
      const agentServedWorkspaces: MappedWorkspace[] = [];
      for (const agent of connectedAgents) {
        const displayPaths =
          agent.displayRoots && agent.displayRoots.length > 0
            ? agent.displayRoots
            : agent.roots || [];
        const machineInfo =
          (agent as WorkspaceAgent & { machineInfo?: Record<string, unknown> })
            ?.machineInfo || null;
        for (const displayPath of displayPaths) {
          agentServedWorkspaces.push({
            id: `${agent.id}:${displayPath}`,
            name: displayPath === "/" ? "/" : basename(displayPath),
            path: displayPath,
            isAgentServed: true,
            agentId: agent.id || null,
            agentName: agent.name || null,
            hostname:
              ((machineInfo as Record<string, unknown>)?.hostname as string) || null,
            platform:
              ((machineInfo as Record<string, unknown>)?.platform as string) || null,
            arch: ((machineInfo as Record<string, unknown>)?.arch as string) || null,
            clientIp:
              (agent as WorkspaceAgent & { clientIp?: string })?.clientIp || null,
          });
        }
      }

      disambiguateWorkspaceNames(agentServedWorkspaces);

      res.json(agentServedWorkspaces);
    } catch (error: unknown) {
      logger.error(`GET /workspaces error: ${getErrorMessage(error)}`);
      res.status(500).json({ error: "Failed to retrieve workspace roots" });
    }
  }),
);

/**
 * GET /workspaces/full
 * Returns the full workspace config including connected agent metadata.
 * Used by the Settings page for the richer workspace management UI.
 * Shape: { workspaces: [...], agents: [...] }
 */
router.get(
  "/full",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      // Refresh from tools-api to pick up agent-registered roots
      await ToolOrchestratorService.refreshWorkspaceRoots();

      // Fetch full config from tools-api to get agent metadata
      let agents: WorkspaceAgent[] = [];
      try {
        const configResponse = await fetch(
          `${TOOLS_SERVICE_URL}/admin/config`,
          {
            signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MILLISECONDS),
          },
        );
        if (configResponse.ok) {
          const config = (await configResponse.json()) as WorkspaceConfig;
          agents = config.agents || [];
        }
      } catch (agentError: unknown) {
        logger.warn(
          `GET /workspaces/full agent fetch failed: ${getErrorMessage(agentError)}`,
        );
      }

      // For the Settings page, only show workspace entries when the agent
      // provides explicit displayRoots. Docker containers register virtual
      // root "/" with no displayRoots — those should not appear as workspace
      // entries in the management UI.
      const agentServedWorkspaces: MappedWorkspace[] = [];
      for (const agent of agents) {
        const displayPaths = agent.displayRoots || [];
        const machineInfo =
          (agent as WorkspaceAgent & { machineInfo?: Record<string, unknown> })
            ?.machineInfo || null;
        for (const displayPath of displayPaths) {
          agentServedWorkspaces.push({
            id: `${agent.id}:${displayPath}`,
            name: displayPath === "/" ? "/" : basename(displayPath),
            path: displayPath,
            isAgentServed: true,
            agentId: agent.id || null,
            agentName: agent.name || null,
            hostname:
              ((machineInfo as Record<string, unknown>)?.hostname as string) || null,
            platform:
              ((machineInfo as Record<string, unknown>)?.platform as string) || null,
            arch: ((machineInfo as Record<string, unknown>)?.arch as string) || null,
            clientIp:
              (agent as WorkspaceAgent & { clientIp?: string })?.clientIp || null,
          });
        }
      }

      disambiguateWorkspaceNames(agentServedWorkspaces);

      res.json({ workspaces: agentServedWorkspaces, agents });
    } catch (error: unknown) {
      logger.error(`GET /workspaces/full error: ${getErrorMessage(error)}`);
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
 * Returns the updated workspace list.
 */
router.put(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const parseResult = PutWorkspacesSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      });
    }

    try {
      const result = await ToolOrchestratorService.updateWorkspaceRoots(
        parseResult.data.roots,
      );
      res.json(result);
    } catch (error: unknown) {
      logger.error(`PUT /workspaces error: ${getErrorMessage(error)}`);
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
    const parseResult = ValidateWorkspaceSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: `Validation failed: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      });
    }

    try {
      const result = await ToolOrchestratorService.validateWorkspacePath(
        parseResult.data.path,
      );
      res.json(result);
    } catch (error: unknown) {
      logger.error(
        `POST /workspaces/validate error: ${getErrorMessage(error)}`,
      );
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
      const toolsResponse = await fetch(
        `${TOOLS_SERVICE_URL}/agentic/project/summary`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: workspacePath,
            maxDepth: maxDepth ? parseInt(String(maxDepth), 10) : 3,
          }),
          signal: AbortSignal.timeout(30_000),
        },
      );

      if (!toolsResponse.ok) {
        const errorBody = (await toolsResponse.json().catch(() => ({}))) as {
          error?: string;
        };
        return res.status(toolsResponse.status).json({
          error:
            errorBody.error || `tools-service returned ${toolsResponse.status}`,
        });
      }

      const result = await toolsResponse.json();
      res.json(result);
    } catch (error: unknown) {
      const errorDetail = getErrorMessage(error);
      logger.error(`GET /workspaces/tree error: ${errorDetail}`);
      const isTimeout = error instanceof Error && error.name === "TimeoutError";
      res.status(isTimeout ? 504 : 500).json({
        error: isTimeout
          ? "Workspace tree request timed out — the workspace agent may be slow or disconnected"
          : `Failed to fetch workspace tree: ${errorDetail}`,
      });
    }
  }),
);

/**
 * GET /workspaces/download/agent
 * Proxies the single-file workspace agent download from tools-service.
 * Streams the .mjs file directly to the browser as a download attachment.
 */
router.get(
  "/download/agent",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const platform = req.query.platform;
      const toolsUrl = platform
        ? `${TOOLS_SERVICE_URL}/agents/download/agent?platform=${encodeURIComponent(String(platform))}`
        : `${TOOLS_SERVICE_URL}/agents/download/agent`;

      const toolsResponse = await fetch(toolsUrl, {
        signal: AbortSignal.timeout(60_000),
      });

      if (!toolsResponse.ok) {
        const errorBody = (await toolsResponse.json().catch(() => ({}))) as {
          error?: string;
        };
        return res.status(toolsResponse.status).json({
          error:
            errorBody.error || `tools-service returned ${toolsResponse.status}`,
        });
      }

      res.setHeader(
        "Content-Type",
        toolsResponse.headers.get("Content-Type") || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        toolsResponse.headers.get("Content-Disposition") ||
          'attachment; filename="workspace-agent.mjs"',
      );
      const contentLength = toolsResponse.headers.get("Content-Length");
      if (contentLength) {
        res.setHeader("Content-Length", contentLength);
      }
      res.setHeader("Cache-Control", "public, max-age=300");

      // Pipe the ReadableStream from fetch to the Express response
      const reader = toolsResponse.body?.getReader();
      if (!reader) {
        return res
          .status(502)
          .json({ error: "Empty response from tools-service" });
      }

      const pump = async () => {
        while (true) {
          const { done: isDone, value } = await reader.read();
          if (isDone) break;
          res.write(value);
        }
        res.end();
      };
      await pump();
    } catch (error: unknown) {
      logger.error(
        `GET /workspaces/download/agent error: ${getErrorMessage(error)}`,
      );
      res.status(502).json({
        error: "Failed to download workspace agent from tools-service",
      });
    }
  }),
);

/**
 * GET /workspaces/download/tray-app
 * Proxies the system tray Electron app installer download from tools-service.
 * Requires 'platform' query parameter: win-x64, linux-x64, mac-x64, mac-arm64.
 */
router.get(
  "/download/tray-app",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const platform = req.query.platform;
      if (!platform) {
        return res.status(400).json({
          error:
            "Missing 'platform' query parameter. Supported: win-x64, linux-x64, mac-x64, mac-arm64",
        });
      }

      const toolsUrl = `${TOOLS_SERVICE_URL}/agents/download/tray-app?platform=${encodeURIComponent(String(platform))}`;

      const toolsResponse = await fetch(toolsUrl, {
        signal: AbortSignal.timeout(120_000),
      });

      if (!toolsResponse.ok) {
        const errorBody = (await toolsResponse.json().catch(() => ({}))) as {
          error?: string;
        };
        return res.status(toolsResponse.status).json({
          error:
            errorBody.error || `tools-service returned ${toolsResponse.status}`,
        });
      }

      res.setHeader(
        "Content-Type",
        toolsResponse.headers.get("Content-Type") || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        toolsResponse.headers.get("Content-Disposition") ||
          `attachment; filename="prism-workspace-agent-${String(platform)}"`,
      );
      const contentLength = toolsResponse.headers.get("Content-Length");
      if (contentLength) {
        res.setHeader("Content-Length", contentLength);
      }
      res.setHeader("Cache-Control", "public, max-age=300");

      const reader = toolsResponse.body?.getReader();
      if (!reader) {
        return res
          .status(502)
          .json({ error: "Empty response from tools-service" });
      }

      const pump = async () => {
        while (true) {
          const { done: isDone, value } = await reader.read();
          if (isDone) break;
          res.write(value);
        }
        res.end();
      };
      await pump();
    } catch (error: unknown) {
      logger.error(
        `GET /workspaces/download/tray-app error: ${getErrorMessage(error)}`,
      );
      res.status(502).json({
        error: "Failed to download tray app installer from tools-service",
      });
    }
  }),
);

/**
 * DELETE /workspaces/agents/:id
 * Disconnect a remote workspace agent by ID.
 * Proxies to tools-service DELETE /agents/:id.
 */
router.delete(
  "/agents/:id",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const agentId = req.params.id;
      const toolsResponse = await fetch(
        `${TOOLS_SERVICE_URL}/agents/${agentId}`,
        {
          method: "DELETE",
          signal: AbortSignal.timeout(TOOL_CONFIG_FETCH_TIMEOUT_MILLISECONDS),
        },
      );

      if (!toolsResponse.ok) {
        const errorBody = await toolsResponse.json().catch(() => ({}));
        return res.status(toolsResponse.status).json(errorBody);
      }

      const responseBody = await toolsResponse.json();
      res.json(responseBody);
    } catch (error: unknown) {
      logger.error(
        `DELETE /workspaces/agents/:id error: ${getErrorMessage(error)}`,
      );
      res.status(502).json({ error: "Failed to disconnect agent" });
    }
  }),
);

export default router;
