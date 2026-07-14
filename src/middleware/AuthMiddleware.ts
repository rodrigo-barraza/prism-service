import {
  DEFAULT_USERNAME,
  DEFAULT_PROJECT,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import { createAuthMiddleware } from "@rodrigo-barraza/utilities-library/service";
import { Request, Response, NextFunction } from "express";
import { requestContext } from "#src/utils/RequestContext";

/**
 * Express middleware that resolves project, username, client IP, and
 * workspace scoping onto the request object for downstream route handlers.
 *
 * Built on the shared identity-resolution factory from service-library:
 * - project: query param → body → x-project header → DEFAULT_PROJECT
 * - username: x-username header → DEFAULT_USERNAME (never the client IP —
 *   IPs in MinIO object keys cause path duplication once the same user
 *   sends a real username)
 * - clientIp: first x-forwarded-for entry → req.ip, with IPv4-mapped
 *   IPv6 normalization (::ffff:127.0.0.1 → 127.0.0.1)
 */
const sharedAuthMiddleware = createAuthMiddleware({
  defaultProject: DEFAULT_PROJECT,
  defaultUsername: DEFAULT_USERNAME,
  onResolved: (identity) => {
    // Sync auth-resolved values into prism's AsyncLocalStorage context
    // (store fields use null, matching the previous middleware exactly).
    const store = requestContext.getStore();
    if (store) {
      store.project = identity.project;
      store.username = identity.username;
      store.clientIp = identity.clientIp || null;
      store.workspaceId = identity.workspaceId;
      store.workspaceRoot = identity.workspaceRoot;
    }
  },
});

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  sharedAuthMiddleware(req, res, () => {
    // The shared middleware attaches null (and "" for clientIp) when a
    // value is absent; prism's request contract is undefined. Normalize
    // so downstream handlers and serialized payloads see the same shape
    // as before (e.g. `clientIp: req.clientIp` must omit, not "").
    req.clientIp = req.clientIp || undefined;
    req.workspaceId = req.workspaceId || undefined;
    req.workspaceRoot = req.workspaceRoot || undefined;
    // requestLoggerMiddleware (which runs earlier) only sets req.agent
    // when the x-agent header is present — keep that shape.
    req.agent = req.agent || undefined;
    next();
  });
}
