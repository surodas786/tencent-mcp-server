// Chat memory blocks. Visibility is per block, and an agent has exactly one block,
// so an agent's whole memory is either team-visible or private.
const TASK_PAGE = 100;
export const ownBlockId = (teamId, agentId) => `chat_memory-${teamId}-${agentId}`;
export function blockAgent(teamId, blockId) {
    const prefix = `chat_memory-${teamId}-`;
    return blockId.startsWith(prefix) ? blockId.slice(prefix.length) : undefined;
}
/** Blocks shared with the team, as reported by the Panel for this caller. */
export async function teamBlocks(client, teamId) {
    const data = await client.panel("/chat-memory/team-assets", { team_id: teamId });
    return (data.items ?? []).map((block) => ({
        ...block,
        agent_id: block.agent_id ?? blockAgent(teamId, block.id),
    }));
}
/** 'team', 'private', or undefined when the agent has no block yet (created private on first write). */
export async function ownBlockVisibility(client, teamId, agentId) {
    const data = await client.panel("/chat-memory/my-agents", { team_id: teamId });
    return (data.items ?? []).find((item) => item.agent_id === agentId)?.scope;
}
/** Every task in the team. The kernel caps a page at 100, whatever the Panel doc says. */
export async function allTeamTasks(client, teamId, status) {
    const tasks = [];
    for (let offset = 0;; offset += TASK_PAGE) {
        const data = await client.panel("/task/list-with-agents", {
            team_id: teamId,
            limit: TASK_PAGE,
            offset,
            ...(status ? { status } : {}),
        });
        const page = data.items ?? [];
        tasks.push(...page);
        if (page.length < TASK_PAGE)
            return tasks;
    }
}
/** Code graphs this developer may read. The Panel's answer is the access decision. */
export async function accessibleCodeGraphs(client, teamId) {
    return (await client.panel("/knowledge/code-graph/team-assets", { team_id: teamId })).items ?? [];
}
