import AgentHooks from "../../AgentHooks.ts";
import AutoApprovalEngine from "../../AutoApprovalEngine.ts";
import SystemPromptAssembler from "../../SystemPromptAssembler.ts";
import MemoryExtractor from "../../MemoryExtractor.ts";

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
}

/** Create a fully wired AgentHooks instance with standard lifecycle hooks. */
export function createStandardHooks({
  workspaceRoot,
  autoApprove = false,
}: HookInitOptions = {}) {
  const hooks = new AgentHooks();

  const approvalEngine = new AutoApprovalEngine({
    fullAuto: autoApprove === true,
  });
  hooks.register(
        ("beforeToolCall" as any),
    (approvalEngine.createHook as any)(),
    "AutoApprovalEngine",
  );

  const assembler = new SystemPromptAssembler({
    workspaceRoot: workspaceRoot || undefined,
  });
  hooks.register(
        ("beforePrompt" as any),
    (assembler.createHook as any)(),
    "SystemPromptAssembler",
  );

  hooks.register(
        ("afterResponse" as any),
    (MemoryExtractor.createHook as any)(),
    "MemoryExtractor",
  );

  return { hooks, approvalEngine, assembler };
}
