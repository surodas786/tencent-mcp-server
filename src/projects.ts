// TencentDB has no native project entity, so a project is an adapter-side profile
// mapping a name to a team and the assets that belong to it. Profiles only narrow
// what is searched; the Panel still decides what this developer may read.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./client.js";

const profileSchema = z.object({
  team_id: z.string().min(1).optional(),
  repository: z.string().min(1).optional(),
  wiki_ids: z.array(z.string().min(1)).optional(),
  code_graph_ids: z.array(z.string().min(1)).optional(),
  decisions_wiki_id: z.string().min(1).optional(),
  shared_agent_id: z.string().min(1).optional(),
  max_context_tokens: z.number().int().min(500).max(100000).optional(),
});

const fileSchema = z.object({
  default_project: z.string().min(1).optional(),
  projects: z.record(profileSchema),
});

export type Project = z.infer<typeof profileSchema> & { id: string; team_id: string };

export const DEFAULT_CONTEXT_TOKENS = 8000;

export class Projects {
  constructor(
    private readonly profiles: Map<string, Project>,
    readonly defaultId: string
  ) {}

  get(id?: string): Project {
    const project = this.profiles.get(id ?? this.defaultId);
    if (!project) {
      throw new Error(`Unknown project '${id}'. Configured projects: ${[...this.profiles.keys()].join(", ")}.`);
    }
    return project;
  }
}

export function loadProjects(env: NodeJS.ProcessEnv, config: Config): Projects {
  const envDefaults = {
    team_id: config.teamId,
    decisions_wiki_id: env.TENCENTDB_DECISIONS_WIKI_ID || undefined,
    shared_agent_id: env.TENCENTDB_SHARED_AGENT_ID || undefined,
    max_context_tokens: env.TENCENTDB_MAX_CONTEXT_TOKENS ? Number(env.TENCENTDB_MAX_CONTEXT_TOKENS) : undefined,
  };
  const activeId = env.TENCENTDB_PROJECT_ID || undefined;
  const profiles = new Map<string, Project>();

  if (env.TENCENTDB_PROJECTS_FILE) {
    const parsed = fileSchema.parse(JSON.parse(readFileSync(env.TENCENTDB_PROJECTS_FILE, "utf8")));
    for (const [id, profile] of Object.entries(parsed.projects)) {
      profiles.set(id, { ...envDefaults, ...profile, id });
    }
    const defaultId = activeId ?? parsed.default_project ?? [...profiles.keys()][0];
    if (!defaultId) throw new Error("TENCENTDB_PROJECTS_FILE defines no projects.");
    return new Projects(profiles, defaultId);
  }

  const id = activeId ?? "default";
  profiles.set(id, { ...envDefaults, id });
  return new Projects(profiles, id);
}
