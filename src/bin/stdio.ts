#!/usr/bin/env node
/**
 * stdio entry point — the local transport.
 *
 * The coding agent spawns this as a subprocess on the user's own machine. The
 * access token is read from this process's environment and travels only between
 * here and the DevVault API; it is never part of a model request.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DevVaultClient } from "../client.js";
import { buildServer } from "../server.js";

const DEFAULT_URL = "https://anshbackend.upyourbusiness.tech";

async function main(): Promise<void> {
  const token = process.env.DEVVAULT_TOKEN;
  if (!token) {
    // stdout is the protocol channel — diagnostics must go to stderr.
    process.stderr.write(
      "devvault-mcp: DEVVAULT_TOKEN is not set.\n" +
        "Create a token in DevVault under Settings → Connected Agents, then add it\n" +
        "to this server's `env` block in your MCP config.\n",
    );
    process.exit(1);
  }

  const client = new DevVaultClient(
    process.env.DEVVAULT_URL ?? DEFAULT_URL,
    token,
  );

  const server = buildServer(client);
  await server.connect(new StdioServerTransport());
  process.stderr.write("devvault-mcp: ready (stdio)\n");
}

main().catch((error) => {
  process.stderr.write(`devvault-mcp: fatal: ${String(error)}\n`);
  process.exit(1);
});
