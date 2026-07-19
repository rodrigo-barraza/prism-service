// ────────────────────────────────────────────────────────────
// Internal tools always-on invariant
// ────────────────────────────────────────────────────────────
// Every InternalToolRegistry tool must surface as system:true in
// getClientToolSchemas(), regardless of its display domain. The client
// treats non-system tools as toggleable and defaults them to disabled
// (useToolToggles.resetToAllDisabled), which silently vetoes the
// resolver's PRISM_LOCAL_TOOL_NAMES always-on bypass — exactly the bug
// that made create_artifact unreachable when it shipped under the
// Creative domain (2026-07). If an internal tool ever needs to be
// optional instead, it must also be made discoverable (merge internal
// schemas into the search_tools BM25 index) before loosening this.
//
// Uses the REAL registry + orchestrator (no mocks) so a new internal
// tool in a non-core domain fails this test instead of shipping
// undiscoverable.
// ────────────────────────────────────────────────────────────

import { describe, it, expect } from "vitest";

const { default: InternalToolRegistry } = await import(
  "#src/services/tool-definitions/InternalToolRegistry"
);
const { default: ToolOrchestratorService } = await import(
  "#src/services/tool-orchestrator/ToolOrchestratorService"
);

describe("Internal tools always-on invariant", () => {
  it("registers a non-empty set of internal tools", () => {
    expect(InternalToolRegistry.getNames().size).toBeGreaterThan(0);
  });

  it("marks every InternalToolRegistry tool system:true in client schemas", () => {
    const clientSchemas = ToolOrchestratorService.getClientToolSchemas();
    const schemasByName = new Map(
      clientSchemas.map((tool) => [tool.name, tool]),
    );

    for (const toolName of InternalToolRegistry.getNames()) {
      const clientSchema = schemasByName.get(toolName);
      expect(clientSchema, `${toolName} missing from client schemas`).toBeDefined();
      expect(
        clientSchema?.system,
        `${toolName} must be system:true — non-system internal tools get client-vetoed and are invisible to discovery`,
      ).toBe(true);
    }
  });

  it("includes the artifact trio as internal tools", () => {
    const names = InternalToolRegistry.getNames();
    expect(names.has("create_artifact")).toBe(true);
    expect(names.has("update_artifact")).toBe(true);
    expect(names.has("list_artifacts")).toBe(true);
  });
});
