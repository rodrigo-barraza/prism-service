import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import express, { type Request, type Response, type NextFunction } from "express";
import CustomAgentService from "#src/services/CustomAgentService";
import AgentPersonaRegistry from "#src/services/AgentPersonaRegistry";
import logger from "#src/utils/logger";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import { normalizeAgentDefinitionBody } from "#src/services/agents/AgentDefinitionFields";
import {
  ACP_RUNTIME,
  acpOwnershipError,
  isAcpAgentOwner,
  normalizeAgentRuntime,
} from "#src/services/agents/AgentRuntime";
import { resolveScope } from "#src/utils/ProfileScope";

const router = express.Router();

/**
 * A create/update body's `runtime` and `acp` fields, checked. An `acp`
 * agent starts a process on this host (agents/AgentRuntime), so writing
 * one — `runtime: "acp"`, or any `acp` launch configuration — is for the
 * usernames in PRISM_ACP_AGENT_OWNERS only, and the writer is stamped as
 * the configuration's `owner` (a client-sent owner is ignored). Going back
 * to `runtime: "prism"` narrows, so anyone may. A body that names neither
 * leaves the stored ones alone. An update that sets `runtime: "acp"` alone
 * validates the stored launch configuration.
 */
function withCheckedRuntime(
  body: Record<string, unknown>,
  username: string,
  stored: Record<string, unknown> | null = null,
): { body: Record<string, unknown> } | { status: 400 | 403; error: string } {
  if (body.runtime === undefined && body.acp === undefined) return { body };
  const checked = { ...body };
  if (body.runtime !== ACP_RUNTIME && body.acp === undefined) {
    const normalized = normalizeAgentRuntime({ runtime: body.runtime });
    if (normalized.errors.length > 0) return { status: 400, error: normalized.errors.join("; ") };
    checked.runtime = normalized.runtime ?? "prism";
    return { body: checked };
  }
  if (!isAcpAgentOwner(username)) return { status: 403, error: acpOwnershipError(username) };
  const normalized = normalizeAgentRuntime({
    runtime: ACP_RUNTIME,
    acp: body.acp !== undefined ? body.acp : stored?.acp,
  });
  if (normalized.errors.length > 0 || !normalized.acp) {
    return { status: 400, error: normalized.errors.join("; ") };
  }
  checked.acp = { ...normalized.acp, owner: username };
  if (body.runtime !== undefined) checked.runtime = ACP_RUNTIME;
  return { body: checked };
}

/**
 * GET /custom-agents
 * List all custom agents.
 */
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const agents = await CustomAgentService.list();
      res.json(agents);
    } catch (error: unknown) {
      logger.error(`GET /custom-agents error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * GET /custom-agents/files
 * The agents defined as `.prism/agents` / `.claude/agents` files under the
 * workspace roots, the files that did not become one (and why), and the
 * files shadowed by another definition of the same agent.
 */
router.get(
  "/files",
  asyncHandler(async (req: Request, res: Response) => {
    if (req.query.refresh === "true") AgentPersonaRegistry.refreshFileAgents();
    res.json(AgentPersonaRegistry.describeFileAgents());
  }),
);

/**
 * POST /custom-agents
 * Create a new custom agent and register it in the persona registry.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.body?.name?.trim()) {
        return res.status(400).json({ error: "Agent name is required" });
      }
      const normalized = normalizeAgentDefinitionBody(req.body);
      if ("errors" in normalized) {
        return res.status(400).json({ error: normalized.errors.join("; ") });
      }
      const checked = withCheckedRuntime(normalized.body, resolveScope(req).username);
      if ("error" in checked) {
        return res.status(checked.status).json({ error: checked.error });
      }

      const created = await CustomAgentService.create(checked.body);

      // Register into live persona registry
      AgentPersonaRegistry.registerCustom(created);

      res.status(201).json(created);
    } catch (error: unknown) {
      if (getErrorMessage(error)?.includes("already exists")) {
        return res.status(409).json({ error: getErrorMessage(error) });
      }
      logger.error(`POST /custom-agents error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * PUT /custom-agents/:id
 * Update an existing custom agent and refresh its persona registration.
 */
router.put(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      if (!req.body || typeof req.body !== "object") {
        return res
          .status(400)
          .json({ error: "Request body must be an object" });
      }
      const normalized = normalizeAgentDefinitionBody(req.body);
      if ("errors" in normalized) {
        return res.status(400).json({ error: normalized.errors.join("; ") });
      }

      // Get the old doc to unregister the old agentId if name changed
      const oldDoc = await CustomAgentService.get(String(id));
      if (!oldDoc) {
        return res.status(404).json({ error: "Agent not found" });
      }
      const checked = withCheckedRuntime(
        normalized.body,
        resolveScope(req).username,
        oldDoc as Record<string, unknown>,
      );
      if ("error" in checked) {
        return res.status(checked.status).json({ error: checked.error });
      }
      const updates = checked.body;

      const updated = await CustomAgentService.update(String(id), updates);

      // Unregister old ID if it changed, then register new
      if (updated && oldDoc.agentId !== updated.agentId!) {
        AgentPersonaRegistry.unregister(oldDoc.agentId);
      }
      AgentPersonaRegistry.registerCustom(updated as Record<string, unknown>);

      res.json(updated);
    } catch (error: unknown) {
      if (getErrorMessage(error)?.includes("already exists")) {
        return res.status(409).json({ error: getErrorMessage(error) });
      }
      logger.error(`PUT /custom-agents/:id error: ${getErrorMessage(error)}`);
      next(error);
    }
  }),
);

/**
 * DELETE /custom-agents/:id
 * Delete a custom agent and unregister it from the persona registry.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      // Get the doc first so we know the agentId to unregister
      const document = await CustomAgentService.get(String(id));
      if (!document) {
        return res.status(404).json({ error: "Agent not found" });
      }

      await CustomAgentService.delete(String(id));
      AgentPersonaRegistry.unregister(document.agentId);

      res.json({ success: true });
    } catch (error: unknown) {
      logger.error(
        `DELETE /custom-agents/:id error: ${getErrorMessage(error)}`,
      );
      next(error);
    }
  }),
);

export default router;
