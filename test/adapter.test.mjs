// End-to-end over real MCP stdio against a local mock of the documented contracts.
// This proves adapter behavior only. It says nothing about the live deployment.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TEAM = "team-test";
const DEV1_BLOCK = `chat_memory-${TEAM}-agt-dev1`;
const API_KEY = "sk-test-api-key-value";
const DEV_KEY = "sk-test-dev-user-key";
const ADMIN_KEY = "sk-test-admin-key";
const calls = [];
let failBlockSearch = false;
let brokenCodeGraph = false;
let ownVisibility = "private";
const LONG_PAGE = "Employee registration endpoint. ".repeat(600);

const ok = (data) => ({ status: 200, body: { code: 0, message: "ok", data } });
function route(path, body, headers) {
  if (path === "/api/v1/meta/auth/verify") {
    if (body.user_key === ADMIN_KEY) return ok({ valid: true, user: { user_id: "usr-admin", username: "admin", user_type: "system_admin" } });
    if (body.user_key === DEV_KEY) return ok({ valid: true, user: { user_id: "usr-dev2", username: "dev2", user_type: "normal" } });
    return ok({ valid: false });
  }
  if (path.startsWith("/api/v1/") && headers["x-tdai-user-key"] !== DEV_KEY) {
    return { status: 401, body: { code: 401, message: "INVALID_USER_KEY", data: null } };
  }
  if (String(body.query).includes("zzzzqqqq")) return ok({ items: [], results: [], text: "", isError: false });
  switch (path) {
    case "/v3/meta/auth/verify":
      return body.user_key === ADMIN_KEY
        ? ok({ valid: true, user: { user_id: "usr-admin", user_type: "system_admin" } })
        : ok({ valid: false });
    case "/v3/tools/call": return ok({ text: `${body.tool_name} of ${body.params.symbol ?? body.params.query ?? "files"} in src/user/register.ts`, isError: false });
    case "/api/v1/chat-memory/my-agents": return ok({ items: [{ agent_id: "agt-dev2", scope: ownVisibility }], total: 1 });
    case "/api/v1/chat-memory/import": return ok({ imported: true, block_id: `chat_memory-${TEAM}-agt-dev2`, session_id: body.session_id, accepted_count: body.messages.length });
    case "/api/v1/knowledge/wiki/raw/write":
      if (body.files[0].encoding !== "utf8") return { status: 400, body: { code: 400, message: "invalid base64 content", data: null } };
      return ok({ items: [{ filename: body.files[0].filename, status: "written" }] });
    case "/api/v1/knowledge/wiki/ingest": return ok({ status: "processing" });
    case "/api/v1/skill/search": return ok({ items: [{ skill_id: "skl-1", name: "api-docs", snippet: "employee api documentation", score: 0.4 }] });
    case "/api/v1/task/list-with-agents":
      if (body.limit > 100) return { status: 400, body: { code: 400, message: "limit: Too big: expected number to be <=100", data: null } };
      return ok({ items: [
      { task_id: "tsk-1", title: "Employee registration", status: "running", agents: [{ agent_id: "agt-dev2" }] },
      { task_id: "tsk-2", title: "Employee payroll", status: "running", agents: [{ agent_id: "agt-dev1" }] },
    ], total: 2 });
    case "/api/v1/meta/task/get": return ok({ task_id: body.task_id, title: "Employee registration", description: "Build it", status: "running" });
    case "/api/v1/meta/task/update": return { status: 403, body: { code: 403, message: "forbidden: not_task_creator", data: null } };
    case "/v3/atomic/search": return ok({ items: [{ id: "a1", type: "episodic", content: "own memory", agent_id: headers["x-tdai-agent-id"] }] });
    case "/v3/conversation/add": return ok({ accepted_ids: ["m1"], accepted_versions: ["v1"], total_count: 1 });
    case "/v3/conversation/search": return ok({ messages: [{ id: "m1", role: "user", content: "hi", session_id: "s1" }] });
    case "/v3/scenario/ls": return ok({ entries: [{ path: "dir/", version: 0 }, { path: "stack.md", summary: "tech", version: 1 }, { path: "other.md", version: 1 }], total: 3 });
    case "/v3/scenario/read": return ok({ path: body.path, content: body.path === "stack.md" ? "Uses Prisma ORM" : "unrelated" });
    case "/v3/core/read": return ok({ content: "persona text" });
    case "/api/v1/chat-memory/team-assets": return ok({ items: [{ id: DEV1_BLOCK, title: "Memory of dev1", uploaded_by_user_id: "usr-dev1" }, { id: `chat_memory-${TEAM}-agt-shared`, title: "Memory of shared", uploaded_by_user_id: "usr-admin" }], total: 2 });
    case "/api/v1/chat-memory/search":
      if (failBlockSearch) return { status: 403, body: { code: 403, message: "ASSET_NOT_ACCESSIBLE", data: null } };
      return ok({ items: [{ id: `${body.layer}-${body.block_id}`, title: "atomic", body: `employee registration note ${body.block_id.length % 2 ? "alpha beta gamma" : "delta epsilon"} ${body.block_id.replace(/\W/g, " ")} ${body.layer} ${"x".repeat(body.block_id.length)}`, score: 0.9 }], total: 1 });
    case "/api/v1/knowledge/wiki/page/ls": return ok({ pages: [{ id: "concepts/a", title: "A", path: "wiki/concepts/a.md", type: "concept" }] });
    case "/api/v1/knowledge/wiki/raw/ls": return ok({ files: [{ filename: "a.docx", status: "ingested", size: 1 }] });
    case "/api/v1/chat-memory/layer":
      if (body.layer === "L3") return ok({ items: [{ id: "core", body: "Doctrine: employee registration follows the standard stack" }] });
      if (body.path) return ok({ items: [{ title: body.path, body: "Scenario: employee registration rollout plan" }] });
      return ok({ items: [{ title: "pilot.md", body: "" }] });
    case "/api/v1/knowledge/wiki/team-assets": return ok({ items: [{ knowledge_id: "wiki-1", name: "API Spec", status: "ready" }, { knowledge_id: "wiki-2", name: "Draft", status: "building" }], total: 2 });
    case "/api/v1/knowledge/wiki/search": return ok({ results: [{ path: "page/a", title: "Employee Registration", score: 0.000001, related: [{ title: "x" }] }, { path: "page/copy", title: "Employee Registration copy", score: 0.000001 }, { path: "page/x", title: "Unrelated", score: 0.000001 }], links: [], count: 3 });
    case "/api/v1/knowledge/wiki/page/read": return ok({ items: [{ ref: body.refs[0], content: body.refs[0] === "page/x" ? "zzz qqq" : LONG_PAGE }] });
    case "/api/v1/knowledge/code-graph/team-assets": return ok({ items: [{ knowledge_id: "cg-1", name: "repo" }], total: 1 });
    case "/api/v1/knowledge/code-graph/search":
      return brokenCodeGraph
        ? { status: 500, body: { code: 0, message: "ok", data: { text: "index missing", isError: true } } }
        : ok({ text: "registerEmployee in src/user/register.ts", isError: false });
    case "/api/v1/skill/list": return ok({ items: [{ skill_id: "skl-1" }], total: 1 });
    case "/api/v1/meta/team/get": return { status: 500, body: { code: 500, message: `leak Bearer ${API_KEY} and ${DEV_KEY}`, data: null } };
    default: return { status: 404, body: { code: 404, message: `no mock for ${path}`, data: null } };
  }
}

