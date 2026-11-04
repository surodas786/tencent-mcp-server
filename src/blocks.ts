// Chat memory blocks. Visibility is per block, and an agent has exactly one block,
// so an agent's whole memory is either team-visible or private.

import type { Client } from "./client.js";

const TASK_PAGE = 100;

export type Block = { id: string; title?: string; uploaded_by_user_id?: string; agent_id?: string };

export const ownBlockId = (teamId: string, agentId: string) => `chat_memory-${teamId}-${agentId}`;

export function blockAgent(teamId: string, blockId: string): string | undefined {
  const prefix = `chat_memory-${teamId}-`;
  return blockId.startsWith(prefix) ? blockId.slice(prefix.length) : undefined;
}

/** Blocks shared with the team, as reported by the Panel for this caller. */
export async function teamBlocks(client: Client, teamId: string): Promise<Block[]> {
  const data = await client.panel("/chat-memory/team-assets", { team_id: teamId });
  return (data.items ?? []).map((block: Block) => ({
    ...block,
    agent_id: block.agent_id ?? blockAgent(teamId, block.id),
  }));
}

/** 'team', 'private', or undefined when the agent has no block yet (created private on first write). */
export async function ownBlockVisibility(client: Client, teamId: string, agentId: string): Promise<string | undefined> {
  const data = await client.panel("/chat-memory/my-agents", { team_id: teamId });
  return (data.items ?? []).find((item: any) => item.agent_id === agentId)?.scope;
}

/** Every task in the team. The kernel caps a page at 100, whatever the Panel doc says. */
export async function allTeamTasks(client: Client, teamId: string, status?: string): Promise<any[]> {
  const tasks: any[] = [];
  for (let offset = 0; ; offset += TASK_PAGE) {
    const data = await client.panel("/task/list-with-agents", {
      team_id: teamId,
      limit: TASK_PAGE,
      offset,
      ...(status ? { status } : {}),
    });
    const page = data.items ?? [];
    tasks.push(...page);
    if (page.length < TASK_PAGE) return tasks;
  }
}

/** Code graphs this developer may read. The Panel's answer is the access decision. */
export async function accessibleCodeGraphs(client: Client, teamId: string): Promise<any[]> {
  return (await client.panel("/knowledge/code-graph/team-assets", { team_id: teamId })).items ?? [];
}
