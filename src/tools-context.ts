// Context, capture, code relationship and task-assignment tools.

import { z } from "zod";
import type { Client } from "./client.js";
import { accessibleCodeGraphs, allTeamTasks } from "./blocks.js";
import { KnowledgeCapture } from "./capture.js";
import type { ContextOrchestrator } from "./context.js";
import type { Projects } from "./projects.js";
import type { ToolRegistrar } from "./tools.js";

const projectId = z.string().min(1).optional().describe("Project profile. Defaults to the active project.");
const budget = z
  .number()
  .int()
  .min(500)
  .max(100000)
  .optional()
  .describe("Approximate token budget for the package. Defaults to the project's budget, then 8000.");

export function registerContextTools(
  tool: ToolRegistrar,
  client: Client,
  projects: Projects,
  orchestrator: ContextOrchestrator
): void {
  const { agentId } = client.config;
  const capture = new KnowledgeCapture(client);

  tool(
    "get_development_context",
    "Primary entry point before a significant development task. Searches wiki, chat memory, code graph, skills and tasks, then ranks, deduplicates and fits the results to a token budget. shared_context and private_context are kept separate, and every item names its source_type, access_scope and id. Sources that fail are listed in 'warnings'. This does not replace reading the local source code. Returns { project, developer, task_summary, shared_context, private_context, constraints, related_files, outstanding_decisions, references, warnings, statistics }.",
    {
      task_description: z.string().min(1).max(2048),
      project_id: projectId,
      task_id: z.string().min(1).optional().describe("Task Board ID, if the work has one."),
      file_paths: z.array(z.string().min(1)).max(50).optional().describe("Files already known to be involved."),
      max_context_tokens: budget,
      include_private: z.boolean().optional().describe("Include this developer's own memory. Default true."),
    },
    ({ project_id, ...request }) => orchestrator.build(projects.get(project_id), request)
  );

  tool(
    "get_task_context",
    "get_development_context for a Task Board item: uses the task's title and description as the search. Returns the same package.",
    { task_id: z.string().min(1), project_id: projectId, max_context_tokens: budget },
    async ({ task_id, project_id, max_context_tokens }) => {
      const task = await client.panel("/meta/task/get", { task_id });
      return orchestrator.build(projects.get(project_id), {
        task_description: task.title,
        task_id,
        max_context_tokens,
      });
    }
  );

  tool(
    "search_project_knowledge",
    "Cheap search across all knowledge sources. Skips reading wiki page bodies, so results are mostly titles and short text. Use each item's 'fetch' to retrieve more. Returns the same package as get_development_context.",
    {
      query: z.string().min(1).max(2048),
      project_id: projectId,
      include_private: z.boolean().optional(),
      max_context_tokens: budget,
    },
    ({ query, project_id, include_private, max_context_tokens }) =>
      orchestrator.build(projects.get(project_id), {
        task_description: query,
        include_private,
        max_context_tokens: max_context_tokens ?? 2000,
        references_only: true,
      })
  );

  tool(
    "get_project_context",
    "Overview of a project: its profile, team, agents, wikis and code graphs, with no task-specific search. Sources this developer can't read are listed in 'warnings'. Returns { project, team, agents, wikis, code_graphs, warnings }.",
    { project_id: projectId },
    async ({ project_id }) => {
      const project = projects.get(project_id);
      const warnings: string[] = [];
      const safely = async <T>(label: string, run: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await run();
        } catch (error) {
          warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
          return undefined;
        }
      };
      const team_id = project.team_id;
      const [team, agents, wikis, graphs] = await Promise.all([
        safely("team", () => client.panel("/meta/team/get", { team_id })),
        safely("agents", () => client.panel("/meta/agent/list", { team_id, limit: 100, offset: 0 })),
        safely("wikis", () => client.panel("/knowledge/wiki/team-assets", { team_id })),
        safely("code_graphs", () => accessibleCodeGraphs(client, team_id)),
      ]);
      return {
        project,
        team,
        agents: agents?.items?.map(({ agent_id, name, description, owner_user_id, visibility, status }: any) => ({
          agent_id,
          name,
          description,
          owner_user_id,
          visibility,
          status,
          ...(agent_id === project.shared_agent_id ? { role: "shared_engineering_agent" } : {}),
        })),
        wikis: wikis?.items?.map(({ knowledge_id, name, status, page_count, summary }: any) => ({
          knowledge_id,
          name,
          status,
          page_count,
          summary,
        })),
        code_graphs: graphs,
        warnings,
      };
    }
  );

  tool(
    "save_development_decision",
    "Save a durable decision or outcome. 'scope' is required and nothing is promoted automatically. 'developer_private': this agent's memory; refused if its block is team-visible. 'team_shared': published to the team's decisions wiki, then ingested. 'documentation_candidate': written to the decisions wiki without ingest, for review. 'shared_engineering_agent': only from a session running as that agent. Refuses content that looks like a credential. Save decisions and results, not every command or status message. Returns { saved, scope, stored_in, ... }.",
    {
      title: z.string().min(1).max(200),
      decision: z.string().min(1).max(6000),
      scope: z.enum(["developer_private", "team_shared", "shared_engineering_agent", "documentation_candidate"]),
      rationale: z.string().max(2000).optional(),
      files: z.array(z.string().min(1)).max(50).optional(),
      tests: z.string().max(1000).optional().describe("Tests performed and their results."),
      outstanding: z.array(z.string().min(1)).max(20).optional().describe("Unresolved items."),
      project_id: projectId,
      session_id: z.string().min(1).optional(),
    },
    async ({ project_id, ...input }) => {
      const result = await capture.save(projects.get(project_id), input);
      if (result.saved) orchestrator.invalidate();
      return result;
    }
  );

  // ── Code relationships ───────────────────────────────────────────────────
  // MemoryKnowledge has no user identity, so the Panel's asset list decides access.

  async function readableGraphs(code_graph_id?: string, project_id?: string): Promise<any[]> {
    const project = projects.get(project_id);
    const graphs = (await accessibleCodeGraphs(client, project.team_id)).filter(
      (graph) => !project.code_graph_ids || project.code_graph_ids.includes(graph.knowledge_id)
    );
    if (!code_graph_id) return graphs;
    const match = graphs.filter((graph) => graph.knowledge_id === code_graph_id);
    if (match.length === 0) {
      throw new Error(`Code graph '${code_graph_id}' is not accessible to this developer.`);
    }
    return match;
  }

  async function perGraph(
    graphs: any[],
    run: (graph: any) => Promise<Record<string, unknown>>
  ): Promise<{ scope: string; items: unknown[]; graphs_searched: number; errors: unknown[] }> {
    const errors: unknown[] = [];
    const items = await Promise.all(
      graphs.map(async (graph) => {
        try {
          return [{ code_graph_id: graph.knowledge_id, name: graph.name, ...(await run(graph)) }];
        } catch (error) {
          errors.push({ code_graph_id: graph.knowledge_id, error: error instanceof Error ? error.message : String(error) });
          return [];
        }
      })
    );
    return { scope: "team", items: items.flat(), graphs_searched: graphs.length, errors };
  }

  const graphId = z.string().min(1).optional().describe("Defaults to every code graph this developer can read.");

  tool(
    "get_code_entity",
    "Details of a symbol: kind, location and signature, optionally with its source. Team-level. Access is checked through MemoryPanel before calling MemoryKnowledge. An empty 'text' means no match or a graph that isn't ready. Returns { scope, items: [{ code_graph_id, name, text }], graphs_searched, errors }.",
    {
      symbol: z.string().min(1),
      code_graph_id: graphId,
      include_code: z.boolean().optional(),
      file: z.string().min(1).optional().describe("Disambiguate by file."),
      line: z.number().int().min(1).optional().describe("Disambiguate by line."),
      project_id: projectId,
    },
    async ({ symbol, code_graph_id, include_code, file, line, project_id }) =>
      perGraph(await readableGraphs(code_graph_id, project_id), async (graph) => {
        const data = await client.knowledgeTool(graph.knowledge_id, "node", {
          symbol,
          ...(include_code === undefined ? {} : { includeCode: include_code }),
          ...(file ? { file } : {}),
          ...(line ? { line } : {}),
        });
        return { text: data.text };
      })
  );

  tool(
    "get_code_relationships",
    "Callers, callees and change impact of a symbol. 'relations' defaults to all three. Team-level. Access is checked through MemoryPanel before calling MemoryKnowledge. Returns { scope, items: [{ code_graph_id, name, callers, callees, impact }], graphs_searched, errors }, each relation as formatted text.",
    {
      symbol: z.string().min(1),
      relations: z.array(z.enum(["callers", "callees", "impact"])).min(1).optional(),
      code_graph_id: graphId,
      limit: z.number().int().min(1).max(200).optional(),
      depth: z.number().int().min(1).max(10).optional().describe("Impact depth."),
      project_id: projectId,
    },
    async ({ symbol, relations, code_graph_id, limit, depth, project_id }) =>
      perGraph(await readableGraphs(code_graph_id, project_id), async (graph) => {
        const wanted = relations ?? ["callers", "callees", "impact"];
        const entries = await Promise.all(
          wanted.map(async (relation) => {
            const params = relation === "impact" ? { symbol, ...(depth ? { depth } : {}) } : { symbol, ...(limit ? { limit } : {}) };
            const data = await client.knowledgeTool(graph.knowledge_id, relation, params);
            return [relation, data.text] as const;
          })
        );
        return Object.fromEntries(entries);
      })
  );

  tool(
    "find_related_files",
    "Find source files. 'query' explores files relevant to a topic; 'path' or 'pattern' lists indexed files. Provide query, or path/pattern. Team-level. Access is checked through MemoryPanel before calling MemoryKnowledge. Returns { scope, items: [{ code_graph_id, name, text }], graphs_searched, errors }.",
    {
      query: z.string().min(1).optional(),
      path: z.string().min(1).optional().describe("Directory prefix."),
      pattern: z.string().min(1).optional().describe("Glob, for example '*.tsx'."),
      max_files: z.number().int().min(1).max(200).optional(),
      code_graph_id: graphId,
      project_id: projectId,
    },
    async ({ query, path, pattern, max_files, code_graph_id, project_id }) => {
      if (!query && !path && !pattern) throw new Error("Provide 'query', 'path' or 'pattern'.");
      return perGraph(await readableGraphs(code_graph_id, project_id), async (graph) => {
        const data = query
          ? await client.knowledgeTool(graph.knowledge_id, "explore", { query, ...(max_files ? { maxFiles: max_files } : {}) })
          : await client.knowledgeTool(graph.knowledge_id, "files", {
              ...(path ? { path } : {}),
              ...(pattern ? { pattern } : {}),
              format: "flat",
            });
        return { text: data.text };
      });
    }
  );

  // ── Task assignments ─────────────────────────────────────────────────────

  tool(
    "get_my_tasks",
    "Tasks linked to this developer's agent, with status. Agent-specific view of team tasks. Returns { agent_id, items }.",
    { status: z.string().min(1).optional(), project_id: projectId },
    async ({ status, project_id }) => {
      const tasks = await allTeamTasks(client, projects.get(project_id).team_id, status);
      const items = tasks.filter((task) => (task.agents ?? []).some((agent: any) => agent.agent_id === agentId));
      return { agent_id: agentId, items };
    }
  );

  tool(
    "update_task_status",
    "Set a task's status. TencentDB allows this only for the task's creator; anyone else receives an authorization error. Returns the updated task.",
    { task_id: z.string().min(1), status: z.enum(["running", "completed"]) },
    ({ task_id, status }) => client.panel("/meta/task/update", { task_id, status })
  );
}