const mock = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d)).on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ path: req.url, body, headers: req.headers });
    const { status, body: out } = route(req.url, body, req.headers);
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(out));
  });
});

let baseUrl;
before(() => new Promise((done) => mock.listen(0, "127.0.0.1", () => {
  baseUrl = `http://127.0.0.1:${mock.address().port}`;
  done();
})));
const clients = [];
after(async () => {
  await Promise.all(clients.map((client) => client.close()));
  mock.closeAllConnections();
  mock.close();
});

async function connect(overrides = {}) {
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    TENCENTDB_URL: baseUrl, TENCENTDB_PANEL_URL: baseUrl, TENCENTDB_API_KEY: API_KEY, TENCENTDB_USER_KEY: DEV_KEY,
    // Set everything the real .env could supply, so it can't leak into a test.
    TENCENTDB_PROJECT_ID: "", TENCENTDB_PROJECTS_FILE: "", TENCENTDB_MEMORY_ACCESS: "", TENCENTDB_MEMORY_URL: "",
    TENCENTDB_KNOWLEDGE_URL: baseUrl, TENCENTDB_SHARED_AGENT_ID: "agt-shared", TENCENTDB_DECISIONS_WIKI_ID: "wiki-1",
    TENCENTDB_SERVICE_ID: "default", TENCENTDB_TEAM_ID: TEAM, TENCENTDB_AGENT_ID: "agt-dev2", TENCENTDB_USER_ID: "usr-dev2",
    ...overrides,
  };
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env }));
  clients.push(client);
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  return { isError: !!result.isError, text, json: result.isError ? undefined : JSON.parse(text) };
}
const panelCalls = () => calls.filter((c) => c.path.startsWith("/api/v1/") && c.path !== "/api/v1/meta/auth/verify");

