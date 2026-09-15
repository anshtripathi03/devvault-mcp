/**
 * Tool definitions, shared by both transports.
 *
 * The descriptions here are load-bearing code, not documentation. They are the
 * only thing that teaches an agent to pass a short task description instead of
 * the user's raw prompt, to re-call when the task changes area, and to write
 * back a task-agnostic rule extraction rather than one scoped to whatever it
 * happens to be building. Change them carefully.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DevVaultClient, DevVaultError, type ManifestEntry } from "./client.js";
import { Ledger, estimateTokens } from "./ledger.js";

const BLOCK_TYPES = [
  "HEADING",
  "PARAGRAPH",
  "CODE",
  "IMAGE",
  "LINK",
  "container_ref",
] as const;

const blockSchema = z.object({
  type: z.enum(BLOCK_TYPES),
  content: z
    .string()
    .describe(
      "HEADING/PARAGRAPH: the text. CODE: the source. IMAGE/LINK: the URL.",
    ),
  meta: z
    .record(z.any())
    .optional()
    .describe('CODE: {"language"}. IMAGE: {"alt"}. LINK: {"text"}.'),
});

// A flat list with parent indices, rather than a nested tree: models emit this
// shape far more reliably, and re-nesting it is trivial on this side.
const flatContainerSchema = z.object({
  title: z.string().describe("Short and specific. Max 15 words."),
  blocks: z.array(blockSchema).default([]),
  parent: z
    .number()
    .int()
    .nullable()
    .default(null)
    .describe(
      "Index of this container's parent in this same array, or null for the root. The first entry must be the root.",
    ),
  external_key: z
    .string()
    .optional()
    .describe(
      "Stable id you choose, e.g. 'frontend-perf-lcp'. Re-importing the same research with the same key updates it in place instead of creating a duplicate. Always set one.",
    ),
  agent_rules: z
    .string()
    .optional()
    .describe(
      "Optional. The actionable rules from this container, one per line, imperative.",
    ),
});

interface FlatContainer {
  title: string;
  blocks: Array<{ type: string; content: string; meta?: Record<string, unknown> }>;
  parent: number | null;
  external_key?: string;
  agent_rules?: string;
}

interface NestedContainer {
  title: string;
  blocks: FlatContainer["blocks"];
  children: NestedContainer[];
  external_key?: string;
  agent_rules?: string;
}

/** Re-nest a flat parent-indexed list into the tree the API expects. */
export function nest(flat: FlatContainer[]): NestedContainer {
  if (flat.length === 0) throw new Error("No containers supplied.");

  const nodes: NestedContainer[] = flat.map((item) => ({
    title: item.title,
    blocks: item.blocks ?? [],
    children: [],
    external_key: item.external_key,
    agent_rules: item.agent_rules,
  }));

  let root: NestedContainer | null = null;
  flat.forEach((item, index) => {
    const parent = item.parent;
    if (parent === null || parent === undefined) {
      if (root === null) root = nodes[index];
      else nodes[0].children.push(nodes[index]); // extra roots hang off the first
      return;
    }
    if (parent < 0 || parent >= nodes.length || parent === index) {
      throw new Error(
        `Container ${index} ("${item.title}") has parent index ${parent}, which is not a valid earlier entry.`,
      );
    }
    nodes[parent].children.push(nodes[index]);
  });

  if (root === null) throw new Error("No root container: exactly one entry must have parent: null.");
  return root;
}

