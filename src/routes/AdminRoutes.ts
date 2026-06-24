import express, { Router } from "express";
import requestRoutes from "./admin/AdminRequestRoutes.ts";
import statsRoutes from "./admin/AdminStatsRoutes.ts";
import conversationRoutes from "./admin/AdminConversationRoutes.ts";
import contentRoutes from "./admin/AdminContentRoutes.ts";
import traceRoutes from "./admin/AdminTraceRoutes.ts";
import {
  conversationStatsRouter,
  agentConversationRouter,
} from "./admin/AdminAgentConversationRoutes.ts";
import systemRoutes from "./admin/AdminSystemRoutes.ts";
import lmStudioRoutes from "./admin/AdminLmStudioRoutes.ts";

const router: Router = express.Router();

router.use("/requests", requestRoutes);
router.use("/stats", statsRoutes);
router.use("/conversations", conversationRoutes);
router.use("/traces", traceRoutes);
router.use("/agent-conversations", conversationStatsRouter);
router.use("/agent-conversations", agentConversationRouter);
router.use("/lm-studio", lmStudioRoutes);
router.use(systemRoutes);
router.use(contentRoutes);

export default router;
