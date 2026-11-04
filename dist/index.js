import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client, loadConfig } from "./client.js";
import { ContextOrchestrator } from "./context.js";
import { loadProjects } from "./projects.js";
import { registerTools } from "./tools.js";
import { registerContextTools } from "./tools-context.js";
// Load .env from the adapter's root directory, not Claude's working directory.
const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "..");
dotenv.config({ path: resolve(projectRoot, ".env") });
const server = new McpServer({
    name: "tencentdb-project-memory",
    version: "3.0.0",
});
const config = loadConfig(process.env);
const client = new Client(config);
const projects = loadProjects(process.env, config);
const cacheSeconds = Number(process.env.TENCENTDB_CONTEXT_CACHE_SECONDS ?? 300);
const tool = registerTools(server, client);
registerContextTools(tool, client, projects, new ContextOrchestrator(client, cacheSeconds));
await server.connect(new StdioServerTransport());
