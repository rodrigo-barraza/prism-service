// A real MCP server over stdio, built with the SDK's server classes, for the
// MCP client tests. It serves both protocol eras (serveStdio picks per
// connection).
//
// Tool definitions come from a JSON state file (MCP_FIXTURE_STATE), so a test
// can change a description between connects — a "rug-pull" — and the
// `mutate_*` tools change them mid-connection, which sends
// notifications/tools/list_changed.
import { readFileSync, writeFileSync } from "node:fs";
import { McpServer, inputRequired } from "@modelcontextprotocol/server";
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

const TRIP_SCHEMA = {
  type: "object",
  properties: {
    city: { type: "string", title: "City" },
    nights: { type: "integer", title: "Nights", minimum: 1 },
    window: { type: "boolean", title: "Window seat" },
  },
  required: ["city", "nights"],
};

serveStdio(({ era }) => {
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

  // ── Elicitation — the same tool on both eras: a 2025-era server sends
  // elicitation/create mid-call, a 2026-07-28 one returns input_required
  // and reads the answer on the retry.
  server.registerTool(
    "book_trip",
    { description: "Book a trip; asks where to.", inputSchema: z.object({}) },
    async (_args, ctx) => {
      let answer;
      if (era === "modern") {
        answer = ctx.mcpReq.inputResponses?.trip;
        if (!answer) {
          return inputRequired({
            inputRequests: {
              trip: inputRequired.elicit({ message: "Where to?", requestedSchema: TRIP_SCHEMA }),
            },
          });
        }
      } else {
        answer = await ctx.mcpReq.elicitInput({
          mode: "form",
          message: "Where to?",
          requestedSchema: TRIP_SCHEMA,
        });
      }
      return text(JSON.stringify(answer));
    },
  );

  server.registerTool(
    "open_docs",
    { description: "Needs the user to visit a page.", inputSchema: z.object({}) },
    async (_args, ctx) => {
      let answer;
      if (era === "modern") {
        answer = ctx.mcpReq.inputResponses?.visit;
        if (!answer) {
          return inputRequired({
            inputRequests: {
              visit: inputRequired.elicitUrl({ message: "Sign the form", url: "https://example.com/sign" }),
            },
          });
        }
      } else {
        answer = await ctx.mcpReq.elicitInput({
          mode: "url",
          message: "Sign the form",
          url: "https://example.com/sign",
          elicitationId: "sign-1",
        });
      }
      return text(JSON.stringify(answer));
    },
  );

  // ── Prompts and resources (composer slash commands and @-mentions) ──
  server.registerPrompt(
    "summarize_topic",
    {
      title: "Summarize a topic",
      description: "Summarize a topic in a given tone.",
      argsSchema: z.object({ topic: z.string(), tone: z.string().optional() }),
    },
    ({ topic, tone }) => ({
      messages: [
        { role: "user", content: { type: "text", text: `Summarize ${topic}${tone ? ` in a ${tone} tone` : ""}.` } },
      ],
    }),
  );

  server.registerResource(
    "today",
    "notes://today",
    { title: "Today's notes", description: "What happened today.", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: "Shipped the MCP client." }] }),
  );

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