test("registers the full tool set", async () => {
  const client = await connect();
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "find_related_files", "get_agent", "get_code_entity", "get_code_relationships", "get_development_context",
    "get_my_tasks", "get_project_context", "get_skill", "get_task", "get_task_context", "get_team", "get_wiki_document",
    "list_skills", "list_team_agents", "list_wiki_documents", "save_conversation", "save_development_decision",
    "search_code_graph", "search_conversations", "search_core_memories", "search_memories", "search_project_knowledge",
    "search_scenario_memories", "search_skills", "search_tasks", "search_wiki", "update_task_status",
  ]);
  await client.close();
});

test("core access keeps the original request and identity headers", async () => {
  const client = await connect({ TENCENTDB_MEMORY_ACCESS: "core" });
  calls.length = 0;
  const { json } = await call(client, "search_memories", { query: "stack" });
  const request = calls.find((c) => c.path === "/v3/atomic/search");
  assert.equal(request.path, "/v3/atomic/search");
  assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(request.headers["x-tdai-agent-id"], "agt-dev2");
  assert.equal(request.headers["x-tdai-user-id"], "usr-dev2");
  assert.deepEqual(request.body, { query: "stack", limit: 5 });
  assert.equal(json.items[0].source.scope, "agent");
  assert.equal(json.items[0].source.layer, "L1");
  await client.close();
});

test("save_conversation posts the unchanged contract in core access", async () => {
  const client = await connect({ TENCENTDB_MEMORY_ACCESS: "core" });
  calls.length = 0;
  const args = { session_id: "s1", messages: [{ role: "user", content: "hello" }] };
  const { json } = await call(client, "save_conversation", args);
  const request = calls.find((c) => c.path === "/v3/conversation/add");
  assert.deepEqual(request.body, args);
  assert.equal(json.total_count, 1);
  await client.close();
});

test("team scope uses Panel blocks and labels the source", async () => {
  const client = await connect();
  calls.length = 0;
  const { json } = await call(client, "search_memories", { query: "stack", scope: "team" });
  assert.ok(!calls.some((c) => c.path.startsWith("/v3/")), "team scope must not touch core");
  assert.deepEqual(json.items[0].source, {
    layer: "L1", scope: "team", team_id: TEAM, agent_id: "agt-dev1", owner_user_id: "usr-dev1",
    block_id: DEV1_BLOCK, block_title: "Memory of dev1",
  });
  await client.close();
});

