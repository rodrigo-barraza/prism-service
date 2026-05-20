export default class CoordinatorService {
    /**
     * Spawn a worker agent from a team_create tool call.
     *
     * Creates a git worktree, runs AgenticLoopService.runAgenticLoop() in it,
     * collects the diff when complete, and injects a [WORKER COMPLETED] notification into
     * the coordinator's conversation.
     *
  
     * @param {string} params.description - Short label for the worker
     * @param {string} params.prompt - Self-contained task prompt for the worker
  
  
     * @param {object} params.coordinatorCtx - Coordinator's loop context
     * @returns {Promise<object>} Spawn result with agentId
     */
    static spawnFromTool({ description, prompt, files, model, assignedProvider, assignedModel, coordinatorCtx, }: any): Promise<{
        agent_id: any;
        description: any;
        status: any;
        summary: string;
        result: any;
        toolUses: any;
        toolNames: any;
        iterations: any;
        durationMs: any;
        messages: any;
    } | {
        error: string;
    }>;
    /**
     * Send a follow-up message to a running/idle worker.
  
  
     */
    static sendMessage(agentId: any, message: string, coordinatorCtx: any): Promise<{
        error: string;
        agent_id?: undefined;
        status?: undefined;
        message?: undefined;
    } | {
        agent_id: any;
        status: string;
        message: string;
        error?: undefined;
    }>;
    /**
     * Stop a running worker and clean up its worktree.
  
  
     */
    static stopAgent(agentId: any): Promise<{
        error: string;
        agent_id?: undefined;
        status?: undefined;
    } | {
        agent_id: any;
        status: string;
        error?: undefined;
    }>;
    /**
     * Read the output from a previously spawned worker agent.
     * Returns the full result if completed, or partial status if still running.
  
  
     */
    static getTaskOutput(agentId: any): {
        agent_id: any;
        description: any;
        status: any;
        summary: string;
        result: any;
        toolUses: any;
        toolNames: any;
        iterations: any;
        durationMs: any;
        messages: any;
    } | {
        error: string;
        agent_id?: undefined;
        description?: undefined;
        status?: undefined;
        partialOutput?: undefined;
        toolUses?: undefined;
        iterations?: undefined;
        durationMs?: undefined;
        message?: undefined;
    } | {
        agent_id: any;
        description: any;
        status: string;
        partialOutput: any;
        toolUses: any;
        iterations: any;
        durationMs: number;
        message: string;
        error?: undefined;
    };
    /**
     * Abort all running workers spawned under a given parent agent session.
     * Called when the coordinator's SSE connection is severed (user presses stop)
     * or explicitly via the REST endpoint.
     *
  
     * @returns {{ stopped: string[], alreadyStopped: string[] }}
     */
    static abortWorkersBySession(parentAgentSessionId: any): Promise<{
        stopped: any[];
        alreadyStopped: any[];
    }>;
    /**
     * Get the status of a specific worker.
  
  
     */
    static getWorkerStatus(agentId: any): {
        agentId: any;
        description: any;
        status: any;
        toolCallCount: any;
        durationMs: any;
        diff: any;
        error: any;
    } | null;
    /**
     * List all active workers spawned via chat tools.
  
  
     */
    static listWorkers({ parentAgentSessionId }?: any): {
        agentId: any;
        workerAgentSessionId: any;
        parentAgentSessionId: any;
        description: any;
        status: any;
        branchName: any;
        toolCallCount: any;
        durationMs: any;
        totalCost: any;
        usage: any;
        traceId: any;
        providerName: any;
        resolvedModel: any;
        files: any;
        startedAt: any;
    }[];
    /** Active teams — keyed by team name, value is { agentIds: string[] } */
    static _activeTeams: Map<any, any>;
    /**
     * Remove all workers associated with a parent coordinator session.
     * Called when the coordinator loop completes/errors to prevent unbounded
     * growth of the in-memory activeWorkers Map.
     *
  
     */
    static cleanupSession(parentAgentSessionId: any): void;
    /**
     * Create a named team of parallel worker agents.
     * Each member is spawned via spawnFromTool and runs concurrently.
     * Returns aggregated results from all members when they all complete.
     *
  
     * @param {string} args.name - Team name
     * @param {Array} args.members - [{ description, prompt, files?, model? }]
  
  
     */
    static createTeam(args: any, coordinatorCtx: any): Promise<{
        error: string;
        team?: undefined;
        totalMembers?: undefined;
        succeeded?: undefined;
        failed?: undefined;
        members?: undefined;
    } | {
        team: string;
        totalMembers: number;
        succeeded: number;
        failed: number;
        members: any[];
        error?: undefined;
    }>;
    /**
     * Stop and remove all workers in a named team.
  
  
     */
    static deleteTeam(teamName: any): Promise<{
        error: string;
        team?: undefined;
        deleted?: undefined;
        stopped?: undefined;
        total?: undefined;
    } | {
        team: string;
        deleted: boolean;
        stopped: number;
        total: any;
        error?: undefined;
    }>;
    /**
     * Run the worker's agentic loop in its isolated worktree.
     * @private
     */
    static _runWorkerLoop(worker: any, prompt: any, coordinatorCtx: any): Promise<void>;
    /**
     * Decompose a task into parallel sub-tasks using LLM.
     *
  
     * @param {string} params.task - The refactoring task description
     * @param {string[]} params.files - Target file paths
  
     * @returns {Promise<object>} Decomposed plan with sub-tasks
     */
    static decompose({ task, files, repoPath, endpoint, agentSessionId, }: any): Promise<{
        error: string;
        raw: any;
        taskId?: undefined;
        task?: undefined;
        repoPath?: undefined;
        subTasks?: undefined;
        summary?: undefined;
        status?: undefined;
    } | {
        taskId: `${string}-${string}-${string}-${string}-${string}`;
        task: any;
        repoPath: any;
        subTasks: any[];
        summary: string;
        status: string;
        error?: undefined;
        raw?: undefined;
    }>;
    /**
     * Execute an approved plan — spawn workers in git worktrees.
     *
  
  
     * @returns {Promise<object>} Execution results with diffs
     */
    static execute(plan: any, options?: any): Promise<{
        error: string;
        taskId?: undefined;
        status?: undefined;
        workers?: undefined;
        completedCount?: undefined;
        totalCount?: undefined;
    } | {
        taskId: any;
        status: string;
        workers: any;
        completedCount: any;
        totalCount: any;
        error?: undefined;
    } | {
        error: string;
        taskId: any;
        status?: undefined;
        workers?: undefined;
        completedCount?: undefined;
        totalCount?: undefined;
    }>;
    /**
     * Run a single worker agent in a worktree (manual panel flow).
     * @private
     */
    static _runPanelWorker(worker: any, { repoPath: _repoPath, provider: providerName, model, project, username, onProgress, }: any): Promise<void>;
    /**
     * Approve and merge all completed worker branches.
     *
  
  
     */
    static approveMerge(taskId: any): Promise<{
        error: string;
        taskId?: undefined;
        merged?: undefined;
    } | {
        taskId: any;
        merged: any[];
        error?: undefined;
    }>;
    /**
     * Abort a running task — kill workers and clean up worktrees.
     *
  
  
     */
    static abort(taskId: any): Promise<{
        error: string;
        taskId?: undefined;
        status?: undefined;
    } | {
        taskId: any;
        status: string;
        error?: undefined;
    }>;
    /**
     * Clean up worktrees for a task.
     * @private
     */
    static cleanup(taskId: any): Promise<void>;
    /**
     * Get the current status of a coordinator task.
     *
  
  
     */
    static getStatus(taskId: any): any;
    /**
     * List all active coordinator tasks.
  
     */
    static listTasks(): {
        taskId: any;
        status: any;
        workerCount: any;
        startedAt: any;
    }[];
}
//# sourceMappingURL=CoordinatorService.d.ts.map