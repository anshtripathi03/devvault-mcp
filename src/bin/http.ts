#!/usr/bin/env node
/**
 * HTTP entry point — the remote transport.
 *
 * Deployed alongside the FastAPI and Django services. This is the only
 * transport that reaches claude.ai on the web and on a phone, where there is no
 * local process to spawn: the capture loop matters there even though the bind
 * loop does not.
 *
 * Unlike stdio, the token is not read from the environment — each request
 * carries its own, so one deployment serves every user and no credential is
 * stored here.
 */

import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";

import { DevVaultClient } from "../client.js";
import { Ledger } from "../ledger.js";
import { buildServer } from "../server.js";

const DEFAULT_UPSTREAM = "https://anshbackend.upyourbusiness.tech";
const PORT = Number(process.env.PORT ?? 8080);
const UPSTREAM = process.env.DEVVAULT_URL ?? DEFAULT_UPSTREAM;

/** One transport + ledger per MCP session, so budgets don't leak between users. */
const sessions = new Map<
  string,
  { transport: StreamableHTTPServerTransport; ledger: Ledger }
>();

function bearer(req: Request): string | null {
  const header = req.header("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessions.size, upstream: UPSTREAM });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.header("mcp-session-id");
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (existing) {
    await existing.transport.handleRequest(req, res, req.body);
    return;
  }

  const token = bearer(req);
  if (!token) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Missing bearer token. Create one in DevVault under Settings → Connected Agents.",
      },
      id: null,
    });
    return;
  }

  const ledger = new Ledger();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => {
      sessions.set(id, { transport, ledger });
    },
  });

  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  const server = buildServer(new DevVaultClient(UPSTREAM, token), ledger);
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// The SSE stream and session teardown share the session id.
async function bySession(req: Request, res: Response): Promise<void> {
  const sessionId = req.header("mcp-session-id");
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    res.status(404).send("Unknown or expired session");
    return;
  }
  await session.transport.handleRequest(req, res);
}

app.get("/mcp", bySession);
app.delete("/mcp", bySession);

app.listen(PORT, () => {
  process.stdout.write(
    `devvault-mcp: listening on :${PORT} (http), upstream ${UPSTREAM}\n`,
  );
});
