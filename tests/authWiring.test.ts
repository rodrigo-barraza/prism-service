/**
 * How the service is wired for authentication (src/index.ts, which cannot be
 * imported in a test — it starts the server): every router is mounted after
 * AuthMiddleware, /admin and POST /files/gc sit behind the admin role, and
 * the WebSocket server accepts only upgrades the HTTP server authenticated.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import supertest from "supertest";
import "./setup.ts";
import { ADMIN_ROLE, authMiddleware } from "#src/middleware/AuthMiddleware";
import { userHeaders, serviceHeaders } from "./helpers/auth.ts";

vi.mock("#src/services/FileGarbageCollectionService", () => ({
  default: { run: vi.fn(async () => ({ dryRun: true, deleted: 0 })) },
}));

const INDEX = readFileSync(join(import.meta.dirname, "..", "src", "index.ts"), "utf8");
const lines = INDEX.split("\n");
const lineOf = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));

describe("src/index.ts", () => {
  it("authenticates before any route: nothing but CORS, the body parser and the request logger runs first", () => {
    const authLine = lineOf(/^app\.use\(authMiddleware\);$/);
    expect(authLine).toBeGreaterThan(0);
    const routeLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^app\.(use|get|post|put|patch|delete)\(/.test(line))
      .filter(({ line }) => !/^app\.use\((cors|express\.json|requestLoggerMiddleware|authMiddleware|errorHandler)\b/.test(line))
      .filter(({ line }) => !/^app\.use\($/.test(line));
    expect(routeLines.length).toBeGreaterThan(40);
    for (const { line, index } of routeLines) expect(index, line).toBeGreaterThan(authLine);
    // The middleware call that opens with `app.use(` on its own line is CORS.
    expect(lineOf(/^app\.use\($/)).toBeLessThan(authLine);
  });

  it("mounts /admin behind the admin role", () => {
    expect(INDEX).toMatch(/^app\.use\("\/admin", requireAdmin, adminRouter\);$/m);
  });

  it("accepts only authenticated WebSocket upgrades", () => {
    expect(INDEX).toContain("new WebSocketServer({ noServer: true })");
    expect(INDEX).toContain("setupWebSocket(wss, server)");
  });
});

const { default: filesRouter } = await import("#src/routes/FilesRoutes");

describe("POST /files/gc — admin only; GET /files/<key> stays public", () => {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use("/files", filesRouter);
  const http = supertest(app);

  it("a user without the admin role, or a service, is refused", async () => {
    await http.post("/files/gc").set(userHeaders("rodrigo")).send({}).expect(403);
    await http.post("/files/gc").set(serviceHeaders("rodrigo")).send({}).expect(403);
    await http.post("/files/gc").send({}).expect(401);
  });

  it("an admin runs it", async () => {
    const response = await http.post("/files/gc").set(userHeaders("rodrigo", { roles: [ADMIN_ROLE] })).send({}).expect(200);
    expect(response.body).toMatchObject({ dryRun: true });
  });

  it("an upload signs in; a media GET does not", async () => {
    await http.post("/files/upload").send({ data: "data:image/png;base64,AAAA" }).expect(401);
    const media = await http.get("/files/files/missing.png");
    expect(media.status).not.toBe(401);
  });
});
