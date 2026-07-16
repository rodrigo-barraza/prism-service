import { AGENT_IDS, CORS_ALLOWED_HEADERS_STRING } from "@rodrigo-barraza/utilities-library/taxonomy";
import express, { Request, Response } from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";

import { errorHandler } from "./utils/errors.ts";
import logger from "./utils/logger.ts";
import { listProviders } from "./providers/index.ts";
import { setupWebSocket } from "./websocket/index.ts";
import { authMiddleware } from "./middleware/AuthMiddleware.ts";
import { requestLoggerMiddleware } from "./middleware/RequestLoggerMiddleware.ts";
import { MODALITY_TYPES, COLLECTIONS, CROSS_ORIGIN_RESOURCE_SHARING_MAXIMUM_AGE_SECONDS } from "./constants.ts";
import { getErrorMessage } from "@rodrigo-barraza/utilities-library";
import {
  PRISM_SERVICE_PORT as PORT,
  MONGO_URI,
  MONGO_DB_NAME,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET_NAME,
} from "#config";
import MongoWrapper from "./wrappers/MongoWrapper.ts";
import MinioWrapper from "./wrappers/MinioWrapper.ts";
import ChangeStreamService from "./services/ChangeStreamService.ts";
import MemoryConsolidationService from "./services/MemoryConsolidationService.ts";
import BackgroundHousekeepingService from "./services/BackgroundHousekeepingService.ts";
import {
  installShutdownHandlers,
  registerCleanup,
} from "./utils/CleanupRegistry.ts";

// Install process-level shutdown handlers (SIGTERM, SIGINT → runCleanupFunctions)
installShutdownHandlers();

// ── Process-level crash guards ─────────────────────────────────────
// Node ≥15 kills the process on any unhandled promise rejection. In this
// service that meant a single stray rejection (e.g. stream teardown when a
// user stops a generation mid-tool-call) crashed the whole server and wiped
// every in-flight agentic turn — conversations were left as empty stubs in
// MongoDB because messages only persist at finalize. Log loudly instead of
// dying; the per-request error paths already handle their own failures.
process.on("unhandledRejection", (reason: unknown) => {
  const detail =
    reason instanceof Error
      ? `${reason.message}\n${reason.stack}`
      : JSON.stringify(reason);
  logger.error(`[process] Unhandled promise rejection (survived): ${detail}`);
});
process.on("uncaughtException", (error: Error, origin: string) => {
  logger.error(
    `[process] Uncaught exception (${origin}, survived): ${error.message}\n${error.stack}`,
  );
});

// Routes
import chatRouter from "./routes/ChatRoutes.ts";
import agentRouter from "./routes/AgentRoutes.ts";
import audioRouter from "./routes/AudioRoutes.ts";
import embedRouter from "./routes/EmbedRoutes.ts";
import configRouter, { localConfigRouter } from "./routes/ConfigRoutes.ts";
import conversationsRouter from "./routes/ConversationsRoutes.ts";
import filesRouter from "./routes/FilesRoutes.ts";
import memoryRouter from "./routes/MemoryRoutes.ts";
import MemoryService from "./services/MemoryService.ts";
import adminRouter from "./routes/AdminRoutes.ts";
import workflowsRouter from "./routes/WorkflowsRoutes.ts";
import mediaRouter from "./routes/MediaRoutes.ts";
import textRouter from "./routes/TextRoutes.ts";
import lmStudioRouter from "./routes/LmStudioRoutes.ts";
import ollamaRouter from "./routes/OllamaRoutes.ts";
import skillsRouter from "./routes/SkillsRoutes.ts";
import rulesRouter from "./routes/RulesRoutes.ts";
import agentMemoriesRouter from "./routes/AgentMemoriesRoutes.ts";
import workflowMemoriesRouter from "./routes/WorkflowMemoriesRoutes.ts";
import mcpServersRouter from "./routes/McpServersRoutes.ts";
import favoritesRouter from "./routes/FavoritesRoutes.ts";
import conversationRouter from "./routes/ConversationExecutionRoute.ts";
import statsRouter from "./routes/StatsRoutes.ts";
import somaticRouter from "./routes/SomaticRoutes.ts";
import benchmarkRouter from "./routes/BenchmarkRoutes.ts";
import synthesisRouter from "./routes/SynthesisRoutes.ts";
import vramBenchmarksRouter from "./routes/VramBenchmarksRoutes.ts";
import orchestratorRouter from "./routes/OrchestratorRoutes.ts";
import topologyRouter from "./routes/TopologyRoutes.ts";
import thoughtStructureRouter from "./routes/ThoughtStructureRoutes.ts";
import settingsRouter from "./routes/SettingsRoutes.ts";
import customAgentsRouter from "./routes/CustomAgentsRoutes.ts";
import workspacesRouter from "./routes/WorkspacesRoutes.ts";
import scheduledTasksRouter from "./routes/ScheduledTasksRoutes.ts";
import promptsRouter from "./routes/PromptsRoutes.ts";
import webhookRouter from "./routes/WebhookRoutes.ts";

