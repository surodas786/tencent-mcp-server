// Builds one compact, source-labelled context package from every knowledge source.

import type { Client } from "./client.js";
import { accessibleCodeGraphs, allTeamTasks, ownBlockId, ownBlockVisibility, teamBlocks } from "./blocks.js";
import { DEFAULT_CONTEXT_TOKENS, type Project } from "./projects.js";

export type AccessScope = "team_shared" | "shared_engineering_agent" | "agent_private" | "agent_own_team_visible";

export type SourceType = "wiki" | "task" | "skill" | "team_memory" | "own_memory" | "own_conversation" | "code_graph";

export interface ContextRequest {
  task_description: string;
  task_id?: string;
  file_paths?: string[];
  max_context_tokens?: number;
  include_private?: boolean;
  /** Skip reading page bodies: rank titles and return references. */
  references_only?: boolean;
}

interface Candidate {
  source_type: SourceType;
  access_scope: AccessScope;
  id: string;
  title: string;
  text: string;
  /** Title used for scoring, when the display title has words that say nothing about relevance. */
  match_title?: string;
  server_score?: number;
  owner?: string;
  fetch: { tool: string; args: Record<string, unknown> };
}

interface SourceStat {
  source: string;
  results: number;
  latency_ms: number;
  error?: string;
}

// Authoritative documentation outranks recollection of it.
const AUTHORITY: Record<SourceType, number> = {
  task: 1,
  wiki: 1,
  code_graph: 0.9,
  team_memory: 0.85,
  skill: 0.8,
  own_memory: 0.7,
  own_conversation: 0.5,
};

const STOPWORDS = new Set(
  "the and for with that this from into according implement add fix modify update change create make use using new existing please should must module project specifications task code feature support".split(
    " "
  )
);

const MAX_TERMS = 8;
const MAX_WIKI_PAGES = 6;
const MAX_REFERENCES = 10;
const MAX_SCENARIO_FILES = 10;
// The item budget leaves room for the package's own structure and statistics.
const ITEM_BUDGET_SHARE = 0.7;
const NEAR_DUPLICATE = 0.85;

export function extractTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(words)].filter((word) => word.length >= 3 && !STOPWORDS.has(word)).slice(0, MAX_TERMS);
}

/** Estimate only: about 4 characters per token, and 1 per CJK character. */
export function estimateTokens(text: string): number {
  const cjk = text.match(/[　-鿿가-힯]/g)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** Wiki pages start with YAML front matter that costs tokens and says little. */
const stripFrontMatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n+/, "");