function renderManifest(manifest: ManifestEntry[]): string {
  if (manifest.length === 0) return "";
  const lines = manifest.map(
    (entry) =>
      `- \`${entry.slug_or_id}\` — ${entry.title}: ${entry.summary}${entry.has_rules ? "" : "  [no cached rules]"}`,
  );
  return [
    "",
    "## Available reference context",
    "Not loaded. Call devvault_search to pull any of these in.",
    ...lines,
  ].join("\n");
}

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(error: unknown) {
  const message =
    error instanceof DevVaultError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function buildServer(client: DevVaultClient, ledger = new Ledger()): McpServer {
  const server = new McpServer({
    name: "devvault",
    version: "0.1.0",
  });

  // ── Bind ───────────────────────────────────────────────────────────────────

  server.registerTool(
    "devvault_context",
    {
      title: "Load coding context from DevVault",
      description:
        "Call this BEFORE writing any code. Returns the user's own rules and conventions for the area you are working in, plus a list of deeper reference material you can pull in on demand. " +
        "Pass `task`: one short sentence describing what you are building (e.g. 'build a Node.js REST API for user auth'). Do NOT paste the user's full prompt — a long query retrieves badly. " +
        "If the user named a collection with @, pass it as `collection` instead; an explicit name always wins over inference. " +
        "Call this again whenever the work shifts to a different area (frontend → backend, say). If it returns nothing, the user has no context saved for this area: say so rather than inventing conventions.",
      inputSchema: {
        task: z
          .string()
          .max(1000)
          .optional()
          .describe("One sentence: what you are building."),
        collection: z
          .string()
          .optional()
          .describe("A collection name the user named explicitly, with or without '@'."),
      },
    },
    async ({ task, collection }) => {
      ledger.nextTurn();
      try {
        if (!task && !collection) {
          return failure("Pass either `task` (one sentence describing what you are building) or `collection`.");
        }

        const parts: string[] = [];
        let manifest: ManifestEntry[] = [];

        if (collection) {
          const payload = await client.context(collection);
          if (payload.resolved_from) {
            parts.push(`> Resolved \`@${payload.resolved_from}\` → \`@${payload.collection}\`.`);
          }
          if (payload.note && !payload.core) return text(payload.note);
          if (payload.core) parts.push(payload.core);
          manifest = payload.manifest;
          if (payload.note) parts.push(`> ${payload.note}`);
          ledger.record(`collection:${payload.collection}`, payload.collection, payload.core_tokens);
        } else {
          const payload = await client.route(task!);
          if (!payload.core && payload.manifest.length === 0) {
            return text(
              payload.note ??
                "No matching context found. Proceed without it, and do not invent conventions.",
            );
          }
          if (payload.core) parts.push(payload.core);
          manifest = payload.manifest;
          if (payload.note) parts.push(`> ${payload.note}`);
          ledger.record(`route:${task}`, "routed core", estimateTokens(payload.core));
        }

        parts.push(renderManifest(manifest));
        return text(parts.filter(Boolean).join("\n\n"));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "devvault_search",
    {
      title: "Search DevVault reference material",
      description:
        "Pull in a specific piece of the user's saved research, chosen from the manifest that devvault_context returned. " +
        "Search with the vocabulary of the thing you are building ('hero image loading', 'websocket reconnect'). " +
        "Anything already delivered this session is reported as such rather than sent twice.",
      inputSchema: {
        query: z.string().min(1).max(1000),
        collection: z
          .string()
          .optional()
          .describe("Restrict to one collection. Omit to search the whole vault."),
        limit: z.number().int().min(1).max(10).default(3),
      },
    },
    async ({ query, collection, limit }) => {
      ledger.nextTurn();
      try {
        const payload = await client.search(collection ?? "all", query, limit);

        if (payload.hits.length === 0) {
          const extra = payload.omitted.length
            ? ` Available collections: ${payload.omitted.map((s) => `@${s}`).join(", ")}.`
            : "";
          return text(`No saved research matched "${query}".${extra}`);
        }

        const sections: string[] = [];
        const skipped: string[] = [];
        const withheld: string[] = [];

        for (const hit of payload.hits) {
          if (ledger.has(hit.container_id)) {
            // Announced, never silent: an empty result reads as "nothing
            // exists" and the agent will act on that.
            skipped.push(`${hit.title} — already loaded earlier this session`);
            continue;
          }
          if (!ledger.fits(hit.tokens)) {
            withheld.push(
              `${hit.title} (~${hit.tokens} tokens) — call devvault_get_container("${hit.container_id}") if you need it`,
            );
            continue;
          }
          ledger.record(hit.container_id, hit.title, hit.tokens);
          const cached = hit.has_rules ? "" : "\n\n_No cached rules for this container — see devvault_write_rules below._";
          sections.push(`## ${hit.title}\n\n${hit.content}${cached}`);
        }

        const footer: string[] = [];
        if (skipped.length) footer.push(`Skipped: ${skipped.join("; ")}.`);
        if (withheld.length) footer.push(`Budget reached, not sent: ${withheld.join("; ")}.`);
        if (payload.omitted.length) footer.push(`Also matched but not sent: ${payload.omitted.join(", ")}.`);
        footer.push(ledger.summary());

        if (sections.length === 0) {
          return text(footer.join(" "));
        }
        return text([...sections, `> ${footer.join(" ")}`].join("\n\n"));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "devvault_get_container",
    {
      title: "Read one DevVault container in full",
      description:
        "Fetch a container's complete content when the rules you were given are not enough. Use the id from a search result or the manifest.",
      inputSchema: {
        container_id: z.string().min(1),
        depth: z
          .number()
          .int()
          .min(0)
          .max(2)
          .default(0)
          .describe("0 links to child containers; 1-2 inlines them."),
      },
    },
    async ({ container_id, depth }) => {
      ledger.nextTurn();
      try {
        const markdown = await client.containerMarkdown(container_id, depth);
        ledger.record(container_id, container_id, estimateTokens(markdown));
        return text(markdown);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "devvault_write_rules",
    {
      title: "Cache a rule extraction back onto a container",
      description:
        "After reading a container whose result said it has no cached rules, distil it and save the result here so no future session has to re-derive it. " +
        "IMPORTANT: extract EVERY actionable rule in the container, not only the ones relevant to what you are building right now — these rules are reused for unrelated tasks, and a narrow extraction is worse than none. " +
        "One imperative rule per line. Drop background and explanation; keep code examples and links. Rules a user wrote by hand are never overwritten.",
      inputSchema: {
        container_id: z.string().min(1),
        rules: z
          .string()
          .min(1)
          .max(20000)
          .describe("One imperative rule per line, task-agnostic."),
      },
    },
    async ({ container_id, rules }) => {
      try {
        const result = await client.writeRules(container_id, rules);
        return text(
          result.updated
            ? `Rules cached for ${container_id}. Future sessions will get these instead of the raw research.`
            : (result.reason ?? "Rules were not updated."),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "devvault_list_collections",
    {
      title: "List the user's DevVault collections",
      description:
        "Show which collections exist, with their descriptions. Useful when the user refers to a collection you cannot resolve, or when deciding where to save research.",
      inputSchema: {},
    },
    async () => {
      try {
        const collections = await client.listCollections();
        if (collections.length === 0) {
          return text("No collections yet. Saving research will create one.");
        }
        return text(
          collections
            .map(
              (c) =>
                `- \`@${c.slug}\` — ${c.name} (${c.member_count} container${c.member_count === 1 ? "" : "s"})${c.description ? `: ${c.description}` : ""}`,
            )
            .join("\n"),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  // ── Capture ────────────────────────────────────────────────────────────────

  server.registerTool(
    "devvault_save_research",
    {
      title: "Save research into DevVault",
      description:
        "File the current conversation's findings into the user's vault as structured containers, so neither of you has to re-derive them next time. " +
        "You decide the structure: group by topic, one topic per container, and nest sub-topics as children. Write real titles. " +
        "Constraints are enforced server-side and anything over them is repaired automatically (long paragraphs split, extra blocks spill into continuation containers, deep nesting is flattened and linked) — the response tells you exactly what was adjusted, so report that to the user. " +
        "Always set external_key on every container: re-running the same research then updates in place instead of duplicating. " +
        "Supplying agent_rules alongside the research is worth doing — it saves a future session from re-reading the prose.",
      inputSchema: {
        containers: z
          .array(flatContainerSchema)
          .min(1)
          .describe(
            "Flat list. The first entry is the root (parent: null); every other entry points at an earlier index.",
          ),
        collection_name: z
          .string()
          .optional()
          .describe("Names the collection this import creates. Defaults to the root title."),
        collection_description: z
          .string()
          .optional()
          .describe(
            "One or two sentences on what this collection covers and when it applies. This is what future task descriptions are matched against, so make it specific.",
          ),
        parent_id: z
          .string()
          .optional()
          .describe("Nest the import under an existing container."),
        mode: z
          .enum(["create", "update"])
          .default("update")
          .describe("'update' reuses containers matching on external_key."),
      },
    },
    async ({ containers, collection_name, collection_description, parent_id, mode }) => {
      try {
        const root = nest(containers as FlatContainer[]);
        const payload = await client.import({
          root,
          parent_id,
          mode,
          collection_name,
          collection_description,
        });

        const lines = [
          `Saved ${payload.containers.length} container(s) and ${payload.blocks_created} block(s) into collection \`@${payload.collection.slug}\`.`,
          "",
          ...payload.containers.map(
            (c) => `${"  ".repeat(Math.max(0, c.depth - 1))}- ${c.title} (${c.block_count} blocks)`,
          ),
        ];

        if (payload.adjustments.length) {
          lines.push("", "Adjusted to fit DevVault's limits:");
          for (const adjustment of payload.adjustments) {
            lines.push(`- ${adjustment.container}: ${adjustment.detail}`);
          }
          lines.push("", "Tell the user about these adjustments.");
        }

        return text(lines.join("\n"));
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
