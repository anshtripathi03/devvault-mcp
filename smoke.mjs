/**
 * Smoke test: wire the server to an in-memory client and exercise every tool
 * against a stub DevVault API. Run with `node smoke.mjs` after `npm run build`.
 */

import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { buildServer, nest } from "./dist/server.js";
import { Ledger } from "./dist/ledger.js";

let passed = 0;
const failures = [];
function check(label, condition) {
  if (condition) passed += 1;
  else failures.push(label);
}

// ── nest(): flat list -> tree ────────────────────────────────────────────────
{
  const tree = nest([
    { title: "Root", blocks: [], parent: null, external_key: "root" },
    { title: "Child A", blocks: [], parent: 0 },
    { title: "Grandchild", blocks: [], parent: 1 },
    { title: "Child B", blocks: [], parent: 0 },
  ]);
  check("nest: root title", tree.title === "Root");
  check("nest: two children", tree.children.length === 2);
  check("nest: grandchild attached", tree.children[0].children[0].title === "Grandchild");
  check("nest: external_key carried", tree.external_key === "root");

  const roled = nest([
    { title: "Conventions", blocks: [], parent: null, role: "core" },
    { title: "Background", blocks: [], parent: 0, role: "reference" },
  ]);
  check("nest: role carried on the root", roled.role === "core");
  check("nest: role carried on a child", roled.children[0].role === "reference");

  let threw = false;
  try {
    nest([{ title: "A", blocks: [], parent: 5 }]);
  } catch {
    threw = true;
  }
  check("nest: rejects a bad parent index", threw);

  threw = false;
  try {
    nest([{ title: "A", blocks: [], parent: 0 }]);
  } catch {
    threw = true;
  }
  check("nest: rejects a self-parent", threw);
}

// ── Stub client ──────────────────────────────────────────────────────────────
const calls = [];
const stub = {
  listCollections: async () => {
    calls.push("listCollections");
    return [
      { id: "1", slug: "frontend", name: "Frontend", description: "UI conventions", member_count: 3 },
    ];
  },
  context: async (slug) => {
    calls.push(`context:${slug}`);
    return {
      collection: "frontend",
      resolved_from: slug === "fronend" ? "fronend" : null,
      core: "- Components live in a per-page folder.",
      manifest: [{ slug_or_id: "lcp", title: "LCP", summary: "hero images", has_rules: true }],
      core_tokens: 12,
      note: null,
    };
  },
  route: async (task) => {
    calls.push(`route:${task}`);
    if (task.includes("haiku")) {
      return { task, routed: [], core: "", manifest: [], note: "No collection matched this task." };
    }
    return {
      task,
      routed: [{ slug: "frontend", name: "Frontend", score: 1, selected: true }],
      core: "- Components live in a per-page folder.",
      manifest: [{ slug_or_id: "lcp", title: "LCP", summary: "hero images", has_rules: false }],
      note: "Loaded: @frontend. Skipped: @backend.",
    };
  },
  search: async (slug, query) => {
    calls.push(`search:${slug}:${query}`);
    if (query.includes("kubernetes")) {
      return { query, collection: slug, hits: [], omitted: [] };
    }
    return {
      query,
      collection: slug,
      hits: [
        {
          container_id: "lcp",
          title: "LCP",
          score: 1,
          content: "- Preload the hero font.",
          has_rules: true,
          tokens: 10,
        },
      ],
      omitted: [],
    };
  },
  containerMarkdown: async (id) => {
    calls.push(`markdown:${id}`);
    return `# ${id}\n\nFull content.`;
  },
  writeRules: async (id) => {
    calls.push(`writeRules:${id}`);
    return { updated: true };
  },
  import: async (payload) => {
    calls.push("import");
    return {
      collection: { id: "c1", slug: "frontend-perf", name: "Frontend perf" },
      root_id: "r1",
      containers: [
        { id: "r1", title: payload.root.title, parent_id: null, depth: 1, block_count: 1, external_key: "root" },
      ],
      blocks_created: 1,
      adjustments: [{ container: "Root", kind: "blocks_spilled", detail: "Spilled into 1 continuation." }],
    };
  },
};

