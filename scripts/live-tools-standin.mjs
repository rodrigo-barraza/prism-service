// A stand-in tools-service for an ISOLATED prism-service live run
// (docs/prompts/README.md §Live).
//
// Narrowing a turn's `enabledTools` does not keep every tool out: core harness
// tools (save_memory, code execution) stay callable, and with TOOLS_SERVICE_URL
// pointed at the production tools-service they run there — a save_memory is
// forwarded on to the PRODUCTION prism-service (2026-09-22). Point the local
// prism here instead (TOOLS_SERVICE_URL=http://localhost:$STANDIN_PORT):
//   - GETs (tool schemas, config) proxy to the production tools-service, read-only;
//   - POST /agentic/memory/save is forwarded to the LOCAL prism exactly as
//     tools-service's AgenticRoutes does it — identity middleware with
//     traceContext, getTraceHeaders() on the way back — so a save round-trips
//     the real x-conversation-id / x-request-id hop;
//   - every other tool call is refused (403) and logged.
//
//   LOCAL_PRISM_PORT=<port> STANDIN_PORT=<port2> \
//     node scripts/live-tools-standin.mjs          (Bash run_in_background: true)
//
// Host and ports come from vault-service/projects.json (CLAUDE.md §0).
import fs from "node:fs";
import express from "express";
import {
  createAuthMiddleware,
  getTraceHeaders,
} from "@rodrigo-barraza/utilities-library/service";

const WORKSPACE = "/home/rodrigo/development";
const registry = JSON.parse(fs.readFileSync(`${WORKSPACE}/vault-service/projects.json`, "utf8"));
const toolsProject = registry.projects.find((project) => project.id === "tools-service");
const productionTools = `http://${registry.defaultHost}:${toolsProject.port}`;

const prismPort = process.env.LOCAL_PRISM_PORT;
const listenPort = Number(process.env.STANDIN_PORT);
if (!prismPort || !listenPort) {
  throw new Error("LOCAL_PRISM_PORT and STANDIN_PORT are required");
}
const localPrism = `http://localhost:${prismPort}`;

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(createAuthMiddleware({ traceContext: true }));

app.post("/agentic/memory/save", async (request, response) => {
  const { content, type, title } = request.body;
  console.log(`[standin] save_memory → local prism, headers ${JSON.stringify(getTraceHeaders())}`);
  const forwarded = await fetch(`${localPrism}/agent-memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getTraceHeaders() },
    body: JSON.stringify({
      agent: request.headers["x-agent"] || "CODING",
      project: request.headers["x-project"],
      username: request.headers["x-username"] || null,
      content,
      type: type || "project",
      title: title || null,
    }),
  });
  response.status(forwarded.status).json(await forwarded.json());
});

app.get(/.*/, async (request, response) => {
  const upstream = await fetch(`${productionTools}${request.originalUrl}`, {
    headers: { accept: "application/json" },
  });
  response
    .status(upstream.status)
    .type(upstream.headers.get("content-type") || "application/json")
    .send(Buffer.from(await upstream.arrayBuffer()));
});

app.all(/.*/, (request, response) => {
  console.log(`[standin] refused ${request.method} ${request.originalUrl}`);
  response.status(403).json({ error: "live-tools-standin: only save_memory is forwarded" });
});

app.listen(listenPort, () =>
  console.log(`[standin] tools stand-in on ${listenPort} → schemas from ${productionTools}, save_memory → ${localPrism}`),
);
