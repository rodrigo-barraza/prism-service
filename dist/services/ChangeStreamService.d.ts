declare const ChangeStreamService: {
    /**
     * Whether Change Streams are available (replica set detected).
     */
    readonly available: boolean;
    /**
     * Initialize Change Streams on all watched collections.
     * Call this after MongoDB is connected.
     */
    init(): Promise<void>;
    /**
     * Register a listener for collection change events.
  
     */
    subscribe(callback: Record<string, unknown>): void;
    /**
     * Unregister a listener.
  
     */
    unsubscribe(callback: Record<string, unknown>): void;
    /**
     * Close all Change Streams. Call on shutdown.
     */
    close(): Promise<void>;
};
export default ChangeStreamService;
//# sourceMappingURL=ChangeStreamService.d.ts.map