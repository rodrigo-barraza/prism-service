declare const BackgroundHousekeepingService: {
    /**
     * Run all housekeeping tasks.
     * Safe to call at any time — each task is independent and failure-tolerant.
     *
  
  
     * @returns {Promise<object>} Summary of actions taken
     */
    run({ trigger }?: Record<string, unknown>): Promise<{}>;
};
export default BackgroundHousekeepingService;
//# sourceMappingURL=BackgroundHousekeepingService.d.ts.map