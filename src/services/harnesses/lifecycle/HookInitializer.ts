import AgentHooks from "../../AgentHooks.ts";
import AutoApprovalEngine from "../../AutoApprovalEngine.ts";
import SystemPromptAssembler from "../../SystemPromptAssembler.ts";
import MemoryExtractor from "../../MemoryExtractor.ts";
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
}

/** Create a fully wired AgentHooks instance with standard lifecycle hooks. */
export function createStandardHooks({
  workspaceRoot,
  autoApprove = false,
  policies,
}: HookInitOptions = {}) {
  const hooks = new AgentHooks();

  const approvalEngine = new AutoApprovalEngine({
    fullAuto: autoApprove === true,
    policies: policies || [],
  });
  hooks.register(
    "beforeToolCall" as Parameters<typeof hooks.register>[0],
    approvalEngine.createHook(),
    "AutoApprovalEngine",
    "decide",
  );

  const assembler = new SystemPromptAssembler({
    workspaceRoot: workspaceRoot || undefined,
  });
  hooks.register(
    "beforePrompt" as Parameters<typeof hooks.register>[0],
    assembler.createHook(),
    "SystemPromptAssembler",
    "transform",
  );

  hooks.register(
    "afterResponse" as Parameters<typeof hooks.register>[0],
    MemoryExtractor.createHook(),
    "MemoryExtractor",
    "inspect",
  );

  return { hooks, approvalEngine, assembler };
}
