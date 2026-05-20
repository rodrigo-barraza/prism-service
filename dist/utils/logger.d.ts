declare const logger: {
    provider(provider: Record<string, unknown>, action: Record<string, unknown>, ...args: Record<string, unknown>): void;
    request(project: Record<string, unknown>, username: string, clientIp: Record<string, unknown>, message: string, ...args: Record<string, unknown>): void;
    info(message: string, ...args: unknown[]): void;
    success(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
};
export default logger;
//# sourceMappingURL=logger.d.ts.map