import { Request, Response, NextFunction } from "express";
import { formatBytes } from "@rodrigo-barraza/utilities-library";
import logger from "../utils/logger.ts";
import { requestContext } from "../utils/RequestContext.ts";

/**
 * Express middleware that:
 *   1. Sets AsyncLocalStorage context (project, username, clientIp)
 *      so deep call-stack code (providers, services) can read it.
 *   2. Logs every completed request with identity, IP, method, path,
 *      status, timing, and transfer sizes.
 */
export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = performance.now();

  // Resolve identity + IP early (before authMiddleware for admin/files routes)
  // Fall back to headers, then to path-based extraction for /files/projects/{project}/{username}/
  let project = req.project || req.headers["x-project"] || null;
  let username = req.username || req.headers["x-username"] || null;
  if (!project && req.originalUrl.startsWith("/files/projects/")) {
    const segments = req.originalUrl.split("/");
    // /files/projects/{project}/{username}/...
    if (segments.length >= 5) {
      project = segments[3] || null;
      username = segments[4]?.split("?")[0] || null;
    }
  }
  const rawIp =
    req.clientIp ||
    // @ts-ignore - TODO: strict typing
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.ip;
  // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1)
  const clientIp = rawIp?.replace(/^::ffff:/, "") || rawIp;
  const agent = req.headers["x-agent"] || null;

  // Log on response finish
  res.on("finish", () => {
    // Skip SSE streaming requests — those are logged in detail by the route handlers
    const contentType = res.getHeader("content-type") || "";
    // @ts-ignore - TODO: strict typing
    if (contentType.includes("text/event-stream")) return;
    // Skip binary audio streams — logged by route handler
    // @ts-ignore - TODO: strict typing
    if (contentType.includes("audio/")) return;

    const elapsed = performance.now() - start;
    // Re-read project/username in case authMiddleware set them after us
    const finalProject = req.project || project;
    const finalUsername = req.username || username;
    const finalIp = req.clientIp || clientIp;
    const method = req.method;
    const path = req.originalUrl;
    const status = res.statusCode;

    // Format timing
    const time =
      elapsed >= 1000
        ? `${(elapsed / 1000).toFixed(2)}s`
        : `${Math.round(elapsed)}ms`;

    // Request / response sizes (from headers — zero-cost)
    const inBytes = parseInt(req.headers["content-length"] || "0", 10);
    // @ts-ignore - TODO: strict typing
    const outBytes = parseInt(res.getHeader("content-length") || "0", 10);
    const totalBytes = inBytes + outBytes;
    const sizeTag = `(in: ${formatBytes(inBytes)}, out: ${formatBytes(outBytes)}, total: ${formatBytes(totalBytes)})`;

    logger.request(
      // @ts-ignore - TODO: strict typing
      finalProject,
      finalUsername,
      finalIp,
      `${method} ${path} ${status} — ${time} ${sizeTag}`,
    );
  });

  // Attach agent to req for downstream route handlers
  // @ts-ignore - TODO: strict typing
  if (agent) req.agent = agent;

  // Run the rest of the middleware chain inside AsyncLocalStorage context
  requestContext.run({ project, username, clientIp, agent }, () => {
    next();
  });
}
