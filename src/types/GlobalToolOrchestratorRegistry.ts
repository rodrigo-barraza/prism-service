import type ToolOrchestratorServiceClass from "../services/ToolOrchestratorService.ts";

declare global {
  // eslint-disable-next-line no-var
  var __ToolOrchestratorService:
    | typeof ToolOrchestratorServiceClass
    | undefined;
}

export function getGlobalToolOrchestratorService(): typeof ToolOrchestratorServiceClass {
  const service = globalThis.__ToolOrchestratorService;
  if (!service) {
    throw new Error("ToolOrchestratorService not registered on globalThis");
  }
  return service;
}

export function registerGlobalToolOrchestratorService(
  service: typeof ToolOrchestratorServiceClass,
): void {
  globalThis.__ToolOrchestratorService = service;
}
