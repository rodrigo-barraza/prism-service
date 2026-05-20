/**
 * Evaluate whether a model response matches the expected value.
 * @param {string} response   The raw model output
 * @param {string} expected   The expected value
 * @param {string} matchMode  One of: "contains", "exact", "startsWith", "regex"

 */
declare function evaluate(response: Record<string, unknown>, expected: Record<string, unknown>, matchMode?: Record<string, unknown>): any;
/**
 * Get all listed conversation-type models grouped by provider.
 * Returns flat array of { provider, model, label }.
 */
declare function getConversationModels(): Record<string, unknown>[];
declare const BenchmarkService: {
    MATCH_MODES: {
        CONTAINS: string;
        EXACT: string;
        STARTS_WITH: string;
        REGEX: string;
    };
    evaluate: typeof evaluate;
    getConversationModels: typeof getConversationModels;
    /** Number of benchmark model calls currently in-flight. */
    readonly activeGenerationCount: number;
    /**
     * Run a benchmark test against the specified models (or all available).
     * @param {Object}   benchmark   The benchmark definition document
     * @param {Array}    [modelTargets]  Optional array of { provider, model } to test
  
  
     * @returns {Object} The completed run document
     */
    runBenchmark(benchmark: Record<string, unknown>, modelTargets: Record<string, unknown>, project: Record<string, unknown>, username: string, { onRunStart, onModelStart, onModelComplete, onEvent, signal }?: Record<string, unknown>): Promise<{
        id: `${string}-${string}-${string}-${string}-${string}`;
        benchmarkId: unknown;
        project: Record<string, unknown>;
        models: Record<string, unknown>[];
        aborted: any;
        summary: {
            total: number;
            passed: number;
            failed: number;
            errored: number;
            totalCost: Record<string, unknown>;
        };
        startedAt: string;
        completedAt: string;
    }>;
    create(data: Record<string, unknown>, project: Record<string, unknown>, username: string): Promise<{
        id: `${string}-${string}-${string}-${string}-${string}`;
        project: Record<string, unknown>;
        username: string;
        name: unknown;
        prompt: unknown;
        systemPrompt: {} | null;
        expectedValue: unknown;
        matchMode: {};
        benchmarkMode: {};
        assertions: {};
        assertionOperator: {};
        agentAssertions: {};
        agentAssertionOperator: {};
        temperature: {};
        maxTokens: {};
        tags: {};
        createdAt: string;
        updatedAt: string;
    }>;
    list(project: Record<string, unknown>): Promise<import("mongodb").WithId<import("bson").Document>[]>;
    getById(id: string, project: Record<string, unknown>): Promise<import("mongodb").WithId<import("bson").Document> | null>;
    remove(id: string, project: Record<string, unknown>): Promise<void>;
    getRuns(benchmarkId: Record<string, unknown>, project: Record<string, unknown>): Promise<import("mongodb").WithId<import("bson").Document>[]>;
    getRunById(runId: Record<string, unknown>, project: Record<string, unknown>): Promise<import("mongodb").WithId<import("bson").Document> | null>;
    getLatestRun(benchmarkId: Record<string, unknown>, project: Record<string, unknown>): Promise<import("mongodb").WithId<import("bson").Document> | null>;
};
export default BenchmarkService;
//# sourceMappingURL=BenchmarkService.d.ts.map