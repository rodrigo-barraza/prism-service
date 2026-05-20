declare const logger: {
    provider(provider: any, action: any, ...args: any): void;
    request(project: any, username: string, clientIp: any, message: string, ...args: any): void;
    info(message: string, ...args: unknown[]): void;
    success(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
};
export default logger;
//# sourceMappingURL=logger.d.ts.map