test("a denied team block is reported and never replaced by agent search", async () => {
  const client = await connect();
  calls.length = 0;
  failBlockSearch = true;
  const { json } = await call(client, "search_memories", { query: "stack", scope: "team" });
  failBlockSearch = false;
  assert.equal(json.items.length, 0);
  assert.equal(json.errors.length, 2);
  assert.match(json.errors[0].error, /ASSET_NOT_ACCESSIBLE/);
  assert.ok(!calls.some((c) => c.path === "/v3/atomic/search"));
  await client.close();
});

test("team scope without a Panel URL errors with no core fallback", async () => {
  const client = await connect({ TENCENTDB_PANEL_URL: "" });
  calls.length = 0;
  const result = await call(client, "search_memories", { query: "stack", scope: "team" });
  assert.equal(result.isError, true);
  assert.match(result.text, /TENCENTDB_PANEL_URL/);
  assert.equal(calls.length, 0);
  await client.close();
});

test("admin keys are refused before any Panel data call", async () => {
  const client = await connect({ TENCENTDB_USER_KEY: ADMIN_KEY });
  calls.length = 0;
  const result = await call(client, "get_agent");
  assert.equal(result.isError, true);
  assert.match(result.text, /system_admin/);
  assert.equal(panelCalls().length, 0);
  await client.close();
});

test("a key belonging to another developer is refused", async () => {
  const client = await connect({ TENCENTDB_USER_ID: "dev1" });
  calls.length = 0;
  const result = await call(client, "list_skills");
  assert.equal(result.isError, true);
  assert.match(result.text, /not TENCENTDB_USER_ID/);
  assert.equal(panelCalls().length, 0);
  await client.close();
});

test("agent scope cannot target another agent", async () => {
  const client = await connect();
  calls.length = 0;
  const result = await call(client, "search_memories", { query: "x", agent_id: "agt-dev1" });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
  await client.close();
});

test("unsupported team filters are rejected, not silently dropped", async () => {
  const client = await connect();
  const result = await call(client, "search_conversations", { query: "x", scope: "team", session_id: "s1" });
  assert.equal(result.isError, true);
  assert.match(result.text, /session_id/);
  await client.close();
});

test("identity warning appears when TENCENTDB_USER_ID is a username", async () => {
  const client = await connect({ TENCENTDB_USER_ID: "dev2" });
  const { json } = await call(client, "search_memories", { query: "stack", scope: "team" });
  assert.match(json.identity_warning, /usr-dev2/);
  await client.close();
});

test("scenario search filters content, skips directories, reports coverage", async () => {
  const client = await connect({ TENCENTDB_MEMORY_ACCESS: "core" });
  const { json } = await call(client, "search_scenario_memories", { query: "prisma" });
  assert.equal(json.files_total, 2);
  assert.equal(json.files_scanned, 2);
  assert.deepEqual(json.items.map((i) => i.path), ["stack.md"]);
  await client.close();
});

test("wiki search covers only ready wikis and names the source", async () => {
  const client = await connect();
  const { json } = await call(client, "search_wiki", { query: "api" });
  assert.equal(json.wikis_searched, 1);
  assert.equal(json.items[0].wiki_name, "API Spec");
  await client.close();
});

test("get_wiki_document requires exactly one selector", async () => {
  const client = await connect();
  assert.equal((await call(client, "get_wiki_document", { wiki_id: "wiki-1" })).isError, true);
  const { json } = await call(client, "get_wiki_document", { wiki_id: "wiki-1", refs: ["page/a"] });
  assert.equal(json.items[0].ref, "page/a");
  await client.close();
});

test("code graph isError with code 0 is reported as a failure", async () => {
  const client = await connect();
  brokenCodeGraph = true;
  const { json } = await call(client, "search_code_graph", { query: "login" });
  brokenCodeGraph = false;
  assert.equal(json.items.length, 0);
  assert.match(json.errors[0].error, /index missing/);
  await client.close();
});

test("secrets in upstream errors are redacted", async () => {
  const client = await connect();
  const result = await call(client, "get_team");
  assert.equal(result.isError, true);
  assert.ok(!result.text.includes(API_KEY));
  assert.ok(!result.text.includes(DEV_KEY));
  await client.close();
});

