import { requestContext } from "../utils/RequestContext.js";
/**
 * Express middleware that attaches x-project, x-username, and x-workspace-id
 * headers to the request object for downstream route handlers.
 */
export function authMiddleware(req, res, next) {
    // Single source of truth for project resolution.
    // Priority: query param → body → x-project header → "default"
    req.project =
        req.query?.project ||
            req.body?.project ||
            req.headers["x-project"] ||
            "default";
    // @ts-ignore - TODO: strict typing
    const rawIp = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    // Normalize IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 → 127.0.0.1)
    req.clientIp = rawIp?.replace(/^::ffff:/, "") || rawIp;
    // Use x-username header when provided; otherwise fall back to "anonymous".
    // Never use the raw client IP as the username — IPs in MinIO object keys
    // (e.g. projects/lupos/127.0.0.1/...) cause path duplication when the
    // same logical user is later identified by a proper username header.
    // @ts-ignore - TODO: strict typing
    req.username = req.headers["x-username"] || "anonymous";
    // Workspace ID for multi-workspace scoping (optional — null means default workspace)
    // @ts-ignore - TODO: strict typing
    req.workspaceId = req.headers["x-workspace-id"] || null;
    // Workspace root path — absolute filesystem path selected by the user.
    // Takes precedence over workspaceId for routing agent tools to the correct directory.
    // @ts-ignore - TODO: strict typing
    req.workspaceRoot = req.headers["x-workspace-root"] || null;
    // Update AsyncLocalStorage context with auth-resolved values
    const store = requestContext.getStore();
    if (store) {
        // @ts-ignore
        store.project = req.project;
        // @ts-ignore
        store.username = req.username;
        // @ts-ignore
        store.clientIp = req.clientIp;
        // @ts-ignore
        store.workspaceId = req.workspaceId;
        // @ts-ignore
        store.workspaceRoot = req.workspaceRoot;
    }
    next();
}
//# sourceMappingURL=AuthMiddleware.js.map