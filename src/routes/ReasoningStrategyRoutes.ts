import { Router, Request, Response } from "express";
import {
  REASONING_STRATEGY_DEFINITIONS,
  getReasoningStrategyById,
} from "../services/harnesses/strategies/ReasoningStrategyRegistry.ts";

const router = Router();

router.get("/", (_request: Request, response: Response) => {
  response.json(REASONING_STRATEGY_DEFINITIONS);
});

router.get("/:strategyId", (request: Request, response: Response) => {
  const strategyId = request.params.strategyId;
  if (typeof strategyId !== "string" || !strategyId) {
    return response.status(400).json({ error: "strategyId is required" });
  }

  const strategyDefinition = getReasoningStrategyById(strategyId);
  if (!strategyDefinition) {
    return response.status(404).json({ error: `Reasoning strategy "${strategyId}" not found` });
  }

  response.json(strategyDefinition);
});

export default router;
