// Express app: GET /health, and the MCP Streamable HTTP endpoint at /mcp (stateless).

import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
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

app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok");
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
    registerTools(server);
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
