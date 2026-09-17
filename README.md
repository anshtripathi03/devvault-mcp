# devvault-mcp

The bridge between a user's DevVault and their coding agent.

> **Status: scaffold only.** The tools here depend on endpoints that land in
> Phases 1–3.5 (see [`../CONTEXT-ENGINE.md`](../CONTEXT-ENGINE.md)). This folder
> exists to hold the deployment decision and repo shape until then.
>
> This becomes its own git repo.

---

## Two transports, one codebase

This is the part worth understanding before deploying anything.

An MCP server for a local coding agent is **not** a hosted service — Claude Code
spawns it as a subprocess on the user's own machine and talks to it over stdio.
Deploying *that* to EC2 would produce a process with nothing to talk to.

But the same tool definitions can also be served over HTTP, and that one deploys
exactly like the FastAPI and Django services. So: one codebase, two entry points.

| | **stdio** | **HTTP** |
|---|---|---|
| Runs on | the user's machine, via `npx` | our EC2, alongside FastAPI/Django |
| Distributed by | `npm publish` — `npx` pulls it on first run | Docker image + CI/CD |
| User setup | paste config + token into `.mcp.json` | paste a URL, authorise |
| Token lives | on the user's machine only | server-side (OAuth) |
| Laptop + coding agent | ✅ | ✅ |
| claude.ai web / mobile | ❌ | ✅ |
| Ship order | **first** — no hosting required | second — but **required** for web/mobile |

HTTP is not just nicer onboarding. The *bind* loop is meaningless on a phone —
there is no repo to write into — but *capture* is not: someone researching in
the mobile app should be able to file it into their vault, and only a remote
connector can reach them. (A paste-a-transcript box in the DevVault web app is
the no-MCP path to the same outcome; see `CONTEXT-ENGINE.md` decision 2b.)

```
src/
  tools/        shared tool definitions (transport-agnostic)
  ledger.ts     session dedup + token budget
  client.ts     typed DevVault API client (Bearer dvp_...)
  bin/stdio.ts  entry point: StdioServerTransport
  bin/http.ts   entry point: StreamableHTTPServerTransport
```

## Local configuration (stdio)

```jsonc
{
  "mcpServers": {
    "devvault": {
      "command": "npx",
      "args": ["-y", "@devvault-mcp/server"],
      "env": {
        "DEVVAULT_URL": "https://anshbackend.upyourbusiness.tech",
        "DEVVAULT_TOKEN": "dvp_..."   // Settings -> Connected Agents
      }
    }
  }
}
```

The token never reaches Anthropic. This process runs locally, reads
`DEVVAULT_TOKEN` from its own environment, and calls the DevVault API directly.

## Tools

| Tool | Loop | Backing endpoint | Phase |
|---|---|---|---|
| `devvault_context(task \| @collection)` | bind | `POST /api/v1/context/route` | 3.5 |
| `devvault_search(query)` | bind | `GET /api/v1/context/search` | 3.5 |
| `devvault_get_container(slug, depth)` | bind | `GET /api/v1/containers/{id}/export.md` | done (1a) |
| `devvault_save_research(tree)` | capture | `POST /api/v1/containers/import` | 1 |
| `devvault_append(slug, content)` | capture | `POST /api/v1/containers/import` (mode=append) | 1 |

Tool descriptions are load-bearing: they are what teach the agent to pass a short
task description rather than the user's raw prompt, and to re-call when the task
shifts domain. Treat them as code, not documentation.

## Deployment (HTTP transport)

Mirrors the existing services: GitHub Actions → build and push image → SCP
config → SSH deploy on EC2 → health check. Dockerfile and workflow land with
Phase 4.

## Prerequisites

- A DevVault access token — **Settings → Connected Agents** (Phase 0, shipped).
  Scopes: `containers:read` for the bind loop, `containers:write` for capture.
