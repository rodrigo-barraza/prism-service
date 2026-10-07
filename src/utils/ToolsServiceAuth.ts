import { AUTH_HEADERS } from "@rodrigo-barraza/utilities-library/taxonomy";

/**
 * tools-service's credential: its gated routes — code and command execution,
 * files and workspaces, configuration, the agentic and admin APIs — refuse a
 * request without it. prism-service sends it as `x-api-secret` on every
 * request it makes there.
 */
export const TOOLS_SERVICE_API_SECRET_ENV_VAR = "TOOLS_SERVICE_API_SECRET";

/**
 * The header every request to tools-service carries — the one place it is
 * built (tool calls, schemas, hooks, tasks, snapshots, worktrees, push,
 * LM Studio's MCP integration). Read per call; unset, nothing is sent and
 * tools-service's gate refuses the call (fails closed).
 */
export function toolsServiceAuthHeaders(): Record<string, string> {
  const secret = process.env[TOOLS_SERVICE_API_SECRET_ENV_VAR];
  return secret ? { [AUTH_HEADERS.apiSecret]: secret } : {};
}
