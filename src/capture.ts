// Durable capture of development decisions, with an explicit scope on every save.

import { createHash } from "node:crypto";
import type { Client } from "./client.js";
import { ownBlockVisibility } from "./blocks.js";
import type { Project } from "./projects.js";

export type CaptureScope =
  | "developer_private"
  | "team_shared"
  | "shared_engineering_agent"
  | "documentation_candidate";

export interface Decision {
  title: string;
  decision: string;
  rationale?: string;
  files?: string[];
  tests?: string;
  outstanding?: string[];
  scope: CaptureScope;
  session_id?: string;
}

const MAX_MESSAGE_CHARS = 8192;

const SECRET_PATTERNS: [string, RegExp][] = [
  ["API key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["credential assignment", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*['"]?[^\s'"]{6,}/i],
];

/** Names what was found, never the value, so the refusal itself cannot leak it. */
export function findSecret(text: string): string | undefined {
  return SECRET_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}

export function renderDecision(project: Project, developer: string, agentId: string, input: Decision): string {
  const lines = [
    `# ${input.title}`,
    "",
    `Project: ${project.id}`,
    `Recorded by: ${developer} (agent ${agentId})`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Decision: ${input.decision}`,
  ];
  if (input.rationale) lines.push("", `Rationale: ${input.rationale}`);
  if (input.files?.length) lines.push("", `Files: ${input.files.join(", ")}`);
  if (input.tests) lines.push("", `Tests: ${input.tests}`);
  for (const item of input.outstanding ?? []) lines.push(`Outstanding: ${item}`);
  return lines.join("\n");
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";

export class KnowledgeCapture {
  private saved = new Set<string>();

  constructor(private readonly client: Client) {}

  async save(project: Project, input: Decision): Promise<any> {
    const { agentId } = this.client.config;
    const caller = await this.client.caller();
    const body = renderDecision(project, caller.username ?? caller.user_id, agentId, input);

    const secret = this.client.containsConfiguredSecret(body) ? "configured credential" : findSecret(body);
    if (secret) {
      throw new Error(`Not saved: the content appears to contain a ${secret}. Remove it and retry.`);
    }
    if (body.length > MAX_MESSAGE_CHARS) {
      throw new Error(`Not saved: the content is ${body.length} characters; the limit is ${MAX_MESSAGE_CHARS}.`);
    }

    const fingerprint = createHash("sha256").update(`${project.id}|${input.scope}|${input.title}|${input.decision}`).digest("hex");
    if (this.saved.has(fingerprint)) {
      return { saved: false, reason: "duplicate of a decision already saved in this session", scope: input.scope };
    }

    const result = await this.store(project, input, body);
    this.saved.add(fingerprint);
    return { saved: true, scope: input.scope, ...result };
  }

  private store(project: Project, input: Decision, body: string): Promise<any> {
    switch (input.scope) {
      case "developer_private":
        return this.savePrivate(project, input, body);
      case "shared_engineering_agent":
        return this.saveAsSharedAgent(project, input, body);
      case "team_shared":
        return this.publish(project, input, body, "decision", true);
      case "documentation_candidate":
        return this.publish(project, input, body, "candidate", false);
    }
  }

  private async savePrivate(project: Project, input: Decision, body: string): Promise<any> {
    const { agentId } = this.client.config;
    const visibility = await ownBlockVisibility(this.client, project.team_id, agentId);
    if (visibility === "team") {
      throw new Error(
        "Not saved: this agent's memory block is team-visible, so a 'developer_private' save would be readable by the team. Set the block to private in Memory Hub, or save with scope 'team_shared'."
      );
    }
    return this.importToAgent(project, input, body);
  }

  private async saveAsSharedAgent(project: Project, input: Decision, body: string): Promise<any> {
    const { agentId } = this.client.config;
    if (!project.shared_agent_id) {
      throw new Error("Not saved: this project has no shared engineering agent configured.");
    }
    if (agentId !== project.shared_agent_id) {
      throw new Error(
        "Not saved: only a session running as the shared engineering agent can write its memory. To share this with the team, use scope 'team_shared'."
      );
    }
    return this.importToAgent(project, input, body);
  }

  private async importToAgent(project: Project, input: Decision, body: string): Promise<any> {
    const { agentId } = this.client.config;
    const data = await this.client.panel("/chat-memory/import", {
      team_id: project.team_id,
      agent_id: agentId,
      session_id: input.session_id ?? `decisions-${project.id}`,
      messages: [{ role: "assistant", content: body }],
    });
    return { stored_in: "agent_memory", block_id: data.block_id, session_id: data.session_id, accepted_count: data.accepted_count };
  }

  /** The team pool is a wiki: any member may contribute, and all members may read it. */
  private async publish(project: Project, input: Decision, body: string, prefix: string, ingest: boolean): Promise<any> {
    const wikiId = project.decisions_wiki_id;
    if (!wikiId) {
      throw new Error(
        "Not saved: set X-TencentDB-Decisions-Wiki-Id in mcp.json (TENCENTDB_DECISIONS_WIKI_ID over stdio) or the project's decisions_wiki_id to publish to the team."
      );
    }
    const filename = `${prefix}-${new Date().toISOString().slice(0, 10)}-${slug(input.title)}.md`;
    await this.client.panel("/knowledge/wiki/raw/write", {
      team_id: project.team_id,
      wiki_id: wikiId,
      // The service reads content as base64 unless told otherwise.
      files: [{ filename, content: body, encoding: "utf8" }],
    });
    if (!ingest) {
      return { stored_in: "wiki_raw", wiki_id: wikiId, filename, searchable: false };
    }
    try {
      await this.client.panel("/knowledge/wiki/ingest", { wiki_id: wikiId });
      return { stored_in: "wiki", wiki_id: wikiId, filename, ingest: "started" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stored_in: "wiki_raw", wiki_id: wikiId, filename, ingest: "failed", ingest_error: message, searchable: false };
    }
  }
}
