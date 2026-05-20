import { Request, Response, NextFunction } from "express";
/**
 * Express middleware that attaches x-project, x-username, and x-workspace-id
 * headers to the request object for downstream route handlers.
 */
export declare function authMiddleware(req: Request, res: Response, next: NextFunction): void;
//# sourceMappingURL=AuthMiddleware.d.ts.map