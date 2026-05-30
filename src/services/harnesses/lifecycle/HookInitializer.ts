import AgentHooks, { type HookHandler } from "../../AgentHooks.ts";
import AutoApprovalEngine from "../../AutoApprovalEngine.ts";
import SystemPromptAssembler from "../../SystemPromptAssembler.ts";
import MemoryExtractor from "../../MemoryExtractor.ts";
import CriticGate from "./CriticGate.ts";
import type { PolicyRule } from "../../PolicyEngine.ts";

/**
 * HookInitializer — standardized lifecycle hook wiring for agentic harnesses.
 *
 * Every harness needs the same baseline hooks:
 *   - beforePrompt  → SystemPromptAssembler (builds the system message)
 *   - beforeToolCall → AutoApprovalEngine (determines approval tier)
 *   - afterResponse  → MemoryExtractor (extracts memories from conversation)
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
      "beforeToolCall" as Parameters<typeof hooks.register>[0],
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
    "beforeToolCall" as Parameters<typeof hooks.register>[0],
    approvalEngine.createHook() as HookHandler,
    "AutoApprovalEngine",
    "decide",
  );

  const assembler = new SystemPromptAssembler({
    workspaceRoot: workspaceRoot || undefined,
  });
  hooks.register(
    "beforePrompt" as Parameters<typeof hooks.register>[0],
    assembler.createHook() as HookHandler,
    "SystemPromptAssembler",
    "transform",
  );

  hooks.register(
    "afterResponse" as Parameters<typeof hooks.register>[0],
    MemoryExtractor.createHook() as HookHandler,
    "MemoryExtractor",
    "inspect",
  );

  return { hooks, approvalEngine, assembler };
}
