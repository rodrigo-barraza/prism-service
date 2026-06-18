/**
 * Express Type Helpers
 *
 * Re-exports and extends Express types for route handlers.
 * Eliminates `(req: Request, res: Response, next: NextFunction)` across all route files.
 */

import type {
  Request,
  Response,
  NextFunction,
  ErrorRequestHandler,
} from "express";

export type { Request, Response, NextFunction, ErrorRequestHandler };

/* eslint-disable @typescript-eslint/no-namespace */
declare global {
  namespace Express {
    interface Request {
      project?: string;
      clientIp?: string;
      username?: string;
      workspaceId?: string;
      workspaceRoot?: string;
      agent?: string;
      files?: unknown;
      file?: unknown;
      db: import("mongodb").Db;
    }
  }
}

/**
 * Route handler function signature.
 * Use this for `asyncHandler(async (req, res, next) => { ... })`.
 */
export type RouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

/**
 * MongoDB filter object — used for building query filters dynamically.
 * Replaces `const filter = {};  */
export type MongoFilter = Record<string, unknown>;

/**
 * MongoDB aggregation match stage — same shape as MongoFilter
 * but semantically distinct for clarity.
 */
export type MongoMatch = Record<string, unknown>;
export type CountMap = Record<string, number>;