const app = express();
const server = http.createServer(app);

// Disable the default 5-minute request timeout for long-lived SSE connections.
// Node.js 18+ defaults `requestTimeout` to 300,000ms which kills ANY response
// cycle exceeding 5 minutes — including active SSE streams where data is flowing
// continuously. SSE lifecycle is managed by AbortController + client disconnect,
// so the server-level timeout is redundant and harmful for streaming workloads.
server.requestTimeout = 0;

// Middleware
app.use(
  cors({
    origin: true, // reflect request origin (equivalent to *)
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: CORS_ALLOWED_HEADERS_STRING,
    maxAge: CROSS_ORIGIN_RESOURCE_SHARING_MAXIMUM_AGE_SECONDS, // cache preflight for 24h — eliminates burst OPTIONS storms
  }),
);
app.use(express.json({ limit: "50mb" }));
app.use(requestLoggerMiddleware);

// Endpoint registry (single source of truth for health check + startup logs)
const ENDPOINTS = {
  rest: [
    "/config",
    "/config-local",
    "/chat",
    "/agent",
    "/text-to-audio",
    "/audio-to-text",
    "/embed",
    "/conversations",
    "/memory",
    "/files",
    "/workflows",
    "/media",
    "/text",
    "/lm-studio",
    "/ollama",
    "/skills",
    "/rules",
    "/agent-memories",
    "/mcp-servers",
    "/favorites",
    "/conversation",

    "/stats",
    "/benchmark",
    "/synthesis",
    "/vram-benchmarks",
    "/orchestrator",
    "/topologies",
    "/thought-structures",
    "/settings",
    "/custom-agents",
    "/workspaces",
    "/scheduled-tasks",
    "/prompts",
    "/webhooks",
  ],
  websocket: ["/ws/chat", "/ws/text-to-audio"],
  admin: ["/admin", "/admin/lm-studio"],
};

// Health check (public — no auth required)
app.get("/", (_request: Request, response: Response) => {
  response.json({
    name: "Prism the AI Gateway",
    version: "1.0.0",
    providers: listProviders(),
    endpoints: ENDPOINTS,
  });
});

// Health check (public — standard path for Docker, load balancers, portal)
app.get("/health", (_request: Request, response: Response) => {
  response.json({ status: "ok" });
});

// Admin routes
app.use("/admin", adminRouter);

// Public routes (no auth required)
app.use("/files", filesRouter);

// Extract project / username / clientIp from headers for downstream tracking
app.use(authMiddleware);

// REST routes
app.use("/config", configRouter);
app.use("/config-local", localConfigRouter);
app.use("/chat", chatRouter);
app.use("/agent", agentRouter);
app.use("/text-to-audio", audioRouter);
app.use("/audio-to-text", audioRouter);
app.use("/embed", embedRouter);
app.use("/conversations", conversationsRouter);
app.use("/memory", memoryRouter);
app.use("/workflows", workflowsRouter);
app.use("/media", mediaRouter);
app.use("/text", textRouter);
app.use("/lm-studio", lmStudioRouter);
app.use("/ollama", ollamaRouter);
app.use("/skills", skillsRouter);
app.use("/rules", rulesRouter);
app.use("/agent-memories", agentMemoriesRouter);
app.use("/workflow-memories", workflowMemoriesRouter);
app.use("/mcp-servers", mcpServersRouter);
app.use("/favorites", favoritesRouter);
app.use("/conversation", conversationRouter);

