/**
 * Build the coordinator system prompt addendum.
 *


 * @returns {string} System prompt section to append
 */
export declare function getCoordinatorPromptAddendum({ workerTools }?: any): string;
/**
 * Get the list of tool names that workers should NOT have access to.
 * Workers cannot spawn sub-workers (prevents recursion).
 */
export declare const COORDINATOR_ONLY_TOOLS: string[];
//# sourceMappingURL=CoordinatorPrompt.d.ts.map