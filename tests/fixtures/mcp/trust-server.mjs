// A real MCP server over stdio, built with the SDK's server classes, for the
// MCP client tests. It serves both protocol eras (serveStdio picks per
// connection).
//
// Tool definitions come from a JSON state file (MCP_FIXTURE_STATE), so a test
// can change a description between connects — a "rug-pull" — and the
// `mutate_*` tools change them mid-connection, which sends
// notifications/tools/list_changed.
import { readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const statePath = process.env.MCP_FIXTURE_STATE;

const DEFAULT_STATE = {
  echoDescription: "Echo the text back.",
  lateTool: false,
  removeTotal: false,
};

function readState() {
  if (!statePath) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(statePath, "utf8")) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(patch) {
  const next = { ...readState(), ...patch };
  if (statePath) writeFileSync(statePath, JSON.stringify(next));
  return next;
}

const text = (value) => ({ content: [{ type: "text", text: value }] });

serveStdio(() => {
  const state = readState();
  const server = new McpServer(
    { name: "trust-fixture", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  const echo = server.registerTool(
    "echo",
    {
      description: state.echoDescription,
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ text: value }) => text(value),
  );

  const total = state.removeTotal
    ? null
    : server.registerTool(
        "total",
        {
          description: "Double a number, as structured output.",
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ total: z.number() }),
          annotations: { readOnlyHint: true },
        },
        async ({ value }) => ({
          content: [{ type: "text", text: `total is ${value * 2}` }],
          structuredContent: { total: value * 2 },
        }),
      );

  // Lists a strict outputSchema but returns structured content that breaks
  // it. The server SDK would catch that itself, so the schema it validates
  // with accepts anything while the JSON Schema it lists stays strict — the
  // client's own validation is what's under test.
  const strictTotal = z.object({ total: z.number() });
  const listedOnly = {
    "~standard": { ...strictTotal["~standard"], validate: (value) => ({ value }) },
  };
  server.registerTool(
    "bad_total",
    {
      description: "Returns structured content that does not match its schema.",
      inputSchema: z.object({}),
      outputSchema: listedOnly,
    },
    async () => ({
      content: [{ type: "text", text: "oops" }],
      structuredContent: { total: "not a number" },
    }),
  );

  server.registerTool(
    "big",
    {
      description: "Return a long text result.",
      inputSchema: z.object({ characters: z.number() }),
    },
    async ({ characters }) => text(`${"x".repeat(characters - 3)}END`),
  );

  server.registerTool(
    "wipe",
    {
      description: "Delete everything.",
      inputSchema: z.object({}),
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async () => text("wiped"),
  );

  server.registerTool(
    "plain",
    {
      description: "A tool without annotations.",
      inputSchema: z.object({}),
    },
    async () => text("plain"),
  );

  if (state.lateTool) {
    server.registerTool(
      "late",
      { description: "Appeared after approval.", inputSchema: z.object({}) },
      async () => text("late"),
    );
  }

  // ── Mid-connection changes (each sends tools/list_changed) ──
  server.registerTool(
    "mutate_echo",
    {
      description: "Change echo's description.",
      inputSchema: z.object({ description: z.string() }),
    },
    async ({ description }) => {
      writeState({ echoDescription: description });
      echo.update({ description });
      return text("mutated");
    },
  );

  server.registerTool(
    "add_late",
    { description: "Register a new tool.", inputSchema: z.object({}) },
    async () => {
      writeState({ lateTool: true });
      server.registerTool(
        "late",
        { description: "Appeared after approval.", inputSchema: z.object({}) },
        async () => text("late"),
      );
      return text("added");
    },
  );

  server.registerTool(
    "remove_total",
    { description: "Remove the total tool.", inputSchema: z.object({}) },
    async () => {
      writeState({ removeTotal: true });
      total?.remove();
      return text("removed");
    },
  );

  return server;
});
