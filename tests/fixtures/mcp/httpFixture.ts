import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * A real Streamable HTTP MCP server on a loopback port, built with the SDK's
 * server classes. Its one tool, `whoami`, answers with the `x-token` header
 * of the request that called it — so a test can tell which connection (and
 * which credentials) a call went through.
 */
export interface HttpMcpFixture {
  url: string;
  /** `x-token` of every request the server received, in order. */
  seenTokens: string[];
  close(): Promise<void>;
}

export async function startHttpMcpFixture(): Promise<HttpMcpFixture> {
  const seenTokens: string[] = [];
  const handler = createMcpHandler(({ requestInfo }) => {
    const token = requestInfo?.headers.get("x-token") ?? "";
    const server = new McpServer({ name: "http-fixture", version: "1.0.0" });
    server.registerTool(
      "whoami",
      {
        description: "Report the credentials this call arrived with.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true },
      },
      async () => ({ content: [{ type: "text", text: JSON.stringify({ token }) }] }),
    );
    return server;
  });

  const server = http.createServer(async (req, res) => {
    const token = req.headers["x-token"];
    seenTokens.push(Array.isArray(token) ? token.join(",") : (token ?? ""));
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const response = await handler.fetch(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        ...(hasBody && { body: Buffer.concat(chunks) }),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenTokens,
    async close() {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
