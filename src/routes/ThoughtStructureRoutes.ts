import { Router, Request, Response } from "express";
import {
  THOUGHT_STRUCTURE_DEFINITIONS,
  getThoughtStructureById,
} from "../services/harnesses/strategies/ThoughtStructureRegistry.ts";

const router: Router = Router();

router.get("/", (_request: Request, response: Response) => {
  response.json(THOUGHT_STRUCTURE_DEFINITIONS);
});

router.get("/:structureId", (request: Request, response: Response) => {
  const structureId = request.params.structureId;
  if (typeof structureId !== "string" || !structureId) {
    return response.status(400).json({ error: "structureId is required" });
  }

  const structureDefinition = getThoughtStructureById(structureId);
  if (!structureDefinition) {
    return response.status(404).json({ error: `Thought structure "${structureId}" not found` });
  }

  response.json(structureDefinition);
});

export default router;
