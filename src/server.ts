#!/usr/bin/env node

// cronicle-mcp — MCP server that lets Claude drive a cronicle backend.
//
// Speaks the Model Context Protocol over stdio (the standard transport
// for locally-installed MCP servers). Claude Desktop, Claude Code, and
// other MCP clients invoke this binary as a subprocess and pipe JSON-RPC
// messages over its stdin/stdout.
//
// Auth substrate today: bearer-token (cronicle_pat_…) via the
// CRONICLE_TOKEN env var. Users generate a token in the cronicle UI's
// Settings → API Tokens page and paste it into their Claude client's
// MCP server config:
//
//   {
//     "mcpServers": {
//       "cronicle": {
//         "command": "npx",
//         "args": ["-y", "cronicle-mcp"],
//         "env": {
//           "CRONICLE_API_URL": "https://cronicle.example",
//           "CRONICLE_TOKEN":   "cronicle_pat_…"
//         }
//       }
//     }
//   }
//
// Future: AuthKit-for-MCP (OAuth 2.1 + Dynamic Client Registration).
// Cronicle-mcp would advertise a .well-known/oauth-protected-resource
// document; Claude would open the user's browser to WorkOS for sign-in
// instead of requiring a copy-pasted PAT. Stdio transport doesn't
// support that flow directly — that path arrives when we add an HTTP+
// SSE transport variant.
//
// Tools are registered in src/tools/<name>.ts and imported below.
// Adding a new tool: write the file, import + register here, that's it.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { register as registerCreateProject } from "./tools/create-project.js";
import { register as registerListProjects } from "./tools/list-projects.js";
import { register as registerAddSchedule } from "./tools/add-schedule.js";
import { register as registerListRuns } from "./tools/list-runs.js";
import { register as registerSyncFromRepo } from "./tools/sync-from-repo.js";
import { register as registerSetSecret } from "./tools/set-secret.js";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "cronicle-mcp",
    version: "0.1.0",
  });

  // Tool registry. Order doesn't matter; each tool publishes its own
  // schema + handler. Listed in roughly the order users encounter
  // them: discovery → create → modify → monitor → ops.
  registerListProjects(server);
  registerCreateProject(server);
  registerAddSchedule(server);
  registerListRuns(server);
  registerSyncFromRepo(server);
  registerSetSecret(server);

  // Stdio transport: stdin/stdout for JSON-RPC, stderr for our own
  // logs. MCP clients ignore anything on stderr — safe debug channel.
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Don't log on the happy path — MCP clients consider any stderr
  // output noise, and the connection itself is the success signal.
}

// Top-level catch — surface fatal errors to stderr so MCP clients
// (which spawn us as a subprocess) can see them in their server logs.
main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[cronicle-mcp] fatal:", err);
  process.exit(1);
});

// Silence the unused-import lint on Server — we keep it as a marker
// for "this is using the lower-level Server API too, in case a tool
// needs raw protocol access." Not used today.
void Server;