test("agent scope reads the caller's own block through the Panel by default", async () => {
  const client = await connect();
  calls.length = 0;
  const { json } = await call(client, "search_memories", { query: "stack" });
  assert.ok(!calls.some((c) => c.path.startsWith("/v3/")), "Panel access must not touch core");
  assert.equal(json.scope, "agent");
  assert.equal(json.items[0].source.block_id, `chat_memory-${TEAM}-agt-dev2`);
  await client.close();
});

test("the shared token is not needed in Panel access", async () => {
  const client = await connect({ TENCENTDB_API_KEY: "", TENCENTDB_URL: "" });
  const { json } = await call(client, "search_memories", { query: "stack" });
  assert.equal(json.scope, "agent");
  await client.close();
});

test("save_conversation goes through the ownership-checked Panel route", async () => {
  const client = await connect();
  calls.length = 0;
  const { json } = await call(client, "save_conversation", { session_id: "s1", messages: [{ role: "user", content: "hello" }] });
  const request = calls.find((c) => c.path === "/api/v1/chat-memory/import");
  assert.equal(request.body.agent_id, "agt-dev2");
  assert.equal(json.accepted_count, 1);
  await client.close();
});

test("admin keys are refused on MemoryCore before any data call", async () => {
  const client = await connect({ TENCENTDB_MEMORY_ACCESS: "core", TENCENTDB_API_KEY: ADMIN_KEY, TENCENTDB_USER_KEY: "" });
  calls.length = 0;
  const result = await call(client, "search_memories", { query: "stack" });
  assert.equal(result.isError, true);
  assert.match(result.text, /system_admin/);
  assert.deepEqual(calls.map((c) => c.path), ["/v3/meta/auth/verify"]);
  await client.close();
});

test("code tools call Knowledge only for graphs the Panel lists", async () => {
  const client = await connect();
  calls.length = 0;
  const denied = await call(client, "get_code_entity", { symbol: "x", code_graph_id: "cg-other" });
  assert.equal(denied.isError, true);
  assert.ok(!calls.some((c) => c.path === "/v3/tools/call"));
  const { json } = await call(client, "get_code_entity", { symbol: "registerEmployee", code_graph_id: "cg-1", include_code: true });
  const request = calls.find((c) => c.path === "/v3/tools/call");
  assert.deepEqual(request.body, { knowledge_id: "cg-1", tool_name: "node", params: { symbol: "registerEmployee", includeCode: true } });
  assert.match(json.items[0].text, /src\/user\/register.ts/);
  await client.close();
});

test("relationships return callers, callees and impact", async () => {
  const client = await connect();
  const { json } = await call(client, "get_code_relationships", { symbol: "f", depth: 3 });
  assert.match(json.items[0].callers, /callers of f/);
  assert.match(json.items[0].callees, /callees of f/);
  assert.match(json.items[0].impact, /impact of f/);
  await client.close();
});

test("find_related_files needs a selector and uses explore or files", async () => {
  const client = await connect();
  assert.equal((await call(client, "find_related_files")).isError, true);
  calls.length = 0;
  await call(client, "find_related_files", { pattern: "*.ts" });
  assert.equal(calls.find((c) => c.path === "/v3/tools/call").body.tool_name, "files");
  await client.close();
});

test("get_my_tasks keeps only this agent's tasks", async () => {
  const client = await connect();
  const { json } = await call(client, "get_my_tasks");
  assert.deepEqual(json.items.map((t) => t.task_id), ["tsk-1"]);
  await client.close();
});

test("update_task_status surfaces the server's creator-only denial", async () => {
  const client = await connect();
  const result = await call(client, "update_task_status", { task_id: "tsk-1", status: "completed" });
  assert.equal(result.isError, true);
  assert.match(result.text, /not_task_creator/);
  await client.close();
});

const decision = { title: "Use Prisma", decision: "Prisma for all data access" };

