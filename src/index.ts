import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import express, { Request, Response } from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";

import { errorHandler } from "./utils/errors.ts";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import logger from "./utils/logger.ts";
import { listProviders } from "./providers/index.ts";
import { TYPES } from "./config.ts";
import { setupWebSocket } from "./websocket/index.ts";
import { authMiddleware } from "./middleware/AuthMiddleware.ts";
import { requestLoggerMiddleware } from "./middleware/RequestLoggerMiddleware.ts";
import { COLLECTIONS, CORS_MAX_AGE_SECONDS } from "./constants.ts";
import {
  PRISM_SERVICE_PORT as PORT,
  MONGO_URI,
  MONGO_DB_NAME,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET_NAME,
  } from "../config.ts";
import MongoWrapper from "./wrappers/MongoWrapper.ts";
import MinioWrapper from "./wrappers/MinioWrapper.ts";
import ChangeStreamService from "./services/ChangeStreamService.ts";
import MemoryConsolidationService from "./services/MemoryConsolidationService.ts";
import BackgroundHousekeepingService from "./services/BackgroundHousekeepingService.ts";
import { installShutdownHandlers, registerCleanup } from "./utils/CleanupRegistry.ts";

// Install process-level shutdown handlers (SIGTERM, SIGINT → runCleanupFunctions)
installShutdownHandlers();

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
import mcpServersRouter from "./routes/McpServersRoutes.ts";
import favoritesRouter from "./routes/FavoritesRoutes.ts";
import conversationRouter from "./routes/ConversationExecutionRoute.ts";
import statsRouter from "./routes/StatsRoutes.ts";
import benchmarkRouter from "./routes/BenchmarkRoutes.ts";
import synthesisRouter from "./routes/SynthesisRoutes.ts";
import vramBenchmarksRouter from "./routes/VramBenchmarksRoutes.ts";
import orchestratorRouter from "./routes/OrchestratorRoutes.ts";
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
    allowedHeaders: [
      "Content-Type",
      "x-project",
      "x-username",
      "x-workspace-id",
      "x-workspace-root",
      "x-api-secret",
      "x-admin-secret",
    ],
    maxAge: CORS_MAX_AGE_SECONDS, // cache preflight for 24h — eliminates burst OPTIONS storms
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
app.get("/", (_req: Request, res: Response) => {
  res.json({
    name: "Prism the AI Gateway",
    version: "1.0.0",
    providers: listProviders(),
    endpoints: ENDPOINTS,
  });
});

// Health check (public — standard path for Docker, load balancers, portal)
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
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
app.use("/mcp-servers", mcpServersRouter);
app.use("/favorites", favoritesRouter);
app.use("/conversation", conversationRouter);

