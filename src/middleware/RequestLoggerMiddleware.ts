import { type Request, type Response, type NextFunction } from "express";
import { formatBytes } from "@rodrigo-barraza/utilities-library";
import { IDENTITY_HEADERS } from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "#src/utils/logger";
import { requestContext } from "#src/utils/RequestContext";

/**
 * Express middleware that:
 *   1. Sets AsyncLocalStorage context (project, username, clientIp)
 *      so deep call-stack code (providers, services) can read it.
 *   2. Logs every completed request with identity, IP, method, path,
 *      status, timing, and transfer sizes.
 *
 * The identity it logs is the AUTHENTICATED one: AuthMiddleware runs after
 * it and fills the context with the username its credential proved. A
 * claimed `x-username` is never logged as who called — a refused request
 * shows no user.
 */
export function requestLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const start = performance.now();

  // Resolve the project + IP early; the username is AuthMiddleware's to
  // set. A public media path names its owner: /files/projects/{project}/{username}/
  let project = req.project || (req.headers[IDENTITY_HEADERS.project] as string) || "any";
  let username = req.username || "any";
  if (project === "any" && req.originalUrl.startsWith("/files/projects/")) {
    const segments = req.originalUrl.split("/");
    // /files/projects/{project}/{username}/...
    if (segments.length >= 5) {
      project = segments[3] || "any";
      username = segments[4]?.split("?")[0] || "any";
    }
  }
  const forwardedFor = req.headers[IDENTITY_HEADERS.forwardedFor];
  const forwardedIp =
    typeof forwardedFor === "string"
      ? forwardedFor.split(",")[0]?.trim()
      : null;
  const rawIp = req.clientIp || forwardedIp || req.ip || null;
  // Normalize IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1)
  const clientIp = rawIp?.replace(/^::ffff:/, "") || rawIp;
  const agent = (req.headers[IDENTITY_HEADERS.agent] as string) || null;

  // Log on response finish
  res.on("finish", () => {
    // Skip SSE streaming requests — those are logged in detail by the route handlers
    const contentType = res.getHeader("content-type") || "";
    if (
      typeof contentType === "string" &&
      contentType.includes("text/event-stream")
    )
      return;
    // Skip binary audio streams — logged by route handler
    if (typeof contentType === "string" && contentType.includes("audio/"))
      return;

    const elapsed = performance.now() - start;
    // Re-read project/username: authMiddleware set them after us
    const finalProject = req.project || project;
    const finalUsername = req.auth?.username || username;
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
    const outHeader = res.getHeader("content-length");
    const outBytes = parseInt(
      typeof outHeader === "string" ? outHeader : "0",
      10,
    );
    const totalBytes = inBytes + outBytes;
    const sizeTag = `(in: ${formatBytes(inBytes)}, out: ${formatBytes(outBytes)}, total: ${formatBytes(totalBytes)})`;
    // A service names the user it speaks for; say that it was a service.
    const serviceTag = req.auth?.kind === "service" ? " via service" : "";

    logger.request(
      finalProject,
      finalUsername,
      finalIp,
      `${method} ${path} ${status} — ${time} ${sizeTag}${serviceTag}`,
    );
  });

  // Attach agent to req for downstream route handlers
  if (agent) req.agent = agent;

  // Run the rest of the middleware chain inside AsyncLocalStorage context
  requestContext.run({ project, username, clientIp, agent }, () => {
    next();
  });
}
