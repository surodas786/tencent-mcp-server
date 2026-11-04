import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import type { Client } from "./client.js";
import { blockAgent, ownBlockId, teamBlocks as listTeamBlocks, type Block } from "./blocks.js";

const MAX_CONTENT_CHARS = 20000;

const scopeSchema = z
  .enum(["agent", "team"])
  .optional()
  .describe(
    "'agent' (default): only this developer's own agent memory. 'team': memory blocks shared with the team, via MemoryPanel ACLs. A team search that fails returns an error and never falls back to agent scope."
  );
const agentFilter = z
  .string()
  .min(1)
  .optional()
  .describe("Team scope only: restrict to the shared block of this agent ID.");
const blockFilter = z
  .string()
  .min(1)
  .optional()
  .describe("Team scope only: search this memory block ID directly (for example a borrowed block).");

export type ToolRegistrar = <S extends ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>
) => void;

export function registerTools(server: McpServer, client: Client): ToolRegistrar {
  const { teamId, agentId, userId, memoryAccess } = client.config;

  const tool: ToolRegistrar = (name, description, shape, handler) => {
    const run = async (args: any) => {
      try {
        const data = await handler(args);
        return {
          content: [{ type: "text" as const, text: client.redact(JSON.stringify(data, null, 2)) }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text" as const, text: client.redact(message) }] };
      }
    };
    (server.tool as any)(name, description, shape, run);
  };

  const agentSource = (layer: string, item: Record<string, any> = {}) => ({
    layer,
    scope: "agent",
    team_id: item.team_id ?? teamId,
    agent_id: item.agent_id ?? agentId,
    user_id: item.user_id ?? userId,
    session_id: item.session_id,
  });

  const blockSource = (layer: string, block: Block, scope: string) => ({
    layer,
    scope,
    team_id: teamId,
    agent_id: block.agent_id,
    owner_user_id: block.uploaded_by_user_id,
    block_id: block.id,
    block_title: block.title,
  });

  function rejectInScope(scope: string, fields: Record<string, unknown>): void {
    for (const [name, value] of Object.entries(fields)) {
      if (value !== undefined) {
        throw new Error(`'${name}' is not supported with scope '${scope}'.`);
      }
    }
  }

  /** Shared blocks the Panel lists for this team, optionally narrowed. */
  async function teamBlocks(agent?: string, blockId?: string): Promise<Block[]> {
    if (blockId) {
      return [{ id: blockId, agent_id: blockAgent(teamId, blockId) }];
    }
    const blocks = await listTeamBlocks(client, teamId);
    return agent ? blocks.filter((block) => block.agent_id === agent) : blocks;
  }

  /**
   * Blocks to read through the Panel, or undefined when agent scope uses MemoryCore.
   * Agent scope goes through the Panel by default because that is the path where
   * the server verifies the caller rather than trusting identity headers.
   */
  async function panelTarget(
    scope: string | undefined,
    agent?: string,
    blockId?: string
  ): Promise<{ scope: string; blocks: Block[] } | undefined> {
    if (scope === "team") return { scope: "team", blocks: await teamBlocks(agent, blockId) };
    rejectInScope("agent", { agent_id: agent, block_id: blockId });
    if (memoryAccess !== "panel") return undefined;
    return { scope: "agent", blocks: [{ id: ownBlockId(teamId, agentId), agent_id: agentId }] };
  }

  /** Runs one request per block, reporting failures instead of hiding them. */
  async function perBlock<T>(blocks: Block[], run: (block: Block) => Promise<T[]>) {
    const errors: { block_id: string; error: string }[] = [];
    const settled = await Promise.all(
      blocks.map(async (block) => {
        try {
          return await run(block);
        } catch (error) {
          errors.push({ block_id: block.id, error: error instanceof Error ? error.message : String(error) });
          return [];
        }
      })
    );
    return { items: settled.flat(), blocks_searched: blocks.length, errors };
  }

  /**
   * The Panel reads block data under the owner's real user ID, so anything this
   * adapter stored under another TENCENTDB_USER_ID value is not visible to it.
   */
  async function identityNote(): Promise<{ identity_warning?: string }> {
    const caller = await client.caller();
    return caller.user_id === userId
      ? {}
      : {
          identity_warning: `TENCENTDB_USER_ID is '${userId}' but this user's ID is '${caller.user_id}'. Memory saved under '${userId}' is not visible through team scope.`,
        };
  }

  function matches(query: string | undefined, ...fields: (string | null | undefined)[]): boolean {
    if (!query) return true;
    const haystack = fields.filter(Boolean).join("\n").toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
  }

  function clip(content: string | null | undefined) {
    const text = content ?? "";
    return text.length > MAX_CONTENT_CHARS
      ? { content: text.slice(0, MAX_CONTENT_CHARS), content_truncated: true }
      : { content: text };
  }

  // ── Chat Memory ──────────────────────────────────────────────────────────

  tool(
    "search_memories",
    "Keyword search of L1 atomic memories (episodic, persona, instruction). scope='agent' (default) searches only this developer's own agent memory. scope='team' searches blocks shared with the team, subject to MemoryPanel permissions. Every result carries a 'source' with layer, scope, team, agent, and session or block identifiers. Returns { scope, layer, items, ... }.",
    {
      query: z.string().min(1).max(2048),
      scope: scopeSchema,
      limit: z.number().int().min(1).max(100).optional(),
      type: z.enum(["episodic", "persona", "instruction"]).optional(),
      time_start: z.string().optional().describe("ISO 8601. Agent scope only."),
      time_end: z.string().optional().describe("ISO 8601. Agent scope only."),
      agent_id: agentFilter,
      block_id: blockFilter,
    },
    async ({ query, scope, limit, type, time_start, time_end, agent_id, block_id }) => {
      const target = await panelTarget(scope, agent_id, block_id);
      if (target) {
        rejectInScope(`${target.scope} via MemoryPanel`, { time_start, time_end });
        const result = await perBlock(target.blocks, async (block) => {
          const data = await client.panel("/chat-memory/search", {
            block_id: block.id,
            layer: "L1",
            query,
            limit: limit ?? 5,
            ...(type ? { type } : {}),
          });
          return (data.items ?? []).map((item: object) => ({ ...item, source: blockSource("L1", block, target.scope) }));
        });
        return { scope: target.scope, layer: "L1", ...result, ...(await identityNote()) };
      }
      const data = await client.core("/v3/atomic/search", {
        query,
        limit: limit ?? 5,
        ...(type ? { type } : {}),
        ...(time_start ? { time_start } : {}),
        ...(time_end ? { time_end } : {}),
      });
      return {
        scope: "agent",
        layer: "L1",
        items: (data.items ?? []).map((item: object) => ({ ...item, source: agentSource("L1", item) })),
      };
    }
  );

  tool(
    "search_conversations",
    "Keyword search of L0 raw conversation messages. scope='agent' (default) searches only this developer's own agent conversations and supports session and time filters. scope='team' searches blocks shared with the team, subject to MemoryPanel permissions, across all sessions. Every result carries a 'source'. Returns { scope, layer, messages|items, ... }.",
    {
      query: z.string().min(1).max(2048),
      scope: scopeSchema,
      limit: z.number().int().min(1).max(100).optional(),
      session_id: z.string().optional().describe("Agent scope only."),
      time_start: z.string().optional().describe("ISO 8601. Agent scope only."),
      time_end: z.string().optional().describe("ISO 8601. Agent scope only."),
      agent_id: agentFilter,
      block_id: blockFilter,
    },
    async ({ query, scope, limit, session_id, time_start, time_end, agent_id, block_id }) => {
      const target = await panelTarget(scope, agent_id, block_id);
      if (target) {
        rejectInScope(`${target.scope} via MemoryPanel`, { session_id, time_start, time_end });
        const result = await perBlock(target.blocks, async (block) => {
          const data = await client.panel("/chat-memory/search", {
            block_id: block.id,
            layer: "L0",
            query,
            limit: limit ?? 5,
          });
          return (data.items ?? []).map((item: object) => ({ ...item, source: blockSource("L0", block, target.scope) }));
        });
        return { scope: target.scope, layer: "L0", ...result, ...(await identityNote()) };
      }
      const data = await client.core("/v3/conversation/search", {
        query,
        limit: limit ?? 5,
        ...(session_id ? { session_id } : {}),
        ...(time_start ? { time_start } : {}),
        ...(time_end ? { time_end } : {}),
      });
      return {
        scope: "agent",
        layer: "L0",
        messages: (data.messages ?? []).map((item: object) => ({ ...item, source: agentSource("L0", item) })),
      };
    }
  );

  tool(
    "search_scenario_memories",
    "Find L2 scenario memory files. TencentDB has no L2 search API, so this lists the files, reads up to max_files of them, and filters in the adapter: every query term must appear in the path, summary or content. 'files_scanned' and 'files_total' show how much was covered. scope='agent' (default) covers this developer's own agent; scope='team' covers blocks shared with the team, subject to MemoryPanel permissions.",
    {
      query: z.string().min(1).max(2048),
      scope: scopeSchema,
      path_prefix: z.string().optional().describe("Agent scope only."),
      max_files: z.number().int().min(1).max(50).optional().describe("Files to read per block or agent. Default 20."),
      agent_id: agentFilter,
      block_id: blockFilter,
    },
    async ({ query, scope, path_prefix, max_files, agent_id, block_id }) => {
      const cap = max_files ?? 20;
      const target = await panelTarget(scope, agent_id, block_id);
      if (target) {
        rejectInScope(`${target.scope} via MemoryPanel`, { path_prefix });
        let filesTotal = 0;
        let filesScanned = 0;
        const result = await perBlock(target.blocks, async (block) => {
          const listing = await client.panel("/chat-memory/layer", { block_id: block.id, layer: "L2", limit: 200 });
          const paths: string[] = (listing.items ?? []).map((item: any) => item.title);
          filesTotal += paths.length;
          const read = paths.slice(0, cap);
          filesScanned += read.length;
          const files = await Promise.all(
            read.map(async (path) => {
              const file = await client.panel("/chat-memory/layer", { block_id: block.id, layer: "L2", path });
              return { path, content: file.items?.[0]?.body as string | undefined };
            })
          );
          return files
            .filter((file) => matches(query, file.path, file.content))
            .map((file) => ({ path: file.path, ...clip(file.content), source: blockSource("L2", block, target.scope) }));
        });
        return {
          scope: target.scope,
          layer: "L2",
          match_mode: "adapter_side_terms",
          files_total: filesTotal,
          files_scanned: filesScanned,
          ...result,
          ...(await identityNote()),
        };
      }
      const listing = await client.core("/v3/scenario/ls", path_prefix ? { path_prefix } : {});
      const entries: any[] = (listing.entries ?? []).filter((entry: any) => !String(entry.path).endsWith("/"));
      const read = entries.slice(0, cap);
      const files = await Promise.all(
        read.map(async (entry) => ({
          entry,
          file: await client.core("/v3/scenario/read", { path: entry.path }),
        }))
      );
      return {
        scope: "agent",
        layer: "L2",
        match_mode: "adapter_side_terms",
        files_total: entries.length,
        files_scanned: read.length,
        items: files
          .filter(({ entry, file }) => matches(query, entry.path, entry.summary, file.content))
          .map(({ entry, file }) => ({
            path: entry.path,
            summary: entry.summary,
            updated_at: entry.updated_at,
            ...clip(file.content),
            source: agentSource("L2", entry),
          })),
      };
    }
  );

  tool(
    "search_core_memories",
    "Read L3 core memory (persona). TencentDB has no L3 search API, so this reads the document and, when query is given, filters in the adapter: every query term must appear in it. scope='agent' (default) reads this developer's own agent; scope='team' reads blocks shared with the team, subject to MemoryPanel permissions.",
    {
      query: z.string().min(1).max(2048).optional().describe("Omit to return the core memory unfiltered."),
      scope: scopeSchema,
      agent_id: agentFilter,
      block_id: blockFilter,
    },
    async ({ query, scope, agent_id, block_id }) => {
      const target = await panelTarget(scope, agent_id, block_id);
      if (target) {
        const result = await perBlock(target.blocks, async (block) => {
          const data = await client.panel("/chat-memory/layer", { block_id: block.id, layer: "L3" });
          return (data.items ?? [])
            .filter((item: any) => item.body && matches(query, item.body))
            .map((item: any) => ({ ...clip(item.body), created_at: item.created_at, source: blockSource("L3", block, target.scope) }));
        });
        return { scope: target.scope, layer: "L3", match_mode: "adapter_side_terms", ...result, ...(await identityNote()) };
      }
      const data = await client.core("/v3/core/read", {});
      const found = data.content && matches(query, data.content);
      return {
        scope: "agent",
        layer: "L3",
        match_mode: "adapter_side_terms",
        items: found
          ? [{ ...clip(data.content), updated_at: data.updated_at, source: agentSource("L3", data) }]
          : [],
      };
    }
  );

  tool(
    "save_conversation",
    "Save user and assistant messages to this developer's own agent memory (L0). This is agent-specific and shares nothing by itself, but if this agent's block is team-visible the team can read it. Prefer save_development_decision for durable knowledge. Returns { block_id, session_id, accepted_count } through MemoryPanel, or { accepted_ids, accepted_versions, total_count } through MemoryCore.",
    {
      session_id: z.string().min(1),
      messages: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1).max(8192),
            recorded_at: z.string().optional(),
          })
        )
        .min(1)
        .max(100),
    },
    ({ session_id, messages }) =>
      memoryAccess === "panel"
        ? client.panel("/chat-memory/import", {
            team_id: teamId,
            agent_id: agentId,
            session_id,
            messages: messages.map(({ recorded_at, ...message }) => ({
              ...message,
              ...(recorded_at ? { ts: recorded_at } : {}),
            })),
          })
        : client.core("/v3/conversation/add", { session_id, messages })
  );

  // ── Wiki Knowledge Base ──────────────────────────────────────────────────

  const wikiAssets = async () =>
    (await client.panel("/knowledge/wiki/team-assets", { team_id: teamId })).items ?? [];

  tool(
    "list_wiki_documents",
    "List the wikis this developer can access in the team, with IDs, names, status and page counts. Pass wiki_id to also list that wiki's pages and raw source files. Team-level, enforced by MemoryPanel permissions. Returns { scope, items } or { scope, wiki_id, pages, raw_files }.",
    { wiki_id: z.string().min(1).optional() },
    async ({ wiki_id }) => {
      if (!wiki_id) return { scope: "team", items: await wikiAssets() };
      const [pages, raw] = await Promise.all([
        client.panel("/knowledge/wiki/page/ls", { wiki_id }),
        client.panel("/knowledge/wiki/raw/ls", { wiki_id }),
      ]);
      const list: any[] = pages.items ?? pages.pages ?? [];
      return {
        scope: "team",
        wiki_id,
        pages: list.map(({ id, title, type, description }) => ({ ref: id, title, type, description })),
        raw_files: (raw.items ?? raw.files ?? []).map(({ filename, status }: any) => ({ filename, status })),
      };
    }
  );

  tool(
    "search_wiki",
    "Full-text (BM25) search of wiki pages. Searches one wiki when wiki_id is given, otherwise every ready wiki this developer can access in the team. Team-level, enforced by MemoryPanel permissions. Use get_wiki_document with a result's wiki_id and ref to read the page. Returns { scope, items, wikis_searched, errors }.",
    {
      query: z.string().min(1),
      wiki_id: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ query, wiki_id, limit }) => {
      const wikis: any[] = wiki_id
        ? [{ knowledge_id: wiki_id }]
        : (await wikiAssets()).filter((wiki: any) => wiki.status === "ready");
      const errors: { wiki_id: string; error: string }[] = [];
      const hits = await Promise.all(
        wikis.map(async (wiki) => {
          try {
            const data = await client.panel("/knowledge/wiki/search", {
              wiki_id: wiki.knowledge_id,
              query,
              limit: limit ?? 10,
            });
            // 'related' link lists are large and rarely useful in a result list.
            return (data.results ?? []).map(({ related, path, ref, ...hit }: any) => ({
              ...hit,
              ref: ref ?? path,
              wiki_id: wiki.knowledge_id,
              wiki_name: wiki.name,
            }));
          } catch (error) {
            errors.push({ wiki_id: wiki.knowledge_id, error: error instanceof Error ? error.message : String(error) });
            return [];
          }
        })
      );
      return { scope: "team", items: hits.flat(), wikis_searched: wikis.length, errors };
    }
  );

  tool(
    "get_wiki_document",
    "Read the full content of wiki pages (refs) or raw source files (filenames). Provide exactly one of the two. Team-level, enforced by MemoryPanel permissions. Returns { scope, wiki_id, items }.",
    {
      wiki_id: z.string().min(1),
      refs: z.array(z.string().min(1)).min(1).max(20).optional().describe("Page refs from search_wiki or list_wiki_documents."),
      filenames: z.array(z.string().min(1)).min(1).max(20).optional().describe("Raw file names from list_wiki_documents."),
    },
    async ({ wiki_id, refs, filenames }) => {
      if (!refs === !filenames) throw new Error("Provide exactly one of 'refs' or 'filenames'.");
      const data = refs
        ? await client.panel("/knowledge/wiki/page/read", { wiki_id, refs })
        : await client.panel("/knowledge/wiki/raw/read", { wiki_id, filenames });
      return { scope: "team", wiki_id, items: data.items ?? data.pages ?? data };
    }
  );

  // ── Code Graph ───────────────────────────────────────────────────────────

  tool(
    "search_code_graph",
    "Search symbols and files in code graphs. Searches one graph when code_graph_id is given, otherwise every code graph this developer can access in the team. Team-level, enforced by MemoryPanel permissions. TencentDB returns each graph's result as formatted text. Returns { scope, items: [{ code_graph_id, name, text }], graphs_searched, errors }.",
    {
      query: z.string().min(1),
      code_graph_id: z.string().min(1).optional(),
      kind: z.enum(["symbol", "file", "any"]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ query, code_graph_id, kind, limit }) => {
      const graphs: any[] = code_graph_id
        ? [{ knowledge_id: code_graph_id }]
        : (await client.panel("/knowledge/code-graph/team-assets", { team_id: teamId })).items ?? [];
      const errors: { code_graph_id: string; error: string }[] = [];
      const items = await Promise.all(
        graphs.map(async (graph) => {
          try {
            const data = await client.panel("/knowledge/code-graph/search", {
              code_graph_id: graph.knowledge_id,
              query,
              ...(kind ? { kind } : {}),
              ...(limit ? { limit } : {}),
            });
            return [{ code_graph_id: graph.knowledge_id, name: graph.name, text: data.text }];
          } catch (error) {
            errors.push({
              code_graph_id: graph.knowledge_id,
              error: error instanceof Error ? error.message : String(error),
            });
            return [];
          }
        })
      );
      return { scope: "team", items: items.flat(), graphs_searched: graphs.length, errors };
    }
  );

  // ── Skills ───────────────────────────────────────────────────────────────

  const skillIds = { team_id: teamId, agent_id: agentId, user_id: userId };
  const skillScope = z
    .enum(["team", "agent"])
    .optional()
    .describe("'team' (default): skills across the team. 'agent': only skills owned by this developer's agent.");

  tool(
    "list_skills",
    "List active skills. scope='team' (default) lists the team's skills; scope='agent' lists only skills owned by this developer's agent. Returns { scope, items, total }.",
    {
      scope: skillScope,
      name_prefix: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    },
    async ({ scope, name_prefix, limit, offset }) => {
      const data = await client.panel("/skill/list", {
        ...skillIds,
        filters: {
          ...(scope === "agent" ? { owner_agent_id: agentId } : {}),
          ...(name_prefix ? { name_prefix } : {}),
        },
        pagination: { limit: limit ?? 50, offset: offset ?? 0 },
      });
      return { scope: scope ?? "team", ...data };
    }
  );

  tool(
    "search_skills",
    "Search skills by query. scope='team' (default) searches across the team; scope='agent' keeps the owner filter for this developer's agent. Returns { scope, items } with score and snippet.",
    {
      query: z.string().min(1).max(2048),
      scope: skillScope,
      top_k: z.number().int().min(1).max(50).optional(),
      mode: z.enum(["bm25", "embedding", "hybrid"]).optional(),
    },
    async ({ query, scope, top_k, mode }) => {
      const data = await client.panel("/skill/search", {
        ...skillIds,
        query,
        ...(top_k ? { top_k } : {}),
        ...(mode ? { mode } : {}),
        ...(scope === "agent" ? {} : { scope: "team" }),
      });
      return { scope: scope ?? "team", ...data };
    }
  );

  tool(
    "get_skill",
    "Get one skill by skill_id, including its content and manifest. Skills are readable across the team, enforced by TencentDB. Returns the skill detail.",
    {
      skill_id: z.string().min(1),
      version: z.number().int().min(1).optional(),
      include_content: z.boolean().optional(),
      include_manifest: z.boolean().optional(),
    },
    ({ skill_id, version, include_content, include_manifest }) =>
      client.panel("/skill/get", {
        ...skillIds,
        skill_id,
        ...(version ? { version } : {}),
        ...(include_content === undefined ? {} : { include_content }),
        ...(include_manifest === undefined ? {} : { include_manifest }),
      })
  );

  // ── Task Board ───────────────────────────────────────────────────────────

  tool(
    "search_tasks",
    "List the team's tasks with their linked agents, optionally filtered by title and status. Team-level, enforced by MemoryPanel permissions. Returns { items, total, limit, offset }.",
    {
      title: z.string().min(1).optional(),
      status: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    ({ title, status, limit, offset }) =>
      client.panel("/task/list-with-agents", {
        team_id: teamId,
        limit: limit ?? 20,
        offset: offset ?? 0,
        ...(title ? { title } : {}),
        ...(status ? { status } : {}),
      })
  );

  tool(
    "get_task",
    "Get one task by task_id. Readable by the creator and active team members; anything else returns not found. Returns the task.",
    { task_id: z.string().min(1) },
    ({ task_id }) => client.panel("/meta/task/get", { task_id })
  );

  // ── Team and Agent Information ───────────────────────────────────────────

  tool(
    "get_team",
    "Get the configured team's details. Team-level, enforced by MemoryPanel permissions. Returns { team_id, name, description, owner_user_id, status, created_at, updated_at }.",
    {},
    () => client.panel("/meta/team/get", { team_id: teamId })
  );

  tool(
    "list_team_agents",
    "List the agents in the configured team that this developer may see: their own, plus agents with visibility=team. Returns { items, total, limit, offset }.",
    {
      status: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
    ({ status, name, limit, offset }) =>
      client.panel("/meta/agent/list", {
        team_id: teamId,
        limit: limit ?? 20,
        offset: offset ?? 0,
        ...(status ? { status } : {}),
        ...(name ? { name } : {}),
      })
  );

  tool(
    "get_agent",
    "Get one agent by ID, defaulting to this developer's own agent. Other agents are readable only with visibility=team; otherwise TencentDB returns not found. Returns the agent.",
    { agent_id: z.string().min(1).optional() },
    ({ agent_id }) => client.panel("/meta/agent/get", { agent_id: agent_id ?? agentId })
  );

  return tool;
}
