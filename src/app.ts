// Express app: GET /health, and the MCP Streamable HTTP endpoint at /mcp (stateless).

import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { renderCarPage, renderMessagePage } from "./carPage";
import { quote } from "./pricing";
import { carPageUrl, findPhoto } from "./search";
import { loadData, warmUp } from "./sheets";
import { registerTools } from "./tools";

const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });

function requireBearer(req: Request, res: Response, next: NextFunction) {
  const expected = Buffer.from(`Bearer ${process.env.MCP_AUTH_TOKEN ?? ""}`);
  const given = Buffer.from(req.headers.authorization ?? "");
  const ok = !!process.env.MCP_AUTH_TOKEN && given.length === expected.length && timingSafeEqual(given, expected);
  if (!ok) {
    res.status(401).set("WWW-Authenticate", "Bearer").json(rpcError(-32001, "Unauthorized"));
    return;
  }
  next();
}

export const app = express();
app.use(express.json({ limit: "1mb" }));

// Health check that also warms the server: it signs in to Google and loads the cached tabs,
// so the next tool call does not pay for that. Replies "ok" with the time taken.
app.get("/health", async (_req, res) => {
  const started = Date.now();
  try {
    await warmUp();
    res.type("text/plain").send(`ok ${Date.now() - started}ms`);
  } catch (err) {
    console.error("[health] warm-up failed:", err instanceof Error ? err.message : err);
    res.status(503).type("text/plain").send(`degraded ${Date.now() - started}ms: Google Sheets is not reachable`);
  }
});

/** The public address of this server: PUBLIC_BASE_URL if set, otherwise worked out from the request. */
function publicBaseUrl(req: Request): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, "");
  const host = req.headers.host ?? "localhost";
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}

// Public car page: no auth, customer-facing details only.
app.get("/car/:car_id", async (req, res) => {
  const html = (status: number, body: string) => res.status(status).type("html").send(body);
  try {
    const { sheet, photos } = await loadData(["Photos"]);
    const wanted = String(req.params.car_id).trim().toLowerCase();
    const car = sheet.cars.find((c) => c.car_id.toLowerCase() === wanted);
    if (!car) {
      html(404, renderMessagePage("Car not found", "We could not find that car. It may have been sold, or the link may be incomplete."));
      return;
    }
    res.set("Cache-Control", "public, max-age=300");
    html(200, renderCarPage(car, quote(car, sheet.settings), findPhoto(photos, car), carPageUrl(publicBaseUrl(req), car.car_id)));
  } catch (err) {
    console.error("[car page] failed:", err instanceof Error ? err.message : err);
    html(503, renderMessagePage("Temporarily unavailable", "This page could not be loaded just now. Please try again in a minute."));
  }
});

app.use("/mcp", requireBearer);

app.post("/mcp", async (req, res) => {
  // Stateless: a fresh server and transport per request, so it works on serverless.
  const server = new McpServer({ name: "jeffworldwide", version: "1.0.0" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    registerTools(server, publicBaseUrl(req));
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", err);
    if (!res.headersSent) res.status(500).json(rpcError(-32603, "Internal server error"));
  }
});

// No sessions, so there is no SSE stream to open and nothing to delete.
app.all("/mcp", (_req, res) => {
  res.status(405).set("Allow", "POST").json(rpcError(-32000, "Method not allowed"));
});

// Malformed JSON bodies and anything else unexpected.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (!res.headersSent) res.status(400).json(rpcError(-32700, "Bad request"));
});

export default app;