app.use("/stats", statsRouter);
app.use("/benchmark", benchmarkRouter);
app.use("/synthesis", synthesisRouter);
app.use("/vram-benchmarks", vramBenchmarksRouter);
app.use("/orchestrator", orchestratorRouter);
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
      await Promise.all([
        // requests — primary lookup by requestId (admin detail view)
        db
          .collection(COLLECTIONS.REQUESTS)
          .createIndex({ requestId: 1 }, { unique: true }),
        // requests — used by $lookup from conversations and session joins
        db.collection(COLLECTIONS.REQUESTS).createIndex({ conversationId: 1 }),
        db.collection(COLLECTIONS.REQUESTS).createIndex({ traceId: 1 }),
        db.collection(COLLECTIONS.REQUESTS).createIndex({ timestamp: -1 }),
        db.collection(COLLECTIONS.REQUESTS).createIndex({ project: 1, timestamp: -1 }),
        // requests — agent session joins (admin traces, session detail)
        db.collection(COLLECTIONS.REQUESTS).createIndex({ agentSessionId: 1 }),
        // requests — parent session hierarchy traversal (7+ query sites use $in on this field)
        db.collection(COLLECTIONS.REQUESTS).createIndex({ parentAgentSessionId: 1 }),
        // requests — per-user stats aggregation
        db.collection(COLLECTIONS.REQUESTS).createIndex({ username: 1, timestamp: -1 }),
        // requests — tool stats aggregation (multikey on array field)
        db.collection(COLLECTIONS.REQUESTS).createIndex({ toolApiNames: 1 }),
        // requests — model/provider breakdown aggregation
        db.collection(COLLECTIONS.REQUESTS).createIndex({ model: 1, provider: 1 }),
        // requests — endpoint breakdown aggregation
        db.collection(COLLECTIONS.REQUESTS).createIndex({ endpoint: 1 }),
        // requests — success/failure filtering with time range
        db.collection(COLLECTIONS.REQUESTS).createIndex({ success: 1, timestamp: -1 }),
        // conversations — used by findOne lookups and list queries
        db.collection(COLLECTIONS.MODEL_CONVERSATIONS).createIndex({ id: 1 }, { unique: true }),
        db.collection(COLLECTIONS.MODEL_CONVERSATIONS).createIndex({ updatedAt: -1 }),
        db
          .collection(COLLECTIONS.MODEL_CONVERSATIONS)
          .createIndex({ project: 1, username: 1, updatedAt: -1 }),
        db.collection(COLLECTIONS.MODEL_CONVERSATIONS).createIndex({ traceId: 1 }),
        // conversations — admin workspace filter
        db.collection(COLLECTIONS.MODEL_CONVERSATIONS).createIndex({ workspaceRoot: 1 }),

        // agent_sessions — same indexes as conversations
        db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .createIndex({ id: 1 }, { unique: true }),
        db.collection(COLLECTIONS.AGENT_CONVERSATIONS).createIndex({ updatedAt: -1 }),
        db
          .collection(COLLECTIONS.AGENT_CONVERSATIONS)
          .createIndex({ project: 1, username: 1, updatedAt: -1 }),
        // agent_sessions — admin workspace filter
        db.collection(COLLECTIONS.AGENT_CONVERSATIONS).createIndex({ workspaceRoot: 1 }),

        // workflows — used by conversationIds lookup
        db.collection(COLLECTIONS.WORKFLOWS).createIndex({ id: 1 }, { unique: true }),
        // benchmarks
        db.collection(COLLECTIONS.BENCHMARKS).createIndex({ id: 1 }, { unique: true }),
        db.collection(COLLECTIONS.BENCHMARKS).createIndex({ project: 1, updatedAt: -1 }),
        db
          .collection(COLLECTIONS.BENCHMARK_RUNS)
          .createIndex({ id: 1 }, { unique: true }),
        db
          .collection(COLLECTIONS.BENCHMARK_RUNS)
          .createIndex({ benchmarkId: 1, project: 1, startedAt: -1 }),
        // synthesis
        db.collection(COLLECTIONS.SYNTHESIS).createIndex({ id: 1 }, { unique: true }),
        db
          .collection(COLLECTIONS.SYNTHESIS)
          .createIndex({ project: 1, username: 1, updatedAt: -1 }),
        db.collection(COLLECTIONS.AGENT_SKILLS).createIndex({ project: 1, username: 1 }),
        // agent_rules
        db.collection(COLLECTIONS.AGENT_RULES).createIndex({ project: 1, username: 1, agent: 1 }),
        // mcp_servers
        db.collection(COLLECTIONS.MCP_SERVERS).createIndex({ project: 1, username: 1 }),
        // mcp_servers — compound for enabled filter (5+ query sites)
        db
          .collection(COLLECTIONS.MCP_SERVERS)
          .createIndex({ project: 1, username: 1, enabled: 1 }),
        // workspaces
        db.collection(COLLECTIONS.WORKSPACES).createIndex({ project: 1, username: 1 }),
        db.collection(COLLECTIONS.WORKSPACES).createIndex({ id: 1 }, { unique: true }),
        // prompts
        db.collection(COLLECTIONS.PROMPTS).createIndex({ project: 1, username: 1, updatedAt: -1 }),
        db.collection(COLLECTIONS.PROMPTS).createIndex({ id: 1 }, { unique: true }),
        // webhook_subscriptions
        db.collection(COLLECTIONS.WEBHOOK_SUBSCRIPTIONS).createIndex({ id: 1 }, { unique: true }),
        db.collection(COLLECTIONS.WEBHOOK_SUBSCRIPTIONS).createIndex({ enabled: 1 }),
      ]);
      logger.success("Database indexes ensured");
    }
  } catch (error: unknown) {
        logger.error(`Failed to ensure indexes: ${errorMessage(error)}`);
  }

  // Clear any stale isGenerating flags left over from a previous crash/restart
  try {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (db) {
      const { modifiedCount } = await db
        .collection(COLLECTIONS.MODEL_CONVERSATIONS)
        .updateMany({ isGenerating: true }, { $set: { isGenerating: false } });
      if (modifiedCount > 0) {
        logger.info(
          `Cleared ${modifiedCount} stale isGenerating flag(s) in conversations`,
        );
      }
      // Also clear in agent_sessions
      const { modifiedCount: agentCleared } = await db
        .collection(COLLECTIONS.AGENT_CONVERSATIONS)
        .updateMany({ isGenerating: true }, { $set: { isGenerating: false } });
      if (agentCleared > 0) {
        logger.info(
          `Cleared ${agentCleared} stale isGenerating flag(s) in agent_sessions`,
        );
      }
    }
  } catch (error: unknown) {
        logger.error(`Failed to clear stale isGenerating flags: ${errorMessage(error)}`);
  }



  // Load custom agents from database into the persona registry
  try {
    const { default: AgentPersonaRegistryCustom } =
      await import("./services/AgentPersonaRegistry.js");
    await AgentPersonaRegistryCustom.loadCustomAgents();
  } catch (error: unknown) {
        logger.warn(`Custom agent loading failed: ${errorMessage(error)}`);
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
              const { name, displayName, transport, url, command, args, env, headers, enabled } = serverConfig;
              if (!name || !transport) continue;

              await mcpDb.collection(COLLECTIONS.MCP_SERVERS).updateOne(
                { project: codingProject, username: "admin", name },
                {
                  $setOnInsert: {
                    createdAt: new Date(),
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
                    updatedAt: new Date(),
                  }
                },
                { upsert: true }
              );
            }
            logger.info(`Seeded ${defaults.length} default MCP server(s) from environment`);
          }
        } catch (seedError: unknown) {
          logger.warn(`Failed to parse/seed DEFAULT_MCP_SERVERS: ${errorMessage(seedError)}`);
        }
      }

      await MCPClientService.connectAllFromDB(mcpDb, codingProject, "admin");
    }
  } catch (error: unknown) {
        logger.warn(`MCP auto-connect failed: ${errorMessage(error)}`);
  }

  // ── Scheduled Memory Consolidation ─────────────────
  // Runs every 24 hours, consolidates memories for all active projects and agents.
    const { hours } = await import("@rodrigo-barraza/utilities-library");
  const CONSOLIDATION_INTERVAL_MS = hours(24);
  const consolidationInterval = setInterval(async () => {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) return;

      // Find all distinct projects with at least some memories
      const projects = await db.collection(COLLECTIONS.MEMORIES).distinct("project");

      // Process projects sequentially — each consolidation loads the full
      // memory corpus with embeddings (~12KB/memory). Running them concurrently
      // compounds heap usage and can cause OOM on large collections.
            for ( const project of projects) {
        // Find all distinct agents within this project
        const agents = await db
          .collection(COLLECTIONS.MEMORIES)
          .distinct("agent", { project });
        if (!agents.length) continue;

                for ( const agent of agents) {
          const count = await db
            .collection(COLLECTIONS.MEMORIES)
            .countDocuments({ project, agent });
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
                            `[AutoDream] Scheduled consolidation failed for "${agent}/${project}": ${errorMessage(error)}`,
            );
          }
        }
      }
    } catch (error: unknown) {
      logger.error(
                `[AutoDream] Scheduled consolidation sweep failed: ${errorMessage(error)}`,
      );
    }
  }, CONSOLIDATION_INTERVAL_MS);
  registerCleanup(async () => clearInterval(consolidationInterval));
  logger.info(
    `[AutoDream] Scheduled consolidation every ${CONSOLIDATION_INTERVAL_MS / 3_600_000}h`,
  );

  // ── Scheduled Tasks Background Daemon ──────────────────
  try {
    const { default: ScheduledTaskService } = await import("./services/ScheduledTaskService.ts");
    await ScheduledTaskService.init();
    registerCleanup(async () => ScheduledTaskService.destroy());
  } catch (error: unknown) {
    logger.error("Failed to initialize Scheduled Tasks daemon: " + errorMessage(error));
  }

  // ── Conversation Timers Background Daemon ──────────────
  try {
    const { default: ConversationTimerService } = await import("./services/ConversationTimerService.ts");
    await ConversationTimerService.init();
    registerCleanup(async () => ConversationTimerService.destroy());
  } catch (error: unknown) {
    logger.error("Failed to initialize Conversation Timers daemon: " + errorMessage(error));
  }

  // ── Webhook Dispatcher ─────────────────────────────────────
  try {
    const { default: WebhookDispatcher } = await import("./services/WebhookDispatcher.ts");
    await WebhookDispatcher.init();
    registerCleanup(async () => WebhookDispatcher.destroy());
  } catch (error: unknown) {
    logger.error("Failed to initialize Webhook Dispatcher: " + errorMessage(error));
  }

  // ── Background Housekeeping ────────────────────────────────
  // Boot-time run: clean up orphans from previous crashes
  BackgroundHousekeepingService.run({ trigger: "boot" }).catch((error: unknown) =>
    logger.error(`[Housekeeping] Boot-time run failed: ${errorMessage(error)}`),
  );

  // Scheduled run: every 6h (independent of consolidation interval)
  const HOUSEKEEPING_INTERVAL_MS = hours(6);
  const housekeepingInterval = setInterval(() => {
    BackgroundHousekeepingService.run({ trigger: "scheduled" }).catch(
      (error: unknown) =>
        logger.error(`[Housekeeping] Scheduled run failed: ${errorMessage(error)}`),
    );
  }, HOUSEKEEPING_INTERVAL_MS);
  registerCleanup(async () => clearInterval(housekeepingInterval));
  logger.info(
    `[Housekeeping] Scheduled cleanup every ${HOUSEKEEPING_INTERVAL_MS / 3_600_000}h`,
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
    const coloredModalities = Object.values(TYPES)
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
