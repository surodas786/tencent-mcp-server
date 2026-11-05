// Streamable HTTP transport, for running the adapter on a remote host.
// The server's .env holds what is shared. Each MCP client sends its own user key,
// user ID and agent ID as headers, and each session gets its own server and Client,
// the same isolation a developer's stdio process has.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./client.js";

const MCP_PATH = "/mcp";
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8787;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const SESSION_SWEEP_MS = 10 * 60 * 1000;

// Hyphens, because proxies such as nginx drop header names containing underscores.
const IDENTITY_HEADERS = {
  TENCENTDB_USER_KEY: "x-tencentdb-user-key",
  TENCENTDB_USER_ID: "x-tencentdb-user-id",
  TENCENTDB_AGENT_ID: "x-tencentdb-agent-id",
};

type Identity = Record<string, string>;

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  identity: Identity;
  lastSeen: number;
}

function readIdentity(req: IncomingMessage): { identity: Identity; missing: string[] } {
  const identity: Identity = {};
  const missing: string[] = [];
  for (const [name, header] of Object.entries(IDENTITY_HEADERS)) {
    const value = req.headers[header];
    if (typeof value === "string" && value.trim()) identity[name] = value.trim();
    else missing.push(header);
  }
  return { identity, missing };
}

const sameIdentity = (a: Identity, b: Identity) =>
  Object.keys(IDENTITY_HEADERS).every((name) => a[name] === b[name]);

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function startHttpServer(createAdapter: (env: NodeJS.ProcessEnv) => McpServer): Promise<void> {
  // Report bad shared configuration now, not on the first client's connection.
  const placeholders = Object.fromEntries(Object.keys(IDENTITY_HEADERS).map((name) => [name, "startup-check"]));
  const shared = { ...process.env, ...placeholders };
  if (loadConfig(shared).memoryAccess !== "panel") {
    // Core access trusts the user ID it is given, so a header could claim anyone's identity.
    throw new Error("HTTP transport requires TENCENTDB_MEMORY_ACCESS=panel and TENCENTDB_PANEL_URL.");
  }
  createAdapter(shared);

  const host = process.env.TENCENTDB_MCP_HOST || DEFAULT_HOST;
  const port = Number(process.env.TENCENTDB_MCP_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TENCENTDB_MCP_PORT must be a port number.");
  }

  const sessions = new Map<string, Session>();

  async function openSession(req: IncomingMessage, res: ServerResponse, identity: Identity): Promise<void> {
    // Identity headers replace the server's values, so one client can never inherit another's.
    const server = createAdapter({ ...process.env, ...identity });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport, identity, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
    // Anything other than an initialize request is refused by the transport and opens no session.
    if (!transport.sessionId) await server.close();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (new URL(req.url ?? "/", "http://adapter").pathname !== MCP_PATH) {
      return sendError(res, 404, `Not found. The MCP endpoint is ${MCP_PATH}.`);
    }

    // 400 rather than 401, which would send MCP clients into an OAuth flow this server doesn't offer.
    const { identity, missing } = readIdentity(req);
    if (missing.length > 0) {
      return sendError(res, 400, `Missing required headers: ${missing.join(", ")}.`);
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string") {
      if (req.method !== "POST") return sendError(res, 400, "Mcp-Session-Id header is required.");
      return openSession(req, res, identity);
    }

    const session = sessions.get(sessionId);
    if (!session) return sendError(res, 404, "Session not found.");
    if (!sameIdentity(session.identity, identity)) {
      return sendError(res, 403, "This session belongs to a different identity.");
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res);
  }

  setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const session of sessions.values()) {
      if (session.lastSeen < cutoff) session.server.close().catch(() => undefined);
    }
  }, SESSION_SWEEP_MS).unref();

  const httpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, "Internal server error.");
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  console.error(`TencentDB MCP adapter listening on http://${host}:${port}${MCP_PATH}`);
}
