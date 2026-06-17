/**
 * WorkflowAssembler — tests for assembleGraph, the function that converts
 * raw workflow step data into the visual node/edge graph rendered by
 * Prism Client's workflow visualization.
 *
 * If assembleGraph produces wrong node types, missing edges, or incorrect
 * positions, the workflow graph renders incorrectly or crashes.
 */
import { describe, it, expect, vi } from "vitest";
import type { WorkflowStep } from "../src/types/workflow.ts";
import { PROVIDERS } from "../src/constants.ts";

vi.mock("../src/config.ts", () => ({
  getModelByName: vi.fn().mockReturnValue(null),
}));

const { assembleGraph } = await import("../src/services/WorkflowAssembler.ts");


// ═══════════════════════════════════════════════════════════════
describe("assembleGraph — empty/invalid input", () => {
  it("should return empty graph for empty steps array", () => {
    const result = assembleGraph([]);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.nodeResults).toEqual({});
  });

  it("should return empty graph for non-array input", () => {
    const result = assembleGraph(null as any);

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("assembleGraph — single step", () => {
  it("should produce input, conversation, model, and viewer nodes", () => {
    const steps: WorkflowStep[] = [
      {
        systemPrompt: "You are helpful",
        input: "Hello",
        output: "Hi there!",
        model: "gpt-5.5",
        type: PROVIDERS.OPENAI,
      },
    ];

    const result = assembleGraph(steps as any);

    // Should have: sys input, user input, conversation, model, viewer = 5 nodes
    expect(result.nodes).toHaveLength(5);

    // Verify all expected node IDs exist
    expect(result.nodes.some((node) => node.id === "s0_sys")).toBe(true);
    expect(result.nodes.some((node) => node.id === "s0_user")).toBe(true);
    expect(result.nodes.some((node) => node.id === "s0_conv")).toBe(true);
    expect(result.nodes.some((node) => node.id === "s0_model")).toBe(true);
    expect(result.nodes.some((node) => node.id === "s0_viewer")).toBe(true);
  });

  it("should store text results in nodeResults", () => {
    const steps: WorkflowStep[] = [
      { input: "Hello", output: "World", model: "test" },
    ];

    const result = assembleGraph(steps as any);

    expect(result.nodeResults["s0_model"]).toBeDefined();
    expect(result.nodeResults["s0_model"].text).toBe("World");
  });

  it("should store image results in nodeResults when outputImageRef is present", () => {
    const steps: WorkflowStep[] = [
      {
        input: "Generate an image",
        output: "Here's the image",
        outputImageRef: "minio://images/gen.png",
        model: "gpt-image-1.5",
        outputType: "image",
      },
    ];

    const result = assembleGraph(steps as any);

    expect(result.nodeResults["s0_model"].image).toBe("minio://images/gen.png");
    expect(result.nodeResults["s0_viewer"].image).toBe("minio://images/gen.png");
  });

  it("should skip system prompt node when systemPrompt is empty", () => {
    const steps: WorkflowStep[] = [
      { input: "Hello", output: "World", model: "test" },
    ];

    const result = assembleGraph(steps as any);

    expect(result.nodes.some((node) => node.id === "s0_sys")).toBe(false);
    // Should have: user input, conversation, model, viewer = 4 nodes
    expect(result.nodes).toHaveLength(4);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("assembleGraph — multi-step chains", () => {
  it("should create chain edges between sequential non-utility steps", () => {
    const steps: WorkflowStep[] = [
      { input: "Step 1", output: "Result 1", model: "gpt-5.5" },
      { input: "Step 2", output: "Result 2", model: "gpt-5.5" },
    ];

    const result = assembleGraph(steps as any);

    // Should have a chain edge from s0_model → s1_model
    const chainEdge = result.edges.find(
      (edge) => edge.id === "chain_s0_model_to_s1_model",
    );
    expect(chainEdge).toBeDefined();
    expect(chainEdge!.sourceNodeId).toBe("s0_model");
    expect(chainEdge!.targetNodeId).toBe("s1_model");
  });

  it("should have conv_to_model edges for every step", () => {
    const steps: WorkflowStep[] = [
      { input: "Step 1", output: "Result 1", model: "gpt-5.5" },
      { input: "Step 2", output: "Result 2", model: "claude-4" },
    ];

    const result = assembleGraph(steps as any);

    expect(
      result.edges.some((edge) => edge.id === "s0_conv_to_model"),
    ).toBe(true);
    expect(
      result.edges.some((edge) => edge.id === "s1_conv_to_model"),
    ).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("assembleGraph — utility steps (🧠 prefix)", () => {
  it("should not create chain edges from utility steps", () => {
    const steps: WorkflowStep[] = [
      { label: "Generate Answer", input: "Hello", output: "Answer", model: "gpt-5.5" },
      { label: "🧠 Emoji Detection", input: "Check emoji", output: "none", model: "gemini-3.5-flash" },
      { label: "Continue", input: "Continue", output: "More", model: "gpt-5.5" },
    ];

    const result = assembleGraph(steps as any);

    // Chain should go from s0 → s2 (skipping the utility step s1)
    const chainTo2 = result.edges.find((edge) => edge.id === "chain_s0_model_to_s2_model");
    expect(chainTo2).toBeDefined();

    // No chain edge from the utility step
    const chainFrom1 = result.edges.find((edge) => edge.sourceNodeId === "s1_model" && edge.id.startsWith("chain_"));
    expect(chainFrom1).toBeUndefined();
  });

  it("should still produce viewer nodes for utility steps", () => {
    const steps: WorkflowStep[] = [
      { label: "🧠 Internal Decision", input: "Check", output: "yes", model: "test" },
    ];

    const result = assembleGraph(steps as any);

    expect(result.nodes.some((node) => node.id === "s0_viewer")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
describe("assembleGraph — edge wiring", () => {
  it("should wire sys → conv and user → conv edges when both exist", () => {
    const steps: WorkflowStep[] = [
      {
        systemPrompt: "You are helpful",
        input: "Hello",
        output: "Hi",
        model: "test",
      },
    ];

    const result = assembleGraph(steps as any);

    expect(result.edges.some((edge) => edge.id === "s0_sys_to_conv")).toBe(true);
    expect(result.edges.some((edge) => edge.id === "s0_user_to_conv")).toBe(true);
  });

  it("should wire model → viewer text edge when output exists", () => {
    const steps: WorkflowStep[] = [
      { input: "Hello", output: "World", model: "test" },
    ];

    const result = assembleGraph(steps as any);

    expect(
      result.edges.some((edge) => edge.id === "s0_model_to_viewer_text"),
    ).toBe(true);
  });

  it("should wire model → viewer image edge when outputImageRef exists", () => {
    const steps: WorkflowStep[] = [
      {
        input: "Generate",
        output: "Image",
        outputImageRef: "minio://img/1.png",
        model: "test",
      },
    ];

    const result = assembleGraph(steps as any);

    expect(
      result.edges.some((edge) => edge.id === "s0_model_to_viewer_image"),
    ).toBe(true);
  });
});
