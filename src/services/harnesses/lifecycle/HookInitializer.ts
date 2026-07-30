import AgentHooks, { type HookHandler } from "#src/services/AgentHooks";
import AutoApprovalEngine from "#src/services/AutoApprovalEngine";
import SystemPromptAssembler from "#src/services/system-prompt/index";
import MemoryExtractor from "#src/services/MemoryExtractor";
import ConversationEmbeddingService from "#src/services/ConversationEmbeddingService";
import WorkflowMemoryService from "#src/services/WorkflowMemoryService";
import CriticGate from "./CriticGate.ts";
import type { PolicyRule } from "#src/services/PolicyEngine";
import logger from "#src/utils/logger";
import { errorMessage } from "@rodrigo-barraza/utilities-library";

/**
 * HookInitializer — standardized lifecycle hook wiring for agentic harnesses.
 *
 * Every harness needs the same baseline hooks:
 *   - beforePrompt  → SystemPromptAssembler (builds the system message)
 *   - beforeToolCall → AutoApprovalEngine (determines approval tier)
 *   - afterResponse  → MemoryExtractor (extracts memories from conversation)
 *   - afterResponse  → ConversationEmbeddingService (embeds conversation for cross-session search)
 *
 * This module creates and wires them in a single call so harnesses
 * don't duplicate the registration boilerplate.
 */

interface HookInitOptions {
  workspaceRoot?: string;
  autoApprove?: boolean;
  /** Declarative tool call policies passed to AutoApprovalEngine. */
  policies?: PolicyRule[];
  /** Enable CriticGate multi-model review of dangerous tool calls. */
  enableCriticGate?: boolean;
  /** Model to use for CriticGate reviews. */
  criticModel?: string;
}

/** Create a fully wired AgentHooks instance with standard lifecycle hooks. */
export function createStandardHooks({
  workspaceRoot,
  autoApprove = false,
  policies,
  enableCriticGate = false,
  criticModel,
}: HookInitOptions = {}) {
  const hooks = new AgentHooks();

  // CriticGate: registered first as a 'decide' hook so it short-circuits
  // before AutoApprovalEngine if the critic denies a dangerous tool call.
  if (enableCriticGate) {
    const criticGate = new CriticGate({ model: criticModel });
    hooks.register(
      "beforeToolCall",
      criticGate.createHook() as HookHandler,
      "CriticGate",
      "decide",
    );
  }

  const approvalEngine = new AutoApprovalEngine({
    fullAuto: autoApprove === true,
    policies: policies || [],
  });
  hooks.register(
    "beforeToolCall",
    approvalEngine.createHook() as HookHandler,
    "AutoApprovalEngine",
    "decide",
  );

  const assembler = new SystemPromptAssembler({
    workspaceRoot: workspaceRoot || undefined,
  });
  hooks.register(
    "beforePrompt",
    assembler.createHook() as HookHandler,
    "SystemPromptAssembler",
    "transform",
  );

  hooks.register(
    "afterResponse",
    MemoryExtractor.createHook() as HookHandler,
    "MemoryExtractor",
    "inspect",
  );

  hooks.register(
    "afterResponse",
    ConversationEmbeddingService.createHook() as HookHandler,
    "ConversationEmbedding",
    "inspect",
  );

  hooks.register(
    "afterResponse",
    WorkflowMemoryService.createHook() as HookHandler,
    "WorkflowMemory",
    "inspect",
  );

  return { hooks, approvalEngine, assembler };
}

/**
 * Attach the user's configured hooks on top of the built-in ones.
 *
 * Kept separate from `createStandardHooks` — which is synchronous and called
 * on the hot path — because this reads Mongo. The registry caches per scope,
 * so the common case is a map lookup rather than a query.
 *
 * Ordering matters: built-in hooks register first, so `AutoApprovalEngine`'s
 * policy verdict is already in the merged result when a user's `PreToolUse`
 * hook runs. Both are `decide` hooks and `AgentHooks.run` short-circuits on
 * the first deny, which preserves the invariant that a policy DENY cannot be
 * relaxed by anything registered later — including a user hook.
 *
 * Never throws. A malformed hook config must not take the conversation down
 * with it; the failure is logged and the loop proceeds with built-ins only.
 */
export async function attachConfiguredHooks(
  hooks: AgentHooks,
  scope: {
    project?: string | null;
    username?: string | null;
    agent?: string | null;
    conversationId?: string | null;
    agentConversationId?: string | null;
    workspaceRoot?: string | null;
    hookDepth?: number;
  },
): Promise<number> {
  try {
    const [{ default: MongoWrapper }, { MONGO_DB_NAME }, registry] =
      await Promise.all([
        import("#src/wrappers/MongoWrapper"),
        import("#config"),
        import("#src/services/hooks/ConfiguredHookRegistry"),
      ]);

    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return 0;

    const configured = await registry.loadHooksForScope(database, {
      project: scope.project || "any",
      username: scope.username || "any",
      agent: scope.agent || null,
    });
    if (configured.length === 0) return 0;

    registry.registerConfiguredHooks(hooks, configured, scope);
    logger.info(
      `[HookInitializer] Attached ${configured.length} configured hook(s) for ${scope.project}/${scope.username}${scope.agent ? `/${scope.agent}` : ""}`,
    );
    return configured.length;
  } catch (error: unknown) {
    logger.warn(
      `[HookInitializer] Could not attach configured hooks (continuing with built-ins): ${errorMessage(error)}`,
    );
    return 0;
  }
}