test("private saves are refused when the agent's block is team-visible", async () => {
  const client = await connect();
  ownVisibility = "team";
  calls.length = 0;
  const result = await call(client, "save_development_decision", { ...decision, scope: "developer_private" });
  ownVisibility = "private";
  assert.equal(result.isError, true);
  assert.match(result.text, /team-visible/);
  assert.ok(!calls.some((c) => c.path === "/api/v1/chat-memory/import"));
  await client.close();
});

test("private saves go to the agent's own memory and duplicates are skipped", async () => {
  const client = await connect();
  const first = await call(client, "save_development_decision", { ...decision, scope: "developer_private" });
  assert.equal(first.json.stored_in, "agent_memory");
  const second = await call(client, "save_development_decision", { ...decision, scope: "developer_private" });
  assert.equal(second.json.saved, false);
  await client.close();
});

test("team-shared saves publish to the wiki and start ingest", async () => {
  const client = await connect();
  calls.length = 0;
  const { json } = await call(client, "save_development_decision", { ...decision, scope: "team_shared" });
  const write = calls.find((c) => c.path === "/api/v1/knowledge/wiki/raw/write");
  assert.match(write.body.files[0].filename, /^decision-.*use-prisma\.md$/);
  assert.ok(calls.some((c) => c.path === "/api/v1/knowledge/wiki/ingest"));
  assert.equal(json.stored_in, "wiki");
  await client.close();
});

test("documentation candidates are written without ingest", async () => {
  const client = await connect();
  calls.length = 0;
  const { json } = await call(client, "save_development_decision", { ...decision, scope: "documentation_candidate" });
  assert.ok(!calls.some((c) => c.path === "/api/v1/knowledge/wiki/ingest"));
  assert.equal(json.searchable, false);
  await client.close();
});

test("a developer cannot write as the shared engineering agent", async () => {
  const client = await connect();
  const result = await call(client, "save_development_decision", { ...decision, scope: "shared_engineering_agent" });
  assert.equal(result.isError, true);
  assert.match(result.text, /team_shared/);
  await client.close();
});

test("content that looks like a credential is refused without echoing it", async () => {
  const client = await connect();
  calls.length = 0;
  const leaked = "sk-abcdefghijklmnopqrstuvwx";
  const result = await call(client, "save_development_decision", { title: "t", decision: `use key ${leaked}`, scope: "team_shared" });
  assert.equal(result.isError, true);
  assert.ok(!result.text.includes(leaked));
  assert.ok(!calls.some((c) => c.path === "/api/v1/knowledge/wiki/raw/write"));
  await client.close();
});

const contextRequest = { task_description: "Implement employee registration API" };

test("context separates shared and private and labels every item", async () => {
  const client = await connect();
  const { json } = await call(client, "get_development_context", contextRequest);
  assert.ok(json.shared_context.length > 0);
  assert.ok(json.private_context.length > 0);
  assert.ok(json.shared_context.every((i) => ["team_shared", "shared_engineering_agent"].includes(i.access_scope)));
  assert.ok(json.private_context.every((i) => i.access_scope === "agent_private"));
  for (const item of [...json.shared_context, ...json.private_context]) {
    assert.ok(item.source_type && item.id && item.fetch.tool);
  }
  assert.ok(json.shared_context.some((i) => i.access_scope === "shared_engineering_agent"));
  await client.close();
});

test("context labels the caller's team-visible block honestly", async () => {
  const client = await connect();
  ownVisibility = "team";
  const { json } = await call(client, "get_development_context", { task_description: "employee registration audit" });
  ownVisibility = "private";
  assert.ok(json.private_context.length > 0);
  assert.ok(json.private_context.every((i) => i.access_scope === "agent_own_team_visible"));
  await client.close();
});

test("include_private false reads no own memory", async () => {
  const client = await connect();
  calls.length = 0;
  const { json } = await call(client, "get_development_context", { ...contextRequest, include_private: false });
  assert.equal(json.private_context.length, 0);
  assert.ok(!calls.some((c) => c.body.block_id === `chat_memory-${TEAM}-agt-dev2`));
  await client.close();
});

