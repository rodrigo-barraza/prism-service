import express, { Request, Response } from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";

import { errorHandler } from "./utils/errors.ts";
import logger from "./utils/logger.ts";
import { listProviders } from "./providers/index.ts";
import { TYPES } from "./config.ts";
import { setupWebSocket } from "./websocket/index.ts";
import { authMiddleware } from "./middleware/AuthMiddleware.ts";
import { requestLoggerMiddleware } from "./middleware/RequestLoggerMiddleware.ts";
import { CORS_MAX_AGE_SECONDS } from "./constants.ts";
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
import customToolsRouter from "./routes/CustomToolsRoutes.ts";
import skillsRouter from "./routes/SkillsRoutes.ts";
import agentMemoriesRouter from "./routes/AgentMemoriesRoutes.ts";
import mcpServersRouter from "./routes/McpServersRoutes.ts";
import favoritesRouter from "./routes/FavoritesRoutes.ts";
import agentSessionsRouter from "./routes/AgentSessionsRoutes.ts";
import statsRouter from "./routes/StatsRoutes.ts";
import benchmarkRouter from "./routes/BenchmarkRoutes.ts";
import synthesisRouter from "./routes/SynthesisRoutes.ts";
import vramBenchmarksRouter from "./routes/VramBenchmarksRoutes.ts";
import coordinatorRouter from "./routes/CoordinatorRoutes.ts";
import settingsRouter from "./routes/SettingsRoutes.ts";
import customAgentsRouter from "./routes/CustomAgentsRoutes.ts";
import workspacesRouter from "./routes/WorkspacesRoutes.ts";

const app = express();
const server = http.createServer(app);

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
    "/custom-tools",
    "/skills",
    "/agent-memories",
    "/mcp-servers",
    "/favorites",
    "/agent-sessions",

    "/stats",
    "/benchmark",
    "/synthesis",
    "/vram-benchmarks",
    "/coordinator",
    "/settings",
    "/custom-agents",
    "/workspaces",
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
app.use("/custom-tools", customToolsRouter);
app.use("/skills", skillsRouter);
app.use("/agent-memories", agentMemoriesRouter);
app.use("/mcp-servers", mcpServersRouter);
app.use("/favorites", favoritesRouter);
app.use("/agent-sessions", agentSessionsRouter);

app.use("/stats", statsRouter);
app.use("/benchmark", benchmarkRouter);
app.use("/synthesis", synthesisRouter);
app.use("/vram-benchmarks", vramBenchmarksRouter);
app.use("/coordinator", coordinatorRouter);
app.use("/settings", settingsRouter);
app.use("/custom-agents", customAgentsRouter);
app.use("/workspaces", workspacesRouter);

// Error handler (must be last)
app.use(errorHandler);

// WebSocket server
const wss = new WebSocketServer({ server });
setupWebSocket((wss as any));

