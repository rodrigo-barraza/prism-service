import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateAfterToolExecution } from "#src/services/harnesses/lifecycle/ValidationInterceptor";
import type { ToolCall, ToolResult, AgenticContext } from "#src/services/harnesses/types";
import type AgenticLoopState from "#src/services/AgenticLoopState";

vi.mock("#src/utils/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("#src/services/ToolOrchestratorService", () => ({
  default: {
    getWorkspaceRoot: vi.fn().mockReturnValue("/workspace"),
    executeTool: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
  },
  existsSync: vi.fn().mockReturnValue(false),
}));

import ToolOrchestratorService from "#src/services/ToolOrchestratorService";
import fs from "node:fs";

describe("ValidationInterceptor", () => {
  const mockAgenticContext: AgenticContext = {
    project: "test-project",
    username: "test-user",
    agent: "CODING",
    providerName: "google",
    resolvedModel: "gemini-3.5-flash",
    traceId: "trace-1",
    agentConversationId: "session-1",
    conversationId: "conv-1",
    emit: vi.fn(),
    options: {},
    workspaceRoot: "/workspace",
  } as unknown as AgenticContext;

  const mockLoopState = {} as AgenticLoopState;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("non-file-mutating tools should be ignored", () => {
    it("should return empty feedback for read_file calls", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "read_file", args: { path: "test.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { content: "file contents" } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });

    it("should return empty feedback for run_command calls", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "run_command", args: { command: "ls" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { stdout: "file1.ts" } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });

    it("should return empty feedback for search_files calls", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "search_files", args: { pattern: "test" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { matches: [] } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });
  });

  describe("file-mutating tools with errored results should be skipped", () => {
    it("should skip write_file with error result", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "test.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { error: "Permission denied" } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });

    it("should skip string_replace_file with error result", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "string_replace_file", args: { path: "app.tsx" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { error: "No match found" } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });
  });

  describe("file path extraction", () => {
    it("should skip validation when no file path can be extracted", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { content: "no path here" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });

    it("should extract path from 'path' argument", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "/workspace/src/test.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(ToolOrchestratorService.executeTool).toHaveBeenCalled();
    });

    it("should extract path from 'filePath' argument", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { filePath: "/workspace/src/app.tsx" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(ToolOrchestratorService.executeTool).toHaveBeenCalled();
    });
  });

  describe("file extension filtering", () => {
    it("should skip validation for unsupported file extensions (.py)", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "script.py" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
      expect(ToolOrchestratorService.executeTool).not.toHaveBeenCalled();
    });

    it("should skip validation for unsupported file extensions (.css)", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "styles.css" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });

    it("should handle .json files via inline validation (no shell call)", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "config.json" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
      expect(ToolOrchestratorService.executeTool).not.toHaveBeenCalled();
    });
  });

  describe("TypeScript validation", () => {
    it("should return validation feedback when tsc reports errors", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 1,
        stdout: "src/test.ts(10,5): error TS2304: Cannot find name 'foo'.\nsrc/test.ts(15,3): error TS2322: Type 'string' is not assignable to type 'number'.",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "/workspace/src/test.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(1);
      expect(feedback[0].validatorType).toBe("typescript");
      expect(feedback[0].errors.length).toBeGreaterThanOrEqual(1);
      expect(feedback[0].filePath).toBe("/workspace/src/test.ts");
    });

    it("should return no feedback when tsc succeeds (exit code 0)", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "/workspace/src/clean.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });
  });

  describe("validator error handling", () => {
    it("should return null feedback when shell validator throws", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockRejectedValue(
        new Error("Command timed out after 15s"),
      );

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "/workspace/src/timeout.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });
  });

  describe("multiple file-mutating tools in a single batch", () => {
    it("should validate each file-mutating tool independently", async () => {
      vi.mocked(ToolOrchestratorService.executeTool)
        .mockResolvedValueOnce({
          exitCode: 1,
          stdout: "error TS2304: Cannot find name 'x'",
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          stdout: "",
          stderr: "",
        });

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "/workspace/src/broken.ts" } },
        { id: "call-2", name: "string_replace_file", args: { path: "/workspace/src/fine.tsx" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
        { id: "call-2", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(1);
      expect(feedback[0].filePath).toBe("/workspace/src/broken.ts");
    });
  });

  describe("result matching by ID and fallback by name", () => {
    it("should match results by ID when available", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-abc", name: "write_file", args: { path: "/workspace/test.ts" } },
      ];
      const results: any[] = [
        { id: "call-abc", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });

    it("should skip validation when no matching result is found", async () => {
      const toolCalls: ToolCall[] = [
        { id: "call-xyz", name: "write_file", args: { path: "/workspace/orphan.ts" } },
      ];
      const results: any[] = [
        { id: "call-different", result: { success: true }, name: "read_file" },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
      expect(ToolOrchestratorService.executeTool).not.toHaveBeenCalled();
    });
  });

  describe("patch_file and move_file support", () => {
    it("should validate patch_file as a file-mutating tool", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "patch_file", args: { path: "/workspace/src/patched.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(ToolOrchestratorService.executeTool).toHaveBeenCalled();
    });

    it("should validate move_file as a file-mutating tool using newPath", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "move_file", args: { newPath: "/workspace/src/moved.tsx" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(ToolOrchestratorService.executeTool).toHaveBeenCalled();
    });
  });

  describe("findNearestConfigDir and path extraction edge cases", () => {
    it("should find nearest config directory when config file exists", async () => {
      vi.mocked(fs.existsSync).mockReturnValueOnce(true);
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "src/subdir/test.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(fs.existsSync).toHaveBeenCalled();
    });

    it("should fallback to ToolOrchestratorService.getWorkspaceRoot if workspaceRoot in context is falsy", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const contextWithoutWorkspace = {
        ...mockAgenticContext,
        workspaceRoot: undefined,
      };

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "src/test.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      await validateAfterToolExecution(toolCalls, results, contextWithoutWorkspace as any, mockLoopState);

      expect(ToolOrchestratorService.getWorkspaceRoot).toHaveBeenCalled();
    });

    it("should skip validation if both context workspaceRoot and global workspaceRoot are falsy", async () => {
      vi.mocked(ToolOrchestratorService.getWorkspaceRoot).mockReturnValueOnce(null as any);

      const contextWithoutWorkspace = {
        ...mockAgenticContext,
        workspaceRoot: undefined,
      };

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "src/test.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, contextWithoutWorkspace as any, mockLoopState);

      expect(feedback).toHaveLength(0);
    });
  });

  describe("shell validator output parsing edge cases", () => {
    it("should return null feedback if exitCode is non-zero but combinedOutput is empty", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 1,
        stdout: "",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "src/test.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
    });

    it("should return raw output slice if combinedOutput length is >= 20 but does not contain error keywords", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 1,
        stdout: "Some unexpected compilation output here that is long",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-1", name: "write_file", args: { path: "src/test.ts" } },
      ];
      const results: any[] = [
        { id: "call-1", result: { success: true } },
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(1);
      expect(feedback[0].errors[0]).toContain("Some unexpected compilation output");
    });
  });

  describe("result name fallback matching", () => {
    it("should match by name fallback when result has no ID", async () => {
      vi.mocked(ToolOrchestratorService.executeTool).mockResolvedValue({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });

      const toolCalls: ToolCall[] = [
        { id: "call-abc", name: "write_file", args: { path: "src/test.ts" } },
      ];
      const results: [ToolResult] = [
        { name: "write_file", result: { success: true } } as any,
      ];

      const feedback = await validateAfterToolExecution(toolCalls, results, mockAgenticContext, mockLoopState);

      expect(feedback).toHaveLength(0);
      expect(ToolOrchestratorService.executeTool).toHaveBeenCalled();
    });
  });
});
