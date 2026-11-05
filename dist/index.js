import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client, loadConfig } from "./client.js";
import { ContextOrchestrator } from "./context.js";
import { startHttpServer } from "./http.js";
import { loadProjects } from "./projects.js";
import { registerTools } from "./tools.js";
import { registerContextTools } from "./tools-context.js";
// Load .env from the adapter's root directory, not Claude's working directory.
const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "..");
dotenv.config({ path: resolve(projectRoot, ".env") });
function createAdapter(env) {
    const server = new McpServer({
        name: "tencentdb-project-memory",
        version: "3.0.0",
    });
    const config = loadConfig(env);
    const client = new Client(config);
    const projects = loadProjects(env, config);
    const cacheSeconds = Number(env.TENCENTDB_CONTEXT_CACHE_SECONDS ?? 300);
    const tool = registerTools(server, client);
    registerContextTools(tool, client, projects, new ContextOrchestrator(client, cacheSeconds));
    return server;
}
const transport = process.env.TENCENTDB_MCP_TRANSPORT || "stdio";
if (transport === "http") {
    await startHttpServer(createAdapter);
}
else if (transport === "stdio") {
    await createAdapter(process.env).connect(new StdioServerTransport());
}
else {
    throw new Error("TENCENTDB_MCP_TRANSPORT must be 'stdio' or 'http'.");
}