// Start
(async () => {
    await MongoWrapper.createClient(MONGO_DB_NAME, (MONGO_URI as any));
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
          .collection("requests")
          .createIndex({ requestId: 1 }, { unique: true }),
        // requests — used by $lookup from conversations and session joins
        db.collection("requests").createIndex({ conversationId: 1 }),
        db.collection("requests").createIndex({ traceId: 1 }),
        db.collection("requests").createIndex({ timestamp: -1 }),
        db.collection("requests").createIndex({ project: 1, timestamp: -1 }),
        // requests — agent session joins (admin traces, session detail)
        db.collection("requests").createIndex({ agentSessionId: 1 }),
        // requests — tool stats aggregation (multikey on array field)
        db.collection("requests").createIndex({ toolApiNames: 1 }),
        // requests — model/provider breakdown aggregation
        db.collection("requests").createIndex({ model: 1, provider: 1 }),
        // requests — endpoint breakdown aggregation
        db.collection("requests").createIndex({ endpoint: 1 }),
        // requests — success/failure filtering with time range
        db.collection("requests").createIndex({ success: 1, timestamp: -1 }),
        // conversations — used by findOne lookups and list queries
        db.collection("conversations").createIndex({ id: 1 }, { unique: true }),
        db.collection("conversations").createIndex({ updatedAt: -1 }),
        db
          .collection("conversations")
          .createIndex({ project: 1, username: 1, updatedAt: -1 }),
        db.collection("conversations").createIndex({ traceId: 1 }),

        // agent_sessions — same indexes as conversations
        db
          .collection("agent_sessions")
          .createIndex({ id: 1 }, { unique: true }),
        db.collection("agent_sessions").createIndex({ updatedAt: -1 }),
        db
          .collection("agent_sessions")
          .createIndex({ project: 1, username: 1, updatedAt: -1 }),

        // workflows — used by conversationIds lookup
        db.collection("workflows").createIndex({ id: 1 }, { unique: true }),
        // benchmarks
        db.collection("benchmarks").createIndex({ id: 1 }, { unique: true }),
        db.collection("benchmarks").createIndex({ project: 1, updatedAt: -1 }),
        db
          .collection("benchmark_runs")
          .createIndex({ id: 1 }, { unique: true }),
        db
          .collection("benchmark_runs")
          .createIndex({ benchmarkId: 1, project: 1, startedAt: -1 }),
        // synthesis
        db.collection("synthesis").createIndex({ id: 1 }, { unique: true }),
        db
          .collection("synthesis")
          .createIndex({ project: 1, username: 1, updatedAt: -1 }),
        // agent_skills
        db.collection("agent_skills").createIndex({ project: 1, username: 1 }),
        // mcp_servers
        db.collection("mcp_servers").createIndex({ project: 1, username: 1 }),
        // mcp_servers — compound for enabled filter (5+ query sites)
        db
          .collection("mcp_servers")
          .createIndex({ project: 1, username: 1, enabled: 1 }),
        // custom_tools — compound for enabled filter (5+ query sites)
        db
          .collection("custom_tools")
          .createIndex({ project: 1, username: 1, enabled: 1 }),
        // workspaces
        db.collection("workspaces").createIndex({ project: 1, username: 1 }),
        db.collection("workspaces").createIndex({ id: 1 }, { unique: true }),
      ]);
      logger.success("Database indexes ensured");
    }
  } catch (error: any) {
        logger.error(`Failed to ensure indexes: ${(error as Error).message}`);
  }

  // Clear any stale isGenerating flags left over from a previous crash/restart
  try {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (db) {
      const { modifiedCount } = await db
        .collection("conversations")
        .updateMany({ isGenerating: true }, { $set: { isGenerating: false } });
      if (modifiedCount > 0) {
        logger.info(
          `Cleared ${modifiedCount} stale isGenerating flag(s) in conversations`,
        );
      }
      // Also clear in agent_sessions
      const { modifiedCount: agentCleared } = await db
        .collection("agent_sessions")
        .updateMany({ isGenerating: true }, { $set: { isGenerating: false } });
      if (agentCleared > 0) {
        logger.info(
          `Cleared ${agentCleared} stale isGenerating flag(s) in agent_sessions`,
        );
      }
    }
  } catch (error: any) {
        logger.error(`Failed to clear stale isGenerating flags: ${(error as Error).message}`);
  }

  // ── One-time migration: conversations → agent_sessions ──────────
  // Move any existing agent project conversations to the new collection.
  try {
    const { default: AgentPersonaRegistry } =
      await import("./services/AgentPersonaRegistry.js");
    const agentProjects = AgentPersonaRegistry.list()
      .map((p: any) => {
                const persona = AgentPersonaRegistry.get((p.id as any));
        return persona?.project;
      })
      .filter(Boolean);

    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (db && agentProjects.length > 0) {
      const agentConvs = await db
        .collection("conversations")
        .find({ project: { $in: agentProjects } })
        .toArray();
      if (agentConvs.length > 0) {
        // Strip _id to avoid duplicate key errors on insert
        const docs = agentConvs.map(({ _id, ...rest }: any) => rest);
        await db
          .collection("agent_sessions")
          .insertMany(docs, { ordered: false })
          .catch(() => {});
        await db
          .collection("conversations")
          .deleteMany({ project: { $in: agentProjects } });
        logger.info(
          `Migrated ${agentConvs.length} agent conversation(s) → agent_sessions`,
        );
      }
    }
  } catch (error: any) {
        logger.error(`Agent session migration failed: ${(error as Error).message}`);
  }

  // Load custom agents from database into the persona registry
  try {
    const { default: AgentPersonaRegistryCustom } =
      await import("./services/AgentPersonaRegistry.js");
    await AgentPersonaRegistryCustom.loadCustomAgents();
  } catch (error: any) {
        logger.warn(`Custom agent loading failed: ${(error as Error).message}`);
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
            AgentPersonaRegistryMCP.get(("CODING" as any))?.project || "coding";
    if (mcpDb) {
            await MCPClientService.connectAllFromDB((mcpDb as any), codingProject, "admin");
    }
  } catch (error: any) {
        logger.warn(`MCP auto-connect failed: ${(error as Error).message}`);
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
      const projects = await db.collection("memories").distinct("project");

      // Process projects sequentially — each consolidation loads the full
      // memory corpus with embeddings (~12KB/memory). Running them concurrently
      // compounds heap usage and can cause OOM on large collections.
            for ( const project of projects) {
        // Find all distinct agents within this project
        const agents = await db
          .collection("memories")
          .distinct("agent", { project });
        if (!agents.length) continue;

                for ( const agent of agents) {
          const count = await db
            .collection("memories")
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
          } catch (error: any) {
            logger.error(
                            `[AutoDream] Scheduled consolidation failed for "${agent}/${project}": ${(error as Error).message}`,
            );
          }
        }
      }
    } catch (error: any) {
      logger.error(
                `[AutoDream] Scheduled consolidation sweep failed: ${(error as Error).message}`,
      );
    }
  }, CONSOLIDATION_INTERVAL_MS);
  registerCleanup(async () => clearInterval(consolidationInterval));
  logger.info(
    `[AutoDream] Scheduled consolidation every ${CONSOLIDATION_INTERVAL_MS / 3_600_000}h`,
  );

  // ── Background Housekeeping ────────────────────────────────
  // Boot-time run: clean up orphans from previous crashes
  BackgroundHousekeepingService.run({ trigger: "boot" }).catch((error: any) =>
    logger.error(`[Housekeeping] Boot-time run failed: ${error.message}`),
  );

  // Scheduled run: every 6h (independent of consolidation interval)
  const HOUSEKEEPING_INTERVAL_MS = hours(6);
  const housekeepingInterval = setInterval(() => {
    BackgroundHousekeepingService.run({ trigger: "scheduled" }).catch(
      (error: any) =>
        logger.error(`[Housekeeping] Scheduled run failed: ${error.message}`),
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
    const MODALITY_COLORS = {
      text: [99, 102, 241], // #6366f1 — indigo
      image: [16, 185, 129], // #10b981 — emerald
      audio: [245, 158, 11], // #f59e0b — amber
      video: [244, 63, 94], // #f43f5e — rose
      pdf: [100, 116, 139], // #64748b — slate
      embedding: [6, 182, 212], // #06b6d4 — cyan
    };
    const coloredModalities = Object.values(TYPES)
            .map((t: any) => {
                const [r, g, b] = (MODALITY_COLORS as any)[(t as string)] || [255, 255, 255];
        return `\x1b[38;2;${r};${g};${b}m${t}\x1b[0m`;
      })
      .join(", ");
    logger.info("Available modalities:", coloredModalities);
        ENDPOINTS.rest.forEach(((ep: any) =>
              logger.info(`  REST  →  http://localhost:${PORT}${ep}`) as any as (value: string, index: number, array: string[]) => void),
    );
        ENDPOINTS.websocket.forEach(((ep: any) =>
              logger.info(`  WS    →  ws://localhost:${PORT}${ep}`) as any as (value: string, index: number, array: string[]) => void),
    );
  });
})();
