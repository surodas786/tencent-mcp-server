// Live check against the deployed services, using this machine's .env identity.
// Stops immediately on an admin key. Read-only unless --write is given.
//
//   npm run live-check                               read checks and context benchmark
//   npm run live-check -- --query prisma             choose the search term
//   npm run live-check -- --private-block <id>       a block this developer must NOT read
//   npm run live-check -- --symbol <name>            code graph entity checks
//   npm run live-check -- --write                    also saves one labelled test decision per scope
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values } = parseArgs({
  options: {
    query: { type: "string", default: "api" },
    "private-block": { type: "string" },
    symbol: { type: "string" },
    write: { type: "boolean", default: false },
  },
});
const { query, symbol } = values;

const client = new Client({ name: "live-check", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));

let failures = 0;
let empties = 0;

async function run(name, args = {}, { expectEmptyOk = false } = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content[0].text;
  if (/system_admin/.test(text)) {
    console.log("STOP: admin key detected. No live tests were run.");
    await client.close();
    process.exit(2);
  }
  const json = result.isError ? undefined : JSON.parse(text);
  const count = json?.items?.length ?? json?.messages?.length;
  const errors = json?.errors?.length ?? 0;
  // HTTP success with no results is reported separately: it is not proof of function.
  const empty = count === 0 && !expectEmptyOk;
  const status = result.isError || errors ? "FAIL " : empty ? "EMPTY" : "OK   ";
  if (result.isError || errors) failures++;
  if (empty) empties++;
  console.log(`${status} ${name} ${JSON.stringify(args).slice(0, 90)}${count === undefined ? "" : ` -> ${count}`}`);
  if (result.isError) console.log(`      ${text.slice(0, 300)}`);
  else if (errors) console.log(`      ${JSON.stringify(json.errors).slice(0, 300)}`);
  if (json?.identity_warning) console.log(`      WARNING ${json.identity_warning}`);
  return json;
}

// Team and identity
await run("get_team");
await run("list_team_agents");
await run("get_agent");
await run("get_project_context");

// Chat memory
for (const scope of ["agent", "team"]) {
  await run("search_memories", { query, scope });
  await run("search_conversations", { query, scope });
  await run("search_scenario_memories", { query, scope });
  await run("search_core_memories", { scope });
}

// Wiki
const wikis = await run("list_wiki_documents");
for (const wiki of wikis?.items ?? []) console.log(`      ${wiki.knowledge_id}  ${wiki.name}  [${wiki.status}]  ${wiki.page_count ?? "?"} pages`);
if (wikis?.items?.[0]) await run("list_wiki_documents", { wiki_id: wikis.items[0].knowledge_id });
const hits = await run("search_wiki", { query });
if (hits?.items?.[0]) await run("get_wiki_document", { wiki_id: hits.items[0].wiki_id, refs: [hits.items[0].ref] });

// Code graph
await run("search_code_graph", { query });
await run("find_related_files", { query });
if (symbol) {
  await run("get_code_entity", { symbol });
  await run("get_code_relationships", { symbol });
}

// Skills and tasks
const skills = await run("list_skills");
await run("search_skills", { query });
if (skills?.items?.[0]) await run("get_skill", { skill_id: skills.items[0].skill_id });
const tasks = await run("search_tasks");
await run("get_my_tasks", {}, { expectEmptyOk: true });
if (tasks?.items?.[0]) await run("get_task", { task_id: tasks.items[0].task_id });

// Private isolation
if (values["private-block"]) {
  const result = await client.callTool({
    name: "search_memories",
    arguments: { query, scope: "team", block_id: values["private-block"] },
  });
  const text = result.content[0].text;
  // BLOCK_NOT_FOUND means the block doesn't exist yet, which proves nothing about access.
  if (/ASSET_NOT_ACCESSIBLE/.test(text)) {
    console.log("OK    private block denied by the server");
  } else if (/BLOCK_NOT_FOUND/.test(text)) {
    console.log("INCONCLUSIVE private block does not exist yet; isolation not tested");
  } else {
    failures++;
    console.log("FAIL  private block WAS READABLE");
  }
}

// Context benchmark. Baseline: reading every wiki page once.
const scenarios = [
  "Implement employee registration",
  "Modify an existing API endpoint",
  "Add a database table",
  "Fix an authentication issue",
  "Refactor an existing module",
];
let baselineTokens = 0;
for (const wiki of wikis?.items ?? []) {
  const listing = await client.callTool({ name: "list_wiki_documents", arguments: { wiki_id: wiki.knowledge_id } });
  if (listing.isError) continue;
  const pages = JSON.parse(listing.content[0].text).pages ?? [];
  if (pages.length === 0) console.log(`      no pages listed for ${wiki.name}`);
  for (let i = 0; i < pages.length; i += 20) {
    const refs = pages.slice(i, i + 20).map((page) => page.ref);
    const read = await client.callTool({ name: "get_wiki_document", arguments: { wiki_id: wiki.knowledge_id, refs } });
    if (!read.isError) baselineTokens += Math.ceil(read.content[0].text.length / 4);
  }
}
console.log(`\nBaseline, all wiki pages: about ${baselineTokens} tokens (estimate)`);
console.log("task | tokens | selected/retrieved | duplicates | latency ms | sources | warnings");
for (const task_description of scenarios) {
  const json = await run("get_development_context", { task_description });
  if (!json) continue;
  const s = json.statistics;
  console.log(`${task_description} | ${s.context_tokens} | ${s.results_selected}/${s.results_retrieved} | ${s.duplicates_removed} | ${s.latency_ms} | ${s.contributing_sources.join(",")} | ${json.warnings.length}`);
}

// Writes
if (values.write) {
  const label = `live-check ${new Date().toISOString()}`;
  for (const scope of ["developer_private", "team_shared"]) {
    await run("save_development_decision", { title: `${label} ${scope}`, decision: `Test record for ${scope}. Safe to ignore.`, scope });
  }
}

await client.close();
console.log(`\n${failures} failed, ${empties} empty. Review every EMPTY: it may mean no data, or a problem.`);
process.exit(failures ? 1 : 0);
