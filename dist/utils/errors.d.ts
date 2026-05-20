import type { Request, Response, NextFunction } from "express";
export declare class ProviderError extends Error {
    provider: string;
    statusCode: number;
    originalError: unknown;
    errorType: string | null;
    constructor(provider: string, message: string, statusCode?: number, originalError?: unknown);
    toJSON(): {
        errorType?: string | undefined;
        error: boolean;
        provider: string;
        message: string;
        statusCode: number;
    };
}
export declare function errorHandler(error: ProviderError | Error, _req: Request, res: Response, _next: NextFunction): Response<any, Record<string, any>>;
//# sourceMappingURL=errors.d.ts.map