function coverage(terms: string[], text: string): number {
  if (terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length / terms.length;
}

function score(candidate: Candidate, terms: string[]): number {
  const lexical = coverage(terms, `${candidate.match_title ?? candidate.title}\n${candidate.text}`);
  const server = Math.min(Math.max(candidate.server_score ?? 0, 0), 1);
  return (0.7 * lexical + 0.3 * server) * AUTHORITY[candidate.source_type];
}

const wordSet = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Cuts text to a token limit, centred on the first matched term. */
function excerpt(text: string, terms: string[], maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lower = text.toLowerCase();
  const hits = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const anchor = hits.length ? Math.min(...hits) : 0;
  let start = Math.max(0, anchor - 200);
  let length = maxTokens * 4;
  while (length > 0 && estimateTokens(text.slice(start, start + length)) > maxTokens) {
    length = Math.floor(length * 0.8);
  }
  if (start + length > text.length) start = Math.max(0, text.length - length);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + length)}…`;
}

export class ContextOrchestrator {
  private cache = new Map<string, { expires: number; value: any }>();

  constructor(
    private readonly client: Client,
    private readonly cacheSeconds: number
  ) {}

  invalidate(): void {
    this.cache.clear();
  }

  async build(project: Project, request: ContextRequest): Promise<any> {
    const key = JSON.stringify([project.id, request]);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return { ...cached.value, statistics: { ...cached.value.statistics, cache_hit: true } };
    }
    const value = await this.assemble(project, request);
    if (this.cacheSeconds > 0) {
      this.cache.set(key, { expires: Date.now() + this.cacheSeconds * 1000, value });
    }
    return value;
  }

  private async assemble(project: Project, request: ContextRequest): Promise<any> {
    const started = Date.now();
    const { agentId, userId } = this.client.config;
    const caller = await this.client.caller();
    const budget = request.max_context_tokens ?? project.max_context_tokens ?? DEFAULT_CONTEXT_TOKENS;
    const stats: SourceStat[] = [];

    const task = request.task_id ? await this.fetchTask(request.task_id, stats) : undefined;
    const description = [request.task_description, task?.title, task?.description].filter(Boolean).join(" ");
    const pathTerms = (request.file_paths ?? []).flatMap((path) => path.split(/[\\/]/).slice(-1));
    const terms = extractTerms(`${description} ${pathTerms.join(" ")}`);
    const query = terms.join(" ");

    const gather = async (source: string, run: () => Promise<Candidate[]>): Promise<Candidate[]> => {
      const begun = Date.now();
      try {
        const items = await run();
        stats.push({ source, results: items.length, latency_ms: Date.now() - begun });
        return items;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stats.push({ source, results: 0, latency_ms: Date.now() - begun, error: message });
        return [];
      }
    };

    const groups = await Promise.all([
      gather("wiki", () => this.wiki(project, query, terms, request.references_only)),
      gather("team_memory", () => this.teamMemory(project, query)),
      gather("code_graph", () => this.codeGraph(project, terms)),
      gather("skills", () => this.skills(project, query)),
      gather("tasks", () => this.myTasks(project, terms)),
      ...(request.include_private === false ? [] : [gather("own_memory", () => this.ownMemory(project, query))]),
    ]);

    const taskItem: Candidate[] = task
      ? [
          {
            source_type: "task",
            access_scope: "team_shared",
            id: task.task_id,
            title: task.title,
            text: `${task.title}\n${task.description ?? ""}\nStatus: ${task.status}`,
            server_score: 1,
            fetch: { tool: "get_task", args: { task_id: task.task_id } },
          },
        ]
      : [];

    const retrieved = [...taskItem, ...groups.flat()];
    const relevant = retrieved
      .map((candidate) => ({ candidate, score: score(candidate, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    const itemBudget = Math.floor(budget * ITEM_BUDGET_SHARE);
    const perItem = Math.max(100, Math.min(1200, Math.floor(itemBudget / 4)));
    const seen: Set<string>[] = [];
    const selected: any[] = [];
    const overflow: any[] = [];
    let used = 0;
    let duplicates = 0;

    for (const { candidate, score: relevance } of relevant) {
      const words = wordSet(candidate.text);
      if (seen.some((other) => similarity(words, other) >= NEAR_DUPLICATE)) {
        duplicates++;
        continue;
      }
      seen.push(words);
      const text = excerpt(candidate.text, terms, perItem);
      const cost = estimateTokens(text) + estimateTokens(candidate.title) + 40;
      const reference = {
        source_type: candidate.source_type,
        access_scope: candidate.access_scope,
        id: candidate.id,
        title: candidate.title,
        relevance: Number(relevance.toFixed(3)),
        fetch: candidate.fetch,
      };
      if (used + cost > itemBudget) {
        overflow.push(reference);
        continue;
      }
      used += cost;
      selected.push({
        ...reference,
        ...(candidate.owner ? { owner: candidate.owner } : {}),
        text,
        truncated: text !== candidate.text,
      });
    }

    const isShared = (item: any) => item.access_scope === "team_shared" || item.access_scope === "shared_engineering_agent";
    const shared = selected.filter(isShared);
    const privateContext = selected.filter((item) => !isShared(item));
    const contributing = [...new Set(selected.map((item) => item.source_type))];
    const failed = stats.filter((stat) => stat.error);

    const result: any = {
      project: { id: project.id, team_id: project.team_id, repository: project.repository },
      developer: { user_id: caller.user_id, username: caller.username, agent_id: agentId },
      ...(caller.user_id === userId ? {} : { configured_user_id: userId }),
      task_summary: request.task_description.slice(0, 300),
      search_terms: terms,
      shared_context: shared,
      private_context: privateContext,
      constraints: selected
        .filter((item) => item.source_type === "skill" || /standard|convention|specification|规范/i.test(item.title))
        .map((item) => ({ title: item.title, id: item.id, source_type: item.source_type })),
      related_files: relatedFiles(selected, request.file_paths),
      outstanding_decisions: outstanding(selected),
      references: overflow.slice(0, MAX_REFERENCES),
      warnings: [
        ...failed.map((stat) => `${stat.source} was not searched: ${this.client.redact(stat.error!)}`),
        ...(selected.length === 0
          ? ["No relevant context was found. Retry with specific module, table or feature names."]
          : []),
      ],
      statistics: {
        sources_queried: stats.length,
        sources: stats.map(({ error, ...stat }) => ({ ...stat, failed: !!error })),
        results_retrieved: retrieved.length,
        results_relevant: relevant.length,
        results_selected: selected.length,
        duplicates_removed: duplicates,
        contributing_sources: contributing,
        budget_tokens: budget,
        latency_ms: Date.now() - started,
        cache_hit: false,
        token_method: "estimate",
      },
    };
    result.statistics.context_tokens = estimateTokens(JSON.stringify(result));
    return result;
  }

  private async fetchTask(taskId: string, stats: SourceStat[]): Promise<any> {
    const begun = Date.now();
    const task = await this.client.panel("/meta/task/get", { task_id: taskId });
    stats.push({ source: "task", results: 1, latency_ms: Date.now() - begun });
    return task;
  }

  private async wiki(project: Project, query: string, terms: string[], referencesOnly?: boolean): Promise<Candidate[]> {
    if (!query) return [];
    const assets = (await this.client.panel("/knowledge/wiki/team-assets", { team_id: project.team_id })).items ?? [];
    const wikis = assets.filter(
      (wiki: any) => wiki.status === "ready" && (!project.wiki_ids || project.wiki_ids.includes(wiki.knowledge_id))
    );
    const perWiki = await Promise.all(
      wikis.map(async (wiki: any) => {
        const data = await this.client.panel("/knowledge/wiki/search", {
          wiki_id: wiki.knowledge_id,
          query,
          limit: MAX_WIKI_PAGES,
        });
        return (data.results ?? []).map((hit: any) => ({ wiki, hit }));
      })
    );
    const hitText = ({ hit }: any) => `${hit.title ?? ""} ${hit.snippet ?? ""}`;
    const hits = perWiki
      .flat()
      .map(({ wiki, hit }: any) => ({ wiki, hit: { ...hit, ref: hit.ref ?? hit.path } }))
      .sort((a: any, b: any) => coverage(terms, hitText(b)) - coverage(terms, hitText(a)));

    const reads = referencesOnly ? [] : hits.slice(0, MAX_WIKI_PAGES);
    const bodies = new Map<string, string>();
    await Promise.all(
      reads.map(async ({ wiki, hit }: any) => {
        const data = await this.client.panel("/knowledge/wiki/page/read", { wiki_id: wiki.knowledge_id, refs: [hit.ref] });
        const page = (data.items ?? data.pages ?? [])[0];
        if (page?.content) bodies.set(`${wiki.knowledge_id}:${hit.ref}`, stripFrontMatter(page.content));
      })
    );

    return hits.map(({ wiki, hit }: any) => {
      const body = bodies.get(`${wiki.knowledge_id}:${hit.ref}`);
      return {
        source_type: "wiki",
        access_scope: "team_shared",
        id: `${wiki.knowledge_id}:${hit.ref}`,
        title: `${wiki.name}: ${hit.title ?? hit.ref}`,
        match_title: hit.title ?? hit.ref,
        text: body ?? hit.snippet ?? hit.title ?? "",
        // A hit whose body wasn't read can't be judged here, so trust the server's match.
        // Wiki BM25 scores are near zero on this deployment, so they aren't used for ranking.
        server_score: body ? undefined : 0.5,
        fetch: { tool: "get_wiki_document", args: { wiki_id: wiki.knowledge_id, refs: [hit.ref] } },
      };
    });
  }

  private async teamMemory(project: Project, query: string): Promise<Candidate[]> {
    if (!query) return [];
    const { agentId } = this.client.config;
    const blocks = (await teamBlocks(this.client, project.team_id)).filter((block) => block.agent_id !== agentId);
    const perBlock = await Promise.all(
      blocks.map(async (block) => {
        const access_scope: AccessScope =
          block.agent_id === project.shared_agent_id ? "shared_engineering_agent" : "team_shared";
        const label = (item: Candidate): Candidate => ({
          ...item,
          source_type: "team_memory",
          access_scope,
          owner: block.uploaded_by_user_id,
          title: `${block.title ?? block.id}: ${item.title}`,
          match_title: item.title,
        });
        const [atoms, durable] = await Promise.all([
          this.client.panel("/chat-memory/search", { block_id: block.id, layer: "L1", query, limit: 5 }),
          this.durableMemory(block.id, "team", query),
        ]);
        const atomItems = (atoms.items ?? []).map(
          (item: any): Candidate =>
            label({
              source_type: "team_memory",
              access_scope,
              id: item.id,
              title: item.title ?? "memory",
              text: item.body ?? "",
              server_score: item.score,
              fetch: { tool: "search_memories", args: { query, scope: "team", block_id: block.id } },
            })
        );
        return [...atomItems, ...durable.map(label)];
      })
    );
    return perBlock.flat();
  }

  /**
   * L2 scenario files and L3 core memory. These are the distilled layers, and they
   * have no search API, so the files are read here and ranked with everything else.
   */
  private async durableMemory(blockId: string, scope: string, query: string): Promise<Candidate[]> {
    const base = { source_type: "own_memory" as SourceType, access_scope: "agent_private" as AccessScope };
    const [listing, core] = await Promise.all([
      this.client.panel("/chat-memory/layer", { block_id: blockId, layer: "L2", limit: 200 }),
      this.client.panel("/chat-memory/layer", { block_id: blockId, layer: "L3" }),
    ]);
    const paths: string[] = (listing.items ?? []).map((item: any) => item.title).slice(0, MAX_SCENARIO_FILES);
    const scenarios = await Promise.all(
      paths.map(async (path): Promise<Candidate> => {
        const file = await this.client.panel("/chat-memory/layer", { block_id: blockId, layer: "L2", path });
        return {
          ...base,
          id: `${blockId}:${path}`,
          title: path,
          text: file.items?.[0]?.body ?? "",
          fetch: { tool: "search_scenario_memories", args: { query, scope, ...(scope === "team" ? { block_id: blockId } : {}) } },
        };
      })
    );
    const cores = (core.items ?? [])
      .filter((item: any) => item.body)
      .map(
        (item: any): Candidate => ({
          ...base,
          id: `${blockId}:core`,
          title: "core memory",
          text: item.body,
          fetch: { tool: "search_core_memories", args: { scope, ...(scope === "team" ? { block_id: blockId } : {}) } },
        })
      );
    return [...scenarios, ...cores];
  }

  private async ownMemory(project: Project, query: string): Promise<Candidate[]> {
    if (!query) return [];
    const { agentId } = this.client.config;
    const blockId = ownBlockId(project.team_id, agentId);
    const visibility = await ownBlockVisibility(this.client, project.team_id, agentId);
    const access_scope: AccessScope = visibility === "team" ? "agent_own_team_visible" : "agent_private";
    const search = (layer: string) => this.client.panel("/chat-memory/search", { block_id: blockId, layer, query, limit: 5 });
    if (visibility === undefined) return [];
    const [atoms, messages, durable] = await Promise.all([
      search("L1"),
      search("L0"),
      this.durableMemory(blockId, "agent", query),
    ]);
    const items = (data: any, source_type: SourceType, tool: string): Candidate[] =>
      (data.items ?? []).map((item: any) => ({
        source_type,
        access_scope,
        id: item.id,
        title: item.title ?? source_type,
        text: item.body ?? "",
        server_score: item.score,
        fetch: { tool, args: { query } },
      }));
    return [
      ...items(atoms, "own_memory", "search_memories"),
      ...items(messages, "own_conversation", "search_conversations"),
      ...durable.map((item) => ({ ...item, access_scope })),
    ];
  }

  private async codeGraph(project: Project, terms: string[]): Promise<Candidate[]> {
    const graphs = (await accessibleCodeGraphs(this.client, project.team_id)).filter(
      (graph) => !project.code_graph_ids || project.code_graph_ids.includes(graph.knowledge_id)
    );
    const searches = graphs.flatMap((graph) => terms.slice(0, 3).map((term) => ({ graph, term })));
    const results = await Promise.all(
      searches.map(async ({ graph, term }): Promise<Candidate | undefined> => {
        const data = await this.client.panel("/knowledge/code-graph/search", {
          code_graph_id: graph.knowledge_id,
          query: term,
          limit: 5,
        });
        if (!data.text) return undefined;
        return {
          source_type: "code_graph",
          access_scope: "team_shared",
          id: `${graph.knowledge_id}:${term}`,
          title: `${graph.name ?? graph.knowledge_id}: ${term}`,
          text: data.text,
          server_score: 0.5,
          fetch: { tool: "search_code_graph", args: { query: term, code_graph_id: graph.knowledge_id } },
        };
      })
    );
    return results.filter((item): item is Candidate => !!item);
  }

  private async skills(project: Project, query: string): Promise<Candidate[]> {
    if (!query) return [];
    const { agentId, userId } = this.client.config;
    const data = await this.client.panel("/skill/search", {
      team_id: project.team_id,
      agent_id: agentId,
      user_id: userId,
      query,
      top_k: 5,
      scope: "team",
    });
    return (data.items ?? []).map(
      (skill: any): Candidate => ({
        source_type: "skill",
        access_scope: "team_shared",
        id: skill.skill_id,
        title: skill.name,
        text: skill.snippet ?? skill.description ?? "",
        server_score: skill.score,
        fetch: { tool: "get_skill", args: { skill_id: skill.skill_id } },
      })
    );
  }

  private async myTasks(project: Project, terms: string[]): Promise<Candidate[]> {
    const { agentId } = this.client.config;
    return (await allTeamTasks(this.client, project.team_id))
      .filter((task: any) => (task.agents ?? []).some((agent: any) => agent.agent_id === agentId))
      .filter((task: any) => coverage(terms, `${task.title} ${task.description ?? ""}`) > 0)
      .map(
        (task: any): Candidate => ({
          source_type: "task",
          access_scope: "team_shared",
          id: task.task_id,
          title: task.title,
          text: `${task.title}\n${task.description ?? ""}\nStatus: ${task.status}`,
          fetch: { tool: "get_task", args: { task_id: task.task_id } },
        })
      );
  }
}

const FILE_PATTERN = /[\w@.-]+(?:[\\/][\w@.-]+)+\.[A-Za-z0-9]{1,6}\b/g;

function relatedFiles(selected: any[], requested: string[] = []): string[] {
  const found = selected
    .filter((item) => item.source_type === "code_graph")
    .flatMap((item) => item.text.match(FILE_PATTERN) ?? []);
  return [...new Set([...requested, ...found])].slice(0, 30);
}

function outstanding(selected: any[]): { text: string; source_id: string }[] {
  return selected.flatMap((item) =>
    [...item.text.matchAll(/^Outstanding:\s*(.+)$/gim)].map((match) => ({ text: match[1].trim(), source_id: item.id }))
  );
}
