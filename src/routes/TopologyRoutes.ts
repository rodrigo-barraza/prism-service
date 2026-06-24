import { Router, Request, Response } from "express";
import {
  TOPOLOGY_DEFINITIONS,
  getTopologyById,
} from "../services/orchestrator/TopologyRegistry.ts";

const router: Router = Router();

router.get("/", (_request: Request, response: Response) => {
  response.json(TOPOLOGY_DEFINITIONS);
});

router.get("/:topologyId", (request: Request, response: Response) => {
  const topologyId = request.params.topologyId;
  if (typeof topologyId !== "string" || !topologyId) {
    return response.status(400).json({ error: "topologyId is required" });
  }

  const topologyDefinition = getTopologyById(topologyId);
  if (!topologyDefinition) {
    return response.status(404).json({ error: `Topology "${topologyId}" not found` });
  }

  response.json(topologyDefinition);
});

export default router;