const ledger = new Ledger();
const server = buildServer(stub, ledger);
const client = new Client({ name: "smoke", version: "0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

// ── Tools are registered ─────────────────────────────────────────────────────
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
check(
  "tools: all six registered",
  JSON.stringify(names) ===
    JSON.stringify([
      "devvault_context",
      "devvault_get_container",
      "devvault_list_collections",
      "devvault_save_research",
      "devvault_search",
      "devvault_write_rules",
    ]),
);
check(
  "tools: context description tells the agent to send a task sentence",
  tools.find((t) => t.name === "devvault_context").description.includes("one short sentence"),
);
check(
  "tools: write_rules insists on a task-agnostic extraction",
  tools.find((t) => t.name === "devvault_write_rules").description.includes("not only the ones relevant"),
);
check(
  "tools: save_research exposes a role per container",
  JSON.stringify(
    tools.find((t) => t.name === "devvault_save_research").inputSchema,
  ).includes("reference"),
);

const body = (r) => r.content.map((c) => c.text).join("\n");

// ── Bind loop ────────────────────────────────────────────────────────────────
const ctx = await client.callTool({ name: "devvault_context", arguments: { task: "build the home page UI" } });
check("context: core returned", body(ctx).includes("per-page folder"));
check("context: manifest rendered", body(ctx).includes("Available reference context"));
check("context: routing note surfaced", body(ctx).includes("Skipped: @backend"));

const noMatch = await client.callTool({ name: "devvault_context", arguments: { task: "write a haiku about the ocean" } });
check("context: no match says so plainly", body(noMatch).includes("No collection matched"));
check("context: no match does not invent context", !body(noMatch).includes("per-page folder"));

const resolved = await client.callTool({ name: "devvault_context", arguments: { collection: "fronend" } });
check("context: typo correction is reported", body(resolved).includes("Resolved"));

const missingArgs = await client.callTool({ name: "devvault_context", arguments: {} });
check("context: needs task or collection", missingArgs.isError === true);

// ── Search + ledger ──────────────────────────────────────────────────────────
const first = await client.callTool({ name: "devvault_search", arguments: { query: "hero image" } });
check("search: content returned", body(first).includes("Preload the hero font"));

const second = await client.callTool({ name: "devvault_search", arguments: { query: "hero image again" } });
check("search: repeat is skipped, not resent", !body(second).includes("Preload the hero font"));
check("search: the skip is announced", body(second).includes("already loaded earlier this session"));

const empty = await client.callTool({ name: "devvault_search", arguments: { query: "kubernetes helm" } });
check("search: no match is explicit", body(empty).includes("No saved research matched"));

// ── Budget ───────────────────────────────────────────────────────────────────
{
  const tightLedger = new Ledger({ core: 800, perSearch: 4000, session: 5 });
  const tightServer = buildServer(stub, tightLedger);
  const tightClient = new Client({ name: "smoke-tight", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([tightServer.connect(st), tightClient.connect(ct)]);
  const result = await tightClient.callTool({ name: "devvault_search", arguments: { query: "hero image" } });
  check("budget: over-budget content is withheld", !body(result).includes("Preload the hero font"));
  check("budget: withholding is loud", body(result).includes("Budget reached"));
  check("budget: tells the agent how to fetch it anyway", body(result).includes("devvault_get_container"));
}

// ── Other tools ──────────────────────────────────────────────────────────────
const full = await client.callTool({ name: "devvault_get_container", arguments: { container_id: "lcp" } });
check("get_container: returns markdown", body(full).includes("Full content"));

const rules = await client.callTool({
  name: "devvault_write_rules",
  arguments: { container_id: "lcp", rules: "- Preload the hero font." },
});
check("write_rules: confirms the cache", body(rules).includes("Rules cached"));

const list = await client.callTool({ name: "devvault_list_collections", arguments: {} });
check("list_collections: renders slugs", body(list).includes("@frontend"));

// ── Capture loop ─────────────────────────────────────────────────────────────
const saved = await client.callTool({
  name: "devvault_save_research",
  arguments: {
    containers: [
      { title: "Frontend perf", blocks: [{ type: "PARAGRAPH", content: "Overview." }], parent: null, external_key: "fp" },
    ],
    collection_description: "Web vitals research",
  },
});
check("save_research: reports what it created", body(saved).includes("Saved 1 container"));
check("save_research: surfaces adjustments", body(saved).includes("Spilled into 1 continuation"));
check("save_research: tells the agent to pass them on", body(saved).includes("Tell the user"));

const badTree = await client.callTool({
  name: "devvault_save_research",
  arguments: { containers: [{ title: "Orphan", blocks: [], parent: 3 }] },
});
check("save_research: invalid parent index is an error", badTree.isError === true);

// ── Errors ───────────────────────────────────────────────────────────────────
{
  const failing = {
    ...stub,
    context: async () => {
      const err = new Error("nope");
      err.name = "DevVaultError";
      throw err;
    },
  };
  const errServer = buildServer(failing, new Ledger());
  const errClient = new Client({ name: "smoke-err", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([errServer.connect(st), errClient.connect(ct)]);
  const result = await errClient.callTool({ name: "devvault_context", arguments: { collection: "x" } });
  check("errors: surfaced as tool errors, not crashes", result.isError === true);
}

console.log(`${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAILED: ${failure}`);
process.exit(failures.length ? 1 : 0);
