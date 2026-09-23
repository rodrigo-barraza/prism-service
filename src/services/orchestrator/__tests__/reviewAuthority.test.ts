/**
 * Prompt 17, Landing 3: a reviewer may send work back only where it can
 * verify it (arXiv 2609.14767) — documented per topology in TopologyRegistry
 * and decided for a critic by the checks it ran (ReviewAuthority).
 */
import { describe, it, expect } from "vitest";
import { TOPOLOGIES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { TOPOLOGY_DEFINITIONS } from "#src/services/orchestrator/TopologyRegistry";
import { checksRunBy } from "#src/services/orchestrator/ReviewAuthority";

describe("TopologyRegistry — review authority", () => {
  it("every topology says what its reviewer may do", () => {
    for (const definition of TOPOLOGY_DEFINITIONS) {
      expect(definition.reviewAuthority, definition.id).toBeDefined();
      expect(definition.reviewAuthority.detail.length, definition.id).toBeGreaterThan(20);
      expect(definition.reviewAuthority.reviewer === null, definition.id).toBe(
        definition.reviewAuthority.power === "none",
      );
    }
  });

  it("only the critic loop sends work back, and it says on what verification", () => {
    const sendsBack = TOPOLOGY_DEFINITIONS.filter(
      (definition) => definition.reviewAuthority.power === "send_back",
    );
    expect(sendsBack.map((definition) => definition.id)).toEqual([TOPOLOGIES.CRITIC_LOOP]);
    expect(sendsBack[0].reviewAuthority.detail).toMatch(/only when the critic ran a check/);
  });
});

describe("ReviewAuthority — checks a reviewer ran", () => {
  it("counts command and code execution, not reading", () => {
    expect(checksRunBy({ toolNames: { read_file: 3, search_file_contents: 1 } })).toEqual([]);
    expect(checksRunBy({ toolNames: { read_file: 1, execute_command: 2 } })).toEqual(["execute_command"]);
    expect(checksRunBy({ toolNames: { execute_python: 1, execute_shell: 0 } })).toEqual(["execute_python"]);
    expect(checksRunBy({})).toEqual([]);
  });
});
