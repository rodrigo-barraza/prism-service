/**
 * Lifecycle Modules — composable agentic loop phases.
 *
 * Each module encapsulates a distinct lifecycle concern that harness
 * implementations can import and compose as needed.
 */

export { createStandardHooks } from "./HookInitializer.ts";
export { executeToolBatch, executeToolSingle } from "./ToolExecutor.ts";
export { checkAndWaitForApproval } from "./ApprovalGate.ts";
export { finalizeTextGeneration, getCollectionOpts } from "./Finalizer.ts";
export {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "./PostExecutionEmitter.ts";
export { runExhaustionRecoveryPass } from "./ExhaustionRecovery.ts";
export { reloadIfCustomToolsMutated } from "./ToolHotReloader.ts";
export {
  blockUnauthorizedToolCalls,
  handleExitPlanMode,
  checkForPlanModeEntry,
} from "./PlanModeController.ts";
