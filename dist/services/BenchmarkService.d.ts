/**
 * Evaluate whether a model response matches the expected value.
 * @param {string} response   The raw model output
 * @param {string} expected   The expected value
 * @param {string} matchMode  One of: "contains", "exact", "startsWith", "regex"

 */
declare function evaluate(response: any, expected: any, matchMode?: any): any;
/**
 * Get all listed conversation-type models grouped by provider.
 * Returns flat array of { provider, model, label }.
 */
declare function getConversationModels(): any[];
declare const BenchmarkService: {
    MATCH_MODES: any;
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
    runBenchmark(benchmark: any, modelTargets: any, project: any, username: string, { onRunStart, onModelStart, onModelComplete, onEvent, signal }?: any): Promise<{
        id: `${string}-${string}-${string}-${string}-${string}`;
        benchmarkId: any;
        project: any;
        models: any[];
        aborted: any;
        summary: {
            total: number;
            passed: number;
            failed: number;
            errored: number;
            totalCost: any;
        };
        startedAt: string;
        completedAt: string;
    }>;
    create(data: any, project: any, username: string): Promise<{
        id: `${string}-${string}-${string}-${string}-${string}`;
        project: any;
        username: string;
        name: any;
        prompt: any;
        systemPrompt: any;
        expectedValue: any;
        matchMode: any;
        benchmarkMode: any;
        assertions: any;
        assertionOperator: any;
        agentAssertions: any;
        agentAssertionOperator: any;
        temperature: any;
        maxTokens: any;
        tags: any;
        createdAt: string;
        updatedAt: string;
    }>;
    list(project: any): Promise<import("mongodb").WithId<import("bson").Document>[]>;
    getById(id: string, project: any): Promise<import("mongodb").WithId<import("bson").Document> | null>;
    remove(id: string, project: any): Promise<void>;
    getRuns(benchmarkId: any, project: any): Promise<import("mongodb").WithId<import("bson").Document>[]>;
    getRunById(runId: any, project: any): Promise<import("mongodb").WithId<import("bson").Document> | null>;
    getLatestRun(benchmarkId: any, project: any): Promise<import("mongodb").WithId<import("bson").Document> | null>;
};
export default BenchmarkService;
//# sourceMappingURL=BenchmarkService.d.ts.map