test("context fits the budget, removes duplicates and drops irrelevant results", async () => {
  const client = await connect();
  const { json } = await call(client, "get_development_context", { ...contextRequest, max_context_tokens: 2000 });
  assert.ok(json.statistics.context_tokens <= 2000, `used ${json.statistics.context_tokens}`);
  assert.ok(json.statistics.duplicates_removed >= 1);
  assert.ok(![...json.shared_context, ...json.references].some((i) => i.title.includes("Unrelated")));
  await client.close();
});

test("a failed source becomes a warning, not silent empty context", async () => {
  const client = await connect();
  brokenCodeGraph = true;
  const { json } = await call(client, "get_development_context", { task_description: "employee onboarding wizard" });
  brokenCodeGraph = false;
  assert.ok(json.warnings.some((w) => w.includes("code_graph")));
  assert.equal(json.statistics.sources.find((s) => s.source === "code_graph").failed, true);
  await client.close();
});

test("identical requests hit the cache, and saving invalidates it", async () => {
  const client = await connect();
  const args = { task_description: "employee cache check" };
  assert.equal((await call(client, "get_development_context", args)).json.statistics.cache_hit, false);
  assert.equal((await call(client, "get_development_context", args)).json.statistics.cache_hit, true);
  await call(client, "save_development_decision", { ...decision, title: "Cache", scope: "developer_private" });
  assert.equal((await call(client, "get_development_context", args)).json.statistics.cache_hit, false);
  await client.close();
});

test("related files come from code graph results", async () => {
  const client = await connect();
  const { json } = await call(client, "get_development_context", { ...contextRequest, file_paths: ["src/app.ts"] });
  assert.ok(json.related_files.includes("src/app.ts"));
  assert.ok(json.related_files.includes("src/user/register.ts"));
  await client.close();
});

test("project profiles select the team, and unknown projects fail", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "proj-")), "projects.json");
  writeFileSync(file, JSON.stringify({ default_project: "alpha", projects: { alpha: { wiki_ids: ["wiki-none"] }, beta: { team_id: "team-beta" } } }));
  const client = await connect({ TENCENTDB_PROJECTS_FILE: file });
  calls.length = 0;
  const { json } = await call(client, "get_development_context", contextRequest);
  assert.equal(json.project.id, "alpha");
  assert.ok(!calls.some((c) => c.path === "/api/v1/knowledge/wiki/search"), "wiki_ids narrows the search");
  await call(client, "get_development_context", { ...contextRequest, project_id: "beta" });
  assert.ok(calls.some((c) => c.body.team_id === "team-beta"));
  const unknown = await call(client, "get_development_context", { ...contextRequest, project_id: "gamma" });
  assert.equal(unknown.isError, true);
  await client.close();
});

test("wiki results expose a readable ref and drop bulky link lists", async () => {
  const client = await connect();
  const { json } = await call(client, "search_wiki", { query: "api" });
  assert.equal(json.items[0].ref, "page/a");
  assert.equal(json.items[0].related, undefined);
  const listed = await call(client, "list_wiki_documents", { wiki_id: "wiki-1" });
  assert.equal(listed.json.pages[0].ref, "concepts/a");
  assert.equal(listed.json.raw_files[0].filename, "a.docx");
  await client.close();
});

test("context includes L2 and L3 memory, which have no server search", async () => {
  const client = await connect();
  const { json } = await call(client, "get_development_context", { ...contextRequest, max_context_tokens: 20000 });
  const ids = [...json.shared_context, ...json.private_context].map((i) => i.id);
  assert.ok(ids.some((id) => id.endsWith(":core")));
  assert.ok(ids.some((id) => id.endsWith(":pilot.md")));
  await client.close();
});

test("an empty package says so instead of looking like success", async () => {
  const client = await connect();
  const { json } = await call(client, "get_development_context", { task_description: "zzzzqqqq" });
  assert.equal(json.statistics.results_selected, 0);
  assert.ok(json.warnings.some((w) => w.includes("No relevant context")));
  await client.close();
});
