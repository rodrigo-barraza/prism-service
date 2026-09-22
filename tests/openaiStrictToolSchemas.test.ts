/**
 * OpenAI Responses function tools and open-ended objects.
 *
 * Strict mode requires `additionalProperties: false` on every object, so a
 * strict tool cannot carry an open object: the sanitizer used to close it to
 * `{properties: {}, additionalProperties: false}` and the model could only
 * ever send `{}` there. Three internal tools take free-form maps —
 * `run_async_task.toolArguments`, `execute_skill.variables`,
 * `authenticate_mcp_server.env` — and are read here from the real registry,
 * so a schema change there is covered too.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import "./setup.ts";
import openaiProvider from "#src/providers/openai";
import InternalToolRegistry from "#src/services/tool-definitions/InternalToolRegistry";
import type { ToolSchema } from "#src/services/harnesses/types";

const mockResponsesCreate = vi.fn();

vi.mock("openai", () => ({
  default: class MockOpenAI {
    responses = {
      create: (...args: unknown[]) => mockResponsesCreate(...args),
    };
  },
  toFile: async () => ({}),
}));

function respondWith(data: unknown) {
  return {
    withResponse: async () => ({
      data,
      response: { headers: { get: () => null } },
    }),
  };
}

/** The object branch of a property schema, unwrapping a nullable anyOf. */
function objectBranch(schema: any): any {
  if (schema?.type === "object") return schema;
  return schema?.anyOf?.find((branch: any) => branch?.type === "object");
}

const OPEN_OBJECT_FIELDS: Record<string, string> = {
  run_async_task: "toolArguments",
  execute_skill: "variables",
  authenticate_mcp_server: "env",
};

describe("OpenAI Responses tools with open objects", () => {
  beforeEach(() => {
    mockResponsesCreate.mockReset();
    mockResponsesCreate.mockReturnValue(
      respondWith({
        status: "completed",
        output_text: "ok",
        output: [],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );
  });

  it("keeps the open maps open instead of collapsing them to {}", async () => {
    const registryTools = InternalToolRegistry.getSchemas().filter((tool) =>
      Object.keys(OPEN_OBJECT_FIELDS).includes(tool.name),
    );
    expect(registryTools.map((tool) => tool.name).sort()).toEqual(
      Object.keys(OPEN_OBJECT_FIELDS).sort(),
    );

    const closedTool: ToolSchema = {
      name: "closed_tool",
      description: "Only typed fields",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" },
          options: {
            type: "object",
            properties: { metric: { type: "boolean" } },
          },
        },
        required: ["city"],
      },
    };

    await openaiProvider.generateText(
      [{ role: "user", content: "go" }],
      "gpt-5.5",
      { tools: [...(registryTools as unknown as ToolSchema[]), closedTool] },
    );

    const payload = mockResponsesCreate.mock.calls[0][0];
    const sentTools = payload.tools as Array<Record<string, any>>;

    for (const [toolName, fieldName] of Object.entries(OPEN_OBJECT_FIELDS)) {
      const sent = sentTools.find((tool) => tool.name === toolName);
      expect(sent, toolName).toBeDefined();
      // Strict mode forbids an open object, so the tool must not be strict.
      expect(sent!.strict, `${toolName}.strict`).toBe(false);
      const field = objectBranch(sent!.parameters.properties[fieldName]);
      expect(field, `${toolName}.${fieldName}`).toBeDefined();
      expect(
        field.additionalProperties,
        `${toolName}.${fieldName}.additionalProperties`,
      ).not.toBe(false);
      // The typed siblings survive untouched.
      expect(sent!.parameters.type).toBe("object");
    }

    // A tool with no open object keeps strict mode and its closed shape.
    const closed = sentTools.find((tool) => tool.name === "closed_tool")!;
    expect(closed.strict).toBe(true);
    expect(closed.parameters.additionalProperties).toBe(false);
    expect(objectBranch(closed.parameters.properties.options)).toMatchObject({
      additionalProperties: false,
      required: ["metric"],
    });
  });
});
