//import "dotenv/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Load .env from the adapter's root directory, not Claude's working directory.
const currentDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(currentDir, "..");
dotenv.config({ path: resolve(projectRoot, ".env") });

const config = {
  baseUrl: process.env.TENCENTDB_URL,
  apiKey: process.env.TENCENTDB_API_KEY,
  serviceId: process.env.TENCENTDB_SERVICE_ID || "default",
  teamId: process.env.TENCENTDB_TEAM_ID,
  agentId: process.env.TENCENTDB_AGENT_ID,
  userId: process.env.TENCENTDB_USER_ID,
};

for (const [name, value] of Object.entries(config)) {
  if (!value) {
    throw new Error(`Missing required configuration: ${name}`);
  }
}

const server = new McpServer({
  name: "tencentdb-project-memory",
  version: "1.0.0",
});

async function tencentRequest(
  endpoint: string,
  payload: Record<string, unknown>
): Promise<unknown> {
  const response = await fetch(`${config.baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "x-tdai-service-id": config.serviceId!,
      "x-tdai-team-id": config.teamId!,
      "x-tdai-agent-id": config.agentId!,
      "x-tdai-user-id": config.userId!,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  const responseText = await response.text();

  let result: any;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(
      `TencentDB returned non-JSON response (HTTP ${response.status}): ${responseText}`
    );
  }

  if (!response.ok || (typeof result.code === "number" && result.code !== 0)) {
    throw new Error(
      `TencentDB API error (HTTP ${response.status}): ${result.message || responseText}`
    );
  }

  return result.data ?? result;
}

function toolResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

// 1. Search L1 project memories.
server.tool(
  "search_memories",
  "Search TencentDB shared project memories. Use this before answering questions about project decisions, architecture, coding standards, and previous implementation work.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
    type: z.string().optional(),
  },
  async ({ query, limit, type }) => {
    try {
      const data = await tencentRequest("/v3/atomic/search", {
        query,
        limit: limit ?? 5,
        ...(type ? { type } : {}),
      });

      return toolResult(data);
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
);

// 2. Search previous conversation records.
server.tool(
  "search_conversations",
  "Search previous project conversations stored in TencentDB.",
  {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).optional(),
    session_id: z.string().optional(),
  },
  async ({ query, limit, session_id }) => {
    try {
      const data = await tencentRequest("/v3/conversation/search", {
        query,
        limit: limit ?? 5,
        ...(session_id ? { session_id } : {}),
      });

      return toolResult(data);
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
);

// 3. Save conversation messages.
server.tool(
  "save_conversation",
  "Save user and assistant messages to the shared TencentDB project memory.",
  {
    session_id: z.string().min(1),
    messages: z.array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
        recorded_at: z.string().optional(),
      })
    ).min(1),
  },
  async ({ session_id, messages }) => {
    try {
      const data = await tencentRequest("/v3/conversation/add", {
        session_id,
        messages,
      });

      return toolResult(data);
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
);

const transport = new StdioServerTransport();

await server.connect(transport);