app.use("/stats", statsRouter);
app.use("/somatic", somaticRouter);
app.use("/benchmark", benchmarkRouter);
app.use("/synthesis", synthesisRouter);
app.use("/vram-benchmarks", vramBenchmarksRouter);
app.use("/orchestrator", orchestratorRouter);
app.use("/topologies", topologyRouter);
app.use("/thought-structures", thoughtStructureRouter);
app.use("/settings", settingsRouter);
app.use("/custom-agents", customAgentsRouter);
app.use("/workspaces", workspacesRouter);
app.use("/scheduled-tasks", scheduledTasksRouter);
app.use("/prompts", promptsRouter);
app.use("/webhooks", webhookRouter);

// Error handler (must be last)
app.use(errorHandler);

// WebSocket server
const wss = new WebSocketServer({ server });
setupWebSocket(wss);

// Start
(async () => {
  await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI as string);
  await MemoryService.ensureIndexes();

  // ── Ensure collection indexes ──────────────────────────────────
  // Critical for $lookup aggregation performance (conversations ↔ requests).
  // Without these, $lookup does full collection scans per document.
  try {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (db) {
      const indexDefinitions: Array<{
        collection: string;
        keys: Record<string, number>;
        options?: { unique: boolean };
      }> = [
        // requests — primary lookup by requestId (admin detail view)
        {
          collection: COLLECTIONS.REQUESTS,
          keys: { requestId: 1 },
          options: { unique: true },
        },
        // requests — used by $lookup from conversations and agent conversation joins
        { collection: COLLECTIONS.REQUESTS, keys: { conversationId: 1 } },
        { collection: COLLECTIONS.REQUESTS, keys: { traceId: 1 } },
        { collection: COLLECTIONS.REQUESTS, keys: { createdAt: -1 } },
        {
          collection: COLLECTIONS.REQUESTS,
          keys: { project: 1, createdAt: -1 },
        },
        // requests — project-level compound index optimizations for admin unique count groupings
        {
          collection: COLLECTIONS.REQUESTS,
          keys: { project: 1, traceId: 1 },
        },
        {
          collection: COLLECTIONS.REQUESTS,
          keys: { project: 1, conversationId: 1 },
        },
        // requests — agent conversation joins (admin traces, conversation detail)
        { collection: COLLECTIONS.REQUESTS, keys: { agentConversationId: 1 } },
        // requests — parent agent conversation hierarchy traversal (7+ query sites use $in on this field)
        {
          collection: COLLECTIONS.REQUESTS,
          keys: { parentAgentConversationId: 1 },
        },
        // requests — per-user stats aggregation
        {
          collection: COLLECTIONS.REQUESTS,
          keys: { username: 1, createdAt: -1 },
        },
        // requests — tool stats aggregation (multikey on array field)
        { collection: COLLECTIONS.REQUESTS, keys: { toolApiNames: 1 } },
        // requests — model/provider breakdown aggregation
        { collection: COLLECTIONS.REQUESTS, keys: { model: 1, provider: 1 } },
        // requests — endpoint breakdown aggregation
        { collection: COLLECTIONS.REQUESTS, keys: { endpoint: 1 } },
        // requests — success/failure filtering with time range
        {
          collection: COLLECTIONS.REQUESTS,
          keys: { success: 1, createdAt: -1 },
        },
        // requests — admin list filters (agent/operation/provider) with time sort
        { collection: COLLECTIONS.REQUESTS, keys: { agent: 1, createdAt: -1 } },
        {
          collection: COLLECTIONS.REQUESTS,
          keys: { operation: 1, createdAt: -1 },
        },
        {
          collection: COLLECTIONS.REQUESTS,
          keys: { provider: 1, createdAt: -1 },
        },
        // requests — admin conversation search by client IP
        { collection: COLLECTIONS.REQUESTS, keys: { clientIp: 1 } },
        // conversations — used by findOne lookups and list queries
        {
          collection: COLLECTIONS.MODEL_CONVERSATIONS,
          keys: { id: 1 },
          options: { unique: true },
        },
        {
          collection: COLLECTIONS.MODEL_CONVERSATIONS,
          keys: { updatedAt: -1 },
        },
        {
          collection: COLLECTIONS.MODEL_CONVERSATIONS,
          keys: { project: 1, username: 1, updatedAt: -1 },
        },
        { collection: COLLECTIONS.MODEL_CONVERSATIONS, keys: { traceId: 1 } },
        // conversations — admin workspace filter
        {
          collection: COLLECTIONS.MODEL_CONVERSATIONS,
          keys: { workspaceRoot: 1 },
        },
        // conversations — stale isGenerating cleanup + stats count
        {
          collection: COLLECTIONS.MODEL_CONVERSATIONS,
          keys: { isGenerating: 1, updatedAt: -1 },
        },
        // conversations — sub-agent parent linkage (cascading deletion)
        {
          collection: COLLECTIONS.MODEL_CONVERSATIONS,
          keys: { parentConversationId: 1 },
        },
        // conversations — task-scoped listing
        {
          collection: COLLECTIONS.MODEL_CONVERSATIONS,
          keys: { taskId: 1, updatedAt: -1 },
        },
        // conversations — admin filter dropdown distinct("username")
        {
          collection: COLLECTIONS.MODEL_CONVERSATIONS,
          keys: { username: 1 },
        },
        // agent_conversations — same indexes as conversations
        {
          collection: COLLECTIONS.AGENT_CONVERSATIONS,
          keys: { id: 1 },
          options: { unique: true },
        },
        {
          collection: COLLECTIONS.AGENT_CONVERSATIONS,
          keys: { updatedAt: -1 },
        },
        {
          collection: COLLECTIONS.AGENT_CONVERSATIONS,
          keys: { project: 1, username: 1, updatedAt: -1 },
        },
        // agent_conversations — admin workspace filter
        {
          collection: COLLECTIONS.AGENT_CONVERSATIONS,
          keys: { workspaceRoot: 1 },
        },
        // agent_conversations — stale isGenerating cleanup + stats count
        {
          collection: COLLECTIONS.AGENT_CONVERSATIONS,
          keys: { isGenerating: 1, updatedAt: -1 },
        },
        // agent_conversations — isActive lookup (active conversation queries)
        {
          collection: COLLECTIONS.AGENT_CONVERSATIONS,
          keys: { isActive: 1, updatedAt: -1 },
        },
        // agent_conversations — sub-agent parent linkage (tree grouping in UI)
        {
          collection: COLLECTIONS.AGENT_CONVERSATIONS,
          keys: { parentConversationId: 1 },
        },
        // agent_conversations — task-scoped listing
        {
          collection: COLLECTIONS.AGENT_CONVERSATIONS,
          keys: { taskId: 1, updatedAt: -1 },
        },
        // workflows — used by conversationIds lookup
        {
          collection: COLLECTIONS.WORKFLOWS,
          keys: { id: 1 },
          options: { unique: true },
        },
        // workflows — reverse lookup: which workflow contains a conversation
        // (multikey; used by ConversationsRoutes and admin request/content joins)
        { collection: COLLECTIONS.WORKFLOWS, keys: { conversationIds: 1 } },
        // workflows — source-scoped listing sorted by recency
        {
          collection: COLLECTIONS.WORKFLOWS,
          keys: { source: 1, updatedAt: -1 },
        },
        // conversation_timers — 1s daemon tick: active timers due to fire
        {
          collection: COLLECTIONS.CONVERSATION_TIMERS,
          keys: { status: 1, firesAt: 1 },
        },
        // conversation_timers — per-conversation active timer listing
        {
          collection: COLLECTIONS.CONVERSATION_TIMERS,
          keys: { conversationId: 1, status: 1 },
        },
        // scheduled_tasks — daemon tick scans enabled tasks every minute
        { collection: COLLECTIONS.SCHEDULED_TASKS, keys: { enabled: 1 } },
        // favorites — scoped listing sorted by recency
        {
          collection: COLLECTIONS.FAVORITES,
          keys: { project: 1, username: 1, createdAt: -1 },
        },
        // benchmarks
        {
          collection: COLLECTIONS.BENCHMARKS,
          keys: { id: 1 },
          options: { unique: true },
        },
        {
          collection: COLLECTIONS.BENCHMARKS,
          keys: { project: 1, updatedAt: -1 },
        },
        {
          collection: COLLECTIONS.BENCHMARK_RUNS,
          keys: { id: 1 },
          options: { unique: true },
        },
        {
          collection: COLLECTIONS.BENCHMARK_RUNS,
          keys: { benchmarkId: 1, project: 1, startedAt: -1 },
        },
        // synthesis
        {
          collection: COLLECTIONS.SYNTHESIS,
          keys: { id: 1 },
          options: { unique: true },
        },
        {
          collection: COLLECTIONS.SYNTHESIS,
          keys: { project: 1, username: 1, updatedAt: -1 },
        },
        {
          collection: COLLECTIONS.AGENT_SKILLS,
          keys: { project: 1, username: 1 },
        },
        // agent_rules
        {
          collection: COLLECTIONS.AGENT_RULES,
          keys: { project: 1, username: 1, agent: 1 },
        },
        // mcp_servers
        {
          collection: COLLECTIONS.MCP_SERVERS,
          keys: { project: 1, username: 1 },
        },
        // mcp_servers — compound for enabled filter (5+ query sites)
        {
          collection: COLLECTIONS.MCP_SERVERS,
          keys: { project: 1, username: 1, enabled: 1 },
        },
        // workspaces
        {
          collection: COLLECTIONS.WORKSPACES,
          keys: { project: 1, username: 1 },
        },
        {
          collection: COLLECTIONS.WORKSPACES,
          keys: { id: 1 },
          options: { unique: true },
        },
        // prompts
        {
          collection: COLLECTIONS.PROMPTS,
          keys: { project: 1, username: 1, updatedAt: -1 },
        },
        {
          collection: COLLECTIONS.PROMPTS,
          keys: { id: 1 },
          options: { unique: true },
        },
        // webhook_subscriptions
        {
          collection: COLLECTIONS.WEBHOOK_SUBSCRIPTIONS,
          keys: { id: 1 },
          options: { unique: true },
        },
        { collection: COLLECTIONS.WEBHOOK_SUBSCRIPTIONS, keys: { enabled: 1 } },
        // somatic_state — unique per agent
        {
          collection: COLLECTIONS.SOMATIC_STATE,
          keys: { agentId: 1 },
          options: { unique: true },
        },
        // workflow_memories — retrieval query index
        {
          collection: COLLECTIONS.WORKFLOW_MEMORIES,
          keys: { agent: 1, project: 1, createdAt: -1 },
        },
        // workflow_memories — uniqueness per agent conversation
        {
          collection: COLLECTIONS.WORKFLOW_MEMORIES,
          keys: { conversationId: 1, agentConversationId: 1 },
          options: { unique: true },
        },
      ];

      const indexResults = await Promise.allSettled(
        indexDefinitions.map((definition) =>
          db
            .collection(definition.collection)
            .createIndex(definition.keys, definition.options ?? {})
            .then(() => ({
              collection: definition.collection,
              keys: definition.keys,
            })),
        ),
      );

      const failedIndexes = indexResults.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );

      if (failedIndexes.length > 0) {
        for (const failedResult of failedIndexes) {
          const failedDefinition =
            indexDefinitions[indexResults.indexOf(failedResult)];
          logger.error(
            `Index creation failed for ${failedDefinition.collection} ` +
              `${JSON.stringify(failedDefinition.keys)}: ${failedResult.reason}`,
          );
        }
        logger.warn(
          `${failedIndexes.length}/${indexDefinitions.length} indexes failed to create`,
        );
      }

      const succeededCount = indexResults.length - failedIndexes.length;
      logger.success(
        `Database indexes ensured (${succeededCount}/${indexDefinitions.length})`,
      );
    }
  } catch (error: unknown) {
    logger.error(`Failed to ensure indexes: ${getErrorMessage(error)}`);
  }

  // Recover turn checkpoints orphaned by a crash/restart BEFORE clearing
  // stale flags — a checkpoint surviving to startup means the process died
  // mid-turn and the shadow-persisted messages must be merged into the
  // conversation, otherwise the turn (user message included) is lost and
  // the conversation appears as an empty stub.
  try {
    const { default: ConversationService } =
      await import("./services/ConversationService.ts");
    for (const collection of [
      COLLECTIONS.AGENT_CONVERSATIONS,
      COLLECTIONS.MODEL_CONVERSATIONS,
    ]) {
      const recoveredCount =
        await ConversationService.recoverOrphanedTurnCheckpoints({
          collection,
        });
      if (recoveredCount > 0) {
        logger.info(
          `Recovered ${recoveredCount} interrupted turn(s) in ${collection} from crash checkpoints`,
        );
      }
    }
  } catch (error: unknown) {
    logger.error(
      `Failed to recover orphaned turn checkpoints: ${getErrorMessage(error)}`,
    );
  }

  // Clear any stale isGenerating flags left over from a previous crash/restart
  try {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (db) {
      const { modifiedCount } = await db
        .collection(COLLECTIONS.MODEL_CONVERSATIONS)
        .updateMany({ isGenerating: true }, { $set: { isGenerating: false, isActive: false } });
      if (modifiedCount > 0) {
        logger.info(
          `Cleared ${modifiedCount} stale isGenerating flag(s) in conversations`,
        );
      }
      // Also clear in agent_conversations
      const { modifiedCount: agentCleared } = await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .updateMany({ isGenerating: true }, { $set: { isGenerating: false, isActive: false } });
      if (agentCleared > 0) {
        logger.info(
          `Cleared ${agentCleared} stale isGenerating flag(s) in agent_conversations`,
        );
      }
      // Clear stale pendingBackgroundTasks counters — any in-flight async
      // work from a previous process is dead after a restart.
      const { modifiedCount: pendingCleared } = await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .updateMany(
          { pendingBackgroundTasks: { $gt: 0 } },
          { $set: { pendingBackgroundTasks: 0, isActive: false } },
        );
      if (pendingCleared > 0) {
        logger.info(
          `Cleared ${pendingCleared} stale pendingBackgroundTasks counter(s) in agent_conversations`,
        );
      }
      // Clear stale subAgentStatus: "running" — any sub-agents left in
      // "running" state from a previous process are dead after a restart.
      const { modifiedCount: staleSubAgentsCleared } = await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .updateMany(
          { subAgentStatus: "running" },
          {
            $set: {
              subAgentStatus: "stopped",
              isActive: false,
              isGenerating: false,
              subAgentCompletedAt: new Date().toISOString(),
            },
          },
        );
      if (staleSubAgentsCleared > 0) {
        logger.info(
          `Cleared ${staleSubAgentsCleared} stale subAgentStatus flag(s) in agent_conversations`,
        );
      }
    }
  } catch (error: unknown) {
    logger.error(
      `Failed to clear stale isGenerating flags: ${getErrorMessage(error)}`,
    );
  }

  // Load custom agents from database into the persona registry
  try {
    const { default: AgentPersonaRegistryCustom } =
      await import("./services/AgentPersonaRegistry.js");
    await AgentPersonaRegistryCustom.loadCustomAgents();
  } catch (error: unknown) {
    logger.warn(`Custom agent loading failed: ${getErrorMessage(error)}`);
  }

  // Initialize Change Streams (requires replica set — graceful fallback)
  await ChangeStreamService.init();

  // Auto-connect enabled MCP servers
  try {
    const { default: MCPClientService } =
      await import("./services/MCPClientService.js");
    const { default: AgentPersonaRegistryMCP } =
      await import("./services/AgentPersonaRegistry.js");
    const mcpDb = MongoWrapper.getDb(MONGO_DB_NAME);
    const codingProject =
      AgentPersonaRegistryMCP.get(AGENT_IDS.CODING)?.project || "coding";
    if (mcpDb) {
      // Seed default MCP servers from environment variable if provided
      if (process.env.DEFAULT_MCP_SERVERS) {
        try {
          const defaults = JSON.parse(process.env.DEFAULT_MCP_SERVERS);
          if (Array.isArray(defaults)) {
            for (const serverConfig of defaults) {
              const {
                name,
                displayName,
                transport,
                url,
                command,
                args,
                env,
                headers,
                enabled,
              } = serverConfig;
              if (!name || !transport) continue;

              await mcpDb.collection(COLLECTIONS.MCP_SERVERS).updateOne(
                { project: codingProject, username: "admin", name },
                {
                  $setOnInsert: {
                    createdAt: new Date().toISOString(),
                  },
                  $set: {
                    displayName: displayName || name,
                    transport,
                    url: url || "",
                    command: command || "",
                    args: args || [],
                    env: env || {},
                    headers: headers || {},
                    enabled: enabled !== false,
                    updatedAt: new Date().toISOString(),
                  },
                },
                { upsert: true },
              );
            }
            logger.info(
              `Seeded ${defaults.length} default MCP server(s) from environment`,
            );
          }
        } catch (seedError: unknown) {
          logger.warn(
            `Failed to parse/seed DEFAULT_MCP_SERVERS: ${getErrorMessage(seedError)}`,
          );
        }
      }

      await MCPClientService.connectAllFromDB(mcpDb, codingProject, "admin");
    }
  } catch (error: unknown) {
    logger.warn(`MCP auto-connect failed: ${getErrorMessage(error)}`);
  }

  // ── Scheduled Memory Consolidation ─────────────────
  // Runs every 24 hours, consolidates memories for all active projects and agents.
  const { hours } = await import("@rodrigo-barraza/utilities-library");
  const CONSOLIDATION_INTERVAL_MILLISECONDS = hours(24);
  const consolidationInterval = setInterval(async () => {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) return;

      // Single $group aggregation replaces the former distinct-per-project +
      // count-per-agent N+1 sweep.
      const combos = await MemoryService.discoverCombos();

      // Process combos sequentially — each consolidation loads the full
      // memory corpus with embeddings (~12KB/memory). Running them concurrently
      // compounds heap usage and can cause OOM on large collections.
      for (const { project, agent, count } of combos as Array<{
        project: string;
        agent: string;
        count: number;
      }>) {
        if (count < 10) continue; // Skip agent/project combos with few memories

        logger.info(
          `[AutoDream] Scheduled consolidation for agent "${agent}", project "${project}" (${count} memories)`,
        );
        try {
          await MemoryConsolidationService.consolidate({
            agent,
            project,
            username: "system",
            trigger: "scheduled",
          });
        } catch (error: unknown) {
          logger.error(
            `[AutoDream] Scheduled consolidation failed for "${agent}/${project}": ${getErrorMessage(error)}`,
          );
        }
      }
    } catch (error: unknown) {
      logger.error(
        `[AutoDream] Scheduled consolidation sweep failed: ${getErrorMessage(error)}`,
      );
    }
  }, CONSOLIDATION_INTERVAL_MILLISECONDS);
  registerCleanup(async () => clearInterval(consolidationInterval));
  logger.info(
    `[AutoDream] Scheduled consolidation every ${CONSOLIDATION_INTERVAL_MILLISECONDS / 3_600_000}h`,
  );

  // ── Scheduled Tasks Background Daemon ──────────────────
  try {
    const { default: ScheduledTaskService } =
      await import("./services/ScheduledTaskService.ts");
    await ScheduledTaskService.init();
    registerCleanup(async () => ScheduledTaskService.destroy());
  } catch (error: unknown) {
    logger.error(
      "Failed to initialize Scheduled Tasks daemon: " + getErrorMessage(error),
    );
  }

  // ── Conversation Timers Background Daemon ──────────────
  try {
    const { default: ConversationTimerService } =
      await import("./services/ConversationTimerService.ts");
    await ConversationTimerService.initialize();
    registerCleanup(async () => ConversationTimerService.destroy());
  } catch (error: unknown) {
    logger.error(
      "Failed to initialize Conversation Timers daemon: " + getErrorMessage(error),
    );
  }

  // ── Webhook Dispatcher ─────────────────────────────────────
  try {
    const { default: WebhookDispatcher } =
      await import("./services/WebhookDispatcher.ts");
    await WebhookDispatcher.init();
    registerCleanup(async () => WebhookDispatcher.destroy());
  } catch (error: unknown) {
    logger.error(
      "Failed to initialize Webhook Dispatcher: " + getErrorMessage(error),
    );
  }

  // ── Somatic State Service ──────────────────────────────────
  try {
    const { default: SomaticStateService } =
      await import("./services/somatic/SomaticStateService.ts");
    SomaticStateService.initialize();
    registerCleanup(async () => SomaticStateService.persistAll());
  } catch (error: unknown) {
    logger.error(
      "Failed to initialize Somatic State Service: " + getErrorMessage(error),
    );
  }

  // Boot-time run: clean up orphans from previous crashes
  (async () => {
    try {
      await BackgroundHousekeepingService.run({ trigger: "boot" });
    } catch (error: unknown) {
      logger.error(
        `[Housekeeping] Boot-time run failed: ${getErrorMessage(error)}`,
      );
    }
  })();

  // Scheduled run: every 6h (independent of consolidation interval)
  const HOUSEKEEPING_INTERVAL_MILLISECONDS = hours(6);
  const housekeepingInterval = setInterval(async () => {
    try {
      await BackgroundHousekeepingService.run({ trigger: "scheduled" });
    } catch (error: unknown) {
      logger.error(
        `[Housekeeping] Scheduled run failed: ${getErrorMessage(error)}`,
      );
    }
  }, HOUSEKEEPING_INTERVAL_MILLISECONDS);
  registerCleanup(async () => clearInterval(housekeepingInterval));
  logger.info(
    `[Housekeeping] Scheduled cleanup every ${HOUSEKEEPING_INTERVAL_MILLISECONDS / 3_600_000}h`,
  );

  // Initialize MinIO if all secrets are configured
  if (
    MINIO_ENDPOINT &&
    MINIO_ACCESS_KEY &&
    MINIO_SECRET_KEY &&
    MINIO_BUCKET_NAME
  ) {
    await MinioWrapper.init(
      MINIO_ENDPOINT,
      MINIO_ACCESS_KEY,
      MINIO_SECRET_KEY,
      MINIO_BUCKET_NAME,
    );
  } else {
    logger.info(
      "MinIO not configured — files will be stored inline in MongoDB",
    );
  }

  server.listen(PORT, () => {
    logger.success(`Prism the AI Gateway is running on port ${PORT}`);
    logger.info("Available providers:", listProviders().join(", "));
    // Modality colors matching Prism Client's MODALITY_COLORS
    const MODALITY_COLORS: Record<string, number[]> = {
      text: [99, 102, 241], // #6366f1 — indigo
      image: [16, 185, 129], // #10b981 — emerald
      audio: [245, 158, 11], // #f59e0b — amber
      video: [244, 63, 94], // #f43f5e — rose
      pdf: [100, 116, 139], // #64748b — slate
      embedding: [6, 182, 212], // #06b6d4 — cyan
    };
    const coloredModalities = (Object.values(MODALITY_TYPES) as string[])
      .map((modality: string) => {
        const [r, g, b] = MODALITY_COLORS[modality] || [255, 255, 255];
        return `\x1b[38;2;${r};${g};${b}m${modality}\x1b[0m`;
      })
      .join(", ");
    logger.info("Available modalities:", coloredModalities);
    for (const endpoint of ENDPOINTS.rest) {
      logger.info(`  REST  →  http://localhost:${PORT}${endpoint}`);
    }
    for (const endpoint of ENDPOINTS.websocket) {
      logger.info(`  WS    →  ws://localhost:${PORT}${endpoint}`);
    }
  });
})();
