# TencentDB MCP Adapter

An MCP server that connects Claude Code on each developer's workstation to a shared TencentDB Memory Hub. It retrieves project context, and saves decisions back with an explicit scope. It doesn't perform model inference and doesn't use the TencentDB Proxy.

> **Status:** reads and writes are live-tested as DEV1 and DEV3. Code graph tools, tasks, DEV2, the shared agent and private isolation are not yet tested. See [Live test status](#live-test-status) and [Security status](#security-status).

## Install

```powershell
npm install
copy .env.example .env     # then fill it in
npm run whoami             # confirms the key is yours, and shows your real user ID
npm test                   # build and mock tests; never contacts the live server
npm run live-check         # read-only live check
```

Claude Code configuration:

```json
{
  "mcpServers": {
    "tencentdb-memory": {
      "command": "node",
      "args": ["E:\\tencentdb-mcp-adapter\\dist\\index.js"]
    }
  }
}
```

After a rebuild, restart Claude Code or reconnect with `/mcp`. Add `docs/CLAUDE.snippet.md` to each project's `CLAUDE.md`.

## Remote adapter over HTTP

The adapter can run on one remote host and serve every developer over HTTP. Developers then need only an MCP configuration, not a copy of the adapter.

**On the adapter host:**

1. Run `npm install` and `npm run build`.
2. Fill in `.env` from `.env.example` with the shared settings, and set `TENCENTDB_MCP_TRANSPORT=http`. Leave out the three per-developer values. If they are present, HTTP mode ignores them.
3. Run `npm start`. The adapter listens on `http://<host>:8787/mcp`.

**On each developer's workstation:**

1. Copy `mcp-client/mcp.json` to where the MCP client reads it. For Claude Code, that is `.mcp.json` in the project root.
2. Replace `<adapter-host>` and the three identity values.
3. Don't commit the filled-in file, because it holds the developer's key.

**To change the TencentDB user,** edit the three headers and reconnect with `/mcp`. Nothing changes on the adapter host, and it doesn't need a restart.

| Header | Replaces |
|---|---|
| `X-TencentDB-User-Key` | `TENCENTDB_USER_KEY` |
| `X-TencentDB-User-Id` | `TENCENTDB_USER_ID` |
| `X-TencentDB-Agent-Id` | `TENCENTDB_AGENT_ID` |

How it behaves:

- **All three headers are required on every request.** There is no fallback to values in the server's `.env`.
- **Each session is isolated,** with its own client, identity and context cache. A session can't be used with different identity headers.
- **The usual checks still apply.** The Panel verifies the key on first use, and admin keys and mismatched user IDs are refused.
- **HTTP mode needs `panel` access.** The adapter won't start with `TENCENTDB_MEMORY_ACCESS=core`, because Core trusts the user ID it is given.
- **Team and project settings are shared.** They come from the server's `.env`, so developers in another team need `TENCENTDB_PROJECTS_FILE` or a separate adapter.
- **Sessions are held in memory.** They end after 12 idle hours or when the adapter restarts, and the client must then reconnect.

## Services and authentication

| Service | URL | Credential | Who is checked |
|---|---|---|---|
| MemoryPanel | `:8125/api/v1` | `x-tdai-user-key` + `x-tdai-service-id` | The real user, by the server |
| MemoryKnowledge | `:8424/v3` | `x-tdai-service-id`; service key for non-allowlisted routes | Nobody. The service has no user identity |
| MemoryCore | `:8420/v3` | One shared Bearer token + `x-tdai-*` headers | Nobody. Headers are trusted |

Consequences for the design:

- **Memory goes through the Panel by default.** The Panel checks ownership and team membership, reads under the owner's real ID, and needs only the developer's own key. Developers don't need the shared MemoryCore token.
- **Knowledge calls are gated first.** Before calling MemoryKnowledge, the adapter confirms the graph is in the Panel's list for this developer. That check runs in the adapter, so it is not server enforcement.
- **Identity comes from configuration.** No tool accepts a different user or team identity.
- **Admin keys are refused.** Before the first call to the Panel or MemoryCore, the adapter resolves the key's owner and refuses `system_admin` keys and keys that don't match `TENCENTDB_USER_ID`.
- **Failures stay visible.** A failed team search is an error and never falls back to agent scope.
- **Keys are redacted** from all tool output. The adapter writes no logs, apart from one startup line in HTTP mode.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `TENCENTDB_PANEL_URL` | Yes | MemoryPanel |
| `TENCENTDB_USER_KEY` | stdio only | This developer's key |
| `TENCENTDB_AGENT_ID` | stdio only | This developer's agent |
| `TENCENTDB_USER_ID` | stdio only | Real user ID (`usr-...`), from `npm run whoami` |
| `TENCENTDB_TEAM_ID` | Yes | Default team |
| `TENCENTDB_SERVICE_ID` | No | Instance, default `default` |
| `TENCENTDB_KNOWLEDGE_URL` | For code entity tools | MemoryKnowledge |
| `TENCENTDB_PROJECT_ID` | No | Active project name |
| `TENCENTDB_PROJECTS_FILE` | No | Project profiles, see below |
| `TENCENTDB_DECISIONS_WIKI_ID` | For `team_shared` saves | Team decisions wiki |
| `TENCENTDB_SHARED_AGENT_ID` | No | Labels the shared engineering agent's knowledge |
| `TENCENTDB_MAX_CONTEXT_TOKENS` | No | Default budget, 8000 |
| `TENCENTDB_CONTEXT_CACHE_SECONDS` | No | Default 300, 0 disables |
| `TENCENTDB_MEMORY_ACCESS` | No | `panel` when a Panel URL is set, otherwise `core` |
| `TENCENTDB_MEMORY_URL`, `TENCENTDB_API_KEY` | For `core` access only | MemoryCore and its shared token. `TENCENTDB_URL` is still accepted |
| `TENCENTDB_MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `TENCENTDB_MCP_HOST` | No | HTTP listen address, default `0.0.0.0` |
| `TENCENTDB_MCP_PORT` | No | HTTP listen port, default `8787` |

## Projects

TencentDB has no project entity, so a project is an adapter-side profile mapping a name to a team and its assets. Profiles narrow what is searched; they grant nothing. For several projects, set `TENCENTDB_PROJECTS_FILE` to a file like `docs/PROJECTS.example.json`. Otherwise one profile is built from the environment.

## Tools

Panel paths are relative to `/api/v1`. Each tool's description documents its output.

| Tool | Scope | API |
|---|---|---|
| `get_development_context` | Both, separated | All sources below |
| `get_task_context` | Both, separated | `/meta/task/get`, then as above |
| `search_project_knowledge` | Both, separated | As above, without reading page bodies |
| `get_project_context` | Team | `/meta/team/get`, `/meta/agent/list`, `/knowledge/wiki/team-assets`, `/knowledge/code-graph/team-assets` |
| `search_memories` | `agent` (default), `team` | `/chat-memory/search` L1 (`core` access: Core `/v3/atomic/search`) |
| `search_conversations` | `agent` (default), `team` | `/chat-memory/search` L0 (`core` access: Core `/v3/conversation/search`) |
| `search_scenario_memories` | `agent` (default), `team` | `/chat-memory/layer` L2 (`core` access: Core `/v3/scenario/ls`, `/read`). **Adapter-side filtering** |
| `search_core_memories` | `agent` (default), `team` | `/chat-memory/layer` L3 (`core` access: Core `/v3/core/read`). **Adapter-side filtering** |
| `save_conversation` | Agent | `/chat-memory/import` (`core` access: Core `/v3/conversation/add`) |
| `save_development_decision` | Explicit | `/chat-memory/import`, `/chat-memory/my-agents`, `/knowledge/wiki/raw/write`, `/knowledge/wiki/ingest` |
| `list_wiki_documents` | Team | `/knowledge/wiki/team-assets`, `/page/ls`, `/raw/ls` |
| `search_wiki` | Team | `/knowledge/wiki/search` |
| `get_wiki_document` | Team | `/knowledge/wiki/page/read`, `/raw/read` |
| `search_code_graph` | Team | `/knowledge/code-graph/team-assets`, `/search` |
| `get_code_entity` | Team | Knowledge `/v3/tools/call` `node` |
| `get_code_relationships` | Team | Knowledge `/v3/tools/call` `callers`, `callees`, `impact` |
| `find_related_files` | Team | Knowledge `/v3/tools/call` `explore`, `files` |
| `list_skills`, `search_skills`, `get_skill` | `team` (default), `agent` | `/skill/list`, `/skill/search`, `/skill/get` |
| `search_tasks`, `get_task` | Team | `/task/list-with-agents`, `/meta/task/get` |
| `get_my_tasks` | Agent view | `/task/list-with-agents`, filtered to this agent |
| `update_task_status` | Team | `/meta/task/update`. Server allows only the task's creator |
| `get_team`, `list_team_agents`, `get_agent` | Team | `/meta/team/get`, `/meta/agent/list`, `/meta/agent/get` |

## Context orchestration

`get_development_context` extracts search terms and queries every source in parallel. It scores results by term coverage, server score and source authority, removes near-duplicates, and fits what remains to the budget. Shared and private results stay in separate lists, and each item carries `source_type`, `access_scope`, `id` and a `fetch` call for reading more. Results that don't fit become `references`.

`statistics` reports sources queried, results retrieved and selected, duplicates removed, per-source latency, and package size. Token counts are estimates, about 4 characters per token. A source that fails appears in `warnings`.

## Knowledge capture

| Scope | Stored in | Visible to |
|---|---|---|
| `developer_private` | This agent's memory. Refused if the block is team-visible | This developer |
| `team_shared` | Decisions wiki, then ingested | Team members |
| `documentation_candidate` | Decisions wiki, not ingested | Team members, not searchable |
| `shared_engineering_agent` | That agent's memory, only from a session running as it | Depends on its block |

Team sharing uses a wiki for two reasons: visibility is per block, so an agent's memory can't be partly shared, and `mem-xxx` blocks have no data behind them. Saves containing anything that looks like a credential are refused.

Ingest runs on the server and uses its configured model. It rewrites each source into linked pages: one short decision produced 11 pages in testing. Publish deliberately, because the pages rank alongside your specifications.

## Onboarding a developer

No source changes are needed.

1. An administrator creates the user, adds them to the team, creates their agent, and issues a user key.
2. The developer clones the adapter and runs `npm install`.
3. They fill in `.env` from `.env.example`, using their own key and agent.
4. `npm run whoami` shows their real user ID. Set `TENCENTDB_USER_ID` to it.
5. They add the MCP configuration and restart Claude Code.
6. `npm run live-check` verifies access to shared knowledge.
7. `npm run live-check -- --private-block <id>` verifies another developer's private block is denied.

## Shared engineering agent

Its owner is `admin`, and the adapter refuses admin keys, so it can't run as this agent today. Agent ownership can't be changed. To give it a live identity, create a non-admin service user and a new agent owned by that user, then run the adapter with that user's key on a controlled machine.

Developers don't need that identity to use shared knowledge: reading `team_shared` content works directly.

## Live test status

Tested on 2026-11-04 as DEV1 and DEV3 with normal developer keys.

| Area | Result |
|---|---|
| Identity check, team, agents | Pass |
| Wiki list, search, read | Pass, with real content from 5 wikis |
| Skills list, search, get | Pass |
| L2 and L3 memory, agent and team scope | Pass, returning DEV1's pilot stack and Team Operating Doctrine |
| L0 and L1 search | Works, but empty: DEV1's data is stored under `dev1` |
| `get_development_context` | Pass: about 4,650 to 5,650 tokens against about 51,670 for all wiki pages (estimates, four tasks) |
| Code graph, tasks | Calls succeed, but no data exists, so results are unproven |
| `get_code_entity`, `get_code_relationships`, `find_related_files` | Not tested: no code graph exists |
| `save_conversation` | Pass as DEV3, retrieved from a later session |
| `save_development_decision` | Pass as DEV3 for `developer_private`, `team_shared` (ingested and searchable) and `documentation_candidate` |
| Capture refusals | Pass: credential-like content and writing as the shared agent were refused |
| Cross-developer read | Pass: DEV3 read DEV1's shared L2 and L3 memory, with its true source |
| Team scope excludes private memory | Pass as DEV3: its private record did not appear through team scope |
| `update_task_status` | Not tested: no tasks exist |
| DEV2, shared agent | Not tested: no keys |
| Private isolation | Not tested: needs another developer's key against DEV3's private block |

### Existing memory under `dev1`

Memory Core holds 8 L1 records and 20 L0 messages for DEV1 under the literal user ID `dev1`, and none under `usr-3qta2md4vz`. The Panel reads the real ID, so these aren't visible through it. L2 and L3 aren't keyed by user, so they are visible. Moving them needs an approved migration: read each record under `dev1`, write it under the real ID, verify counts, and only then consider removing the originals.

## Security status

| Issue | Status |
|---|---|
| Admin key published in public Git history (`a334aca`) | **Open.** Must be rotated. History rewrite awaits approval |
| MemoryCore trusts identity headers | **Open, server-side.** A developer key was accepted as its Bearer token, so it isn't limited to a shared secret, and identity headers aren't checked. Restrict port 8420, and configure the gateway's API key |
| MemoryKnowledge read routes need no credential | **Open, server-side.** Anyone on the network can read wikis and call code tools. Restrict port 8424 to the Panel and approved hosts, or add per-user auth |
| Agent memory visibility is per block | **By design.** Team-visible blocks expose all of that agent's memory |
| Traffic is plain HTTP | **Open.** Keys cross the network unencrypted, including on every request from an MCP client to a remote adapter. Use TLS or a VPN |

## Limitations

- L2 and L3 have no search API. Those tools read files and filter in the adapter, and report coverage.
- Through the Panel, memory search has no session or time filter. These are rejected with an error, not ignored.
- Server search is keyword-based on this deployment (`embeddingService: false`), so related wording may not match.
- `update_task_status` works only for the task's creator.
- `limit` above 100 is rejected for tasks, although the Panel doc says 200. The adapter pages through results instead.
- Vague prompts find little. "Refactor an existing module" has one useful search term and returned no context, which is reported in `warnings`.
- `/v3/tools/call` isn't in the deployed OpenAPI spec. Its contract comes from upstream source and needs a live test with a real code graph.
- Memory saved earlier under `dev1`-style IDs through MemoryCore isn't visible through the Panel.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `belongs to a system_admin` | Replace the key with this developer's own |
| `not TENCENTDB_USER_ID` | The key and user ID are for different people. Run `npm run whoami` |
| `identity_warning` | Set `TENCENTDB_USER_ID` to the real `usr-...` ID |
| `ASSET_NOT_ACCESSIBLE` | The block is private. This is expected |
| `NOT_YOUR_AGENT` | `TENCENTDB_AGENT_ID` isn't owned by this user |
| `this agent's memory block is team-visible` | Set the block private in Memory Hub, or save as `team_shared` |
| `is not accessible to this developer` | The Panel doesn't list that code graph for this user |
| Empty code results | No match, or the graph isn't `ready`. Try `get_project_context` |
| `warnings` in context | The named source wasn't searched; the context is incomplete |
