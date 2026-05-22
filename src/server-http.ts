#!/usr/bin/env node

// cronicle-mcp HTTP transport variant.
//
// Same MCP tools + prompts as src/server.ts, but exposed over HTTP+SSE
// instead of stdio so it can run as a hosted service and use OAuth
// (WorkOS AuthKit-for-MCP). MCP clients (Claude Desktop, Claude Code,
// etc.) discover the auth requirements via the standard
// /.well-known/oauth-protected-resource document, then complete the
// OAuth flow with WorkOS before invoking tools.
//
// Why a separate file (not a runtime --transport flag): stdio and HTTP
// have different lifecycle + dependency profiles. stdio is single-
// process, exits when stdin closes; HTTP needs an Express server +
// session management + JWT verification middleware. Keeping them
// distinct binaries makes container manifests cleaner — the hosted
// version ships only the HTTP variant; npm-installed local users get
// stdio.
//
// Architecture:
//
//   POST /mcp   ←  MCP requests from clients (after they've OAuth'd)
//                  Bearer token in Authorization header verified
//                  against WorkOS JWKS before forwarding to the
//                  StreamableHTTPServerTransport handler.
//
//   GET  /.well-known/oauth-protected-resource
//                ←  Resource server metadata. Tells the client where
//                   to find the authorization server (WorkOS) + which
//                   scopes are supported. Served by the SDK's
//                   mcpAuthMetadataRouter.
//
//   GET  /healthz  ←  Liveness probe. Bare 200.
//
// Env contract:
//
//   PORT                   bind port (default 8080)
//   WORKOS_ISSUER_URL      e.g. https://api.workos.com/user_management/<client_id>
//                          OR https://auth.workos.com (varies by setup).
//                          This is the OAuth `iss` claim Claude expects to verify.
//   WORKOS_JWKS_URL        e.g. https://api.workos.com/sso/jwks/<client_id>
//                          The JWKS endpoint we verify access tokens against.
//                          Cached in-process for 24h.
//   CRONICLE_API_URL       same as stdio server — base URL of the api.
//   CRONICLE_PUBLIC_URL    public origin of THIS server (e.g.
//                          https://mcp.triggerflux.dev). Used in the
//                          .well-known doc as the resource id.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { register as registerCreateProject } from "./tools/create-project.js";
import { register as registerListProjects } from "./tools/list-projects.js";
import { register as registerAddSchedule } from "./tools/add-schedule.js";
import { register as registerListRuns } from "./tools/list-runs.js";
import { register as registerSyncFromRepo } from "./tools/sync-from-repo.js";
import { register as registerSetSecret } from "./tools/set-secret.js";
import { register as registerGetSchedule } from "./tools/get-schedule.js";
import { register as registerDeleteSchedule } from "./tools/delete-schedule.js";
import { registerPause, registerResume } from "./tools/pause-schedule.js";
import { register as registerRunNow } from "./tools/run-schedule-now.js";
import { register as registerListSecrets } from "./tools/list-secrets.js";
import { register as registerDeleteSecret } from "./tools/delete-secret.js";
import { register as registerDeleteProject } from "./tools/delete-project.js";
import { register as registerInitFromRepoTool } from "./tools/init-project-from-repo.js";
import { register as registerGetProjectHCL } from "./tools/get-project-hcl.js";
import { register as registerCreateDailyAgent } from "./prompts/create-daily-agent.js";
import { register as registerDebugFailingSchedule } from "./prompts/debug-failing-schedule.js";
import { register as registerInitFromRepo } from "./prompts/init-from-repo.js";
import { jwtVerifyMiddleware } from "./auth.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const PUBLIC_URL = process.env.CRONICLE_PUBLIC_URL ?? `http://localhost:${PORT}`;
const ISSUER_URL = process.env.WORKOS_ISSUER_URL;
const JWKS_URL = process.env.WORKOS_JWKS_URL;

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "cronicle-mcp",
    version: "0.1.0",
  });
  registerListProjects(server);
  registerGetProjectHCL(server);
  registerCreateProject(server);
  registerInitFromRepoTool(server);
  registerAddSchedule(server);
  registerGetSchedule(server);
  registerDeleteSchedule(server);
  registerPause(server);
  registerResume(server);
  registerRunNow(server);
  registerListRuns(server);
  registerSyncFromRepo(server);
  registerListSecrets(server);
  registerSetSecret(server);
  registerDeleteSecret(server);
  registerDeleteProject(server);
  registerCreateDailyAgent(server);
  registerDebugFailingSchedule(server);
  registerInitFromRepo(server);
  return server;
}

async function main(): Promise<void> {
  if (!ISSUER_URL || !JWKS_URL) {
    // eslint-disable-next-line no-console
    console.error(
      "[cronicle-mcp-http] FATAL: WORKOS_ISSUER_URL + WORKOS_JWKS_URL must be set. " +
        "See README for WorkOS configuration steps.",
    );
    process.exit(1);
  }

  const app = express();
  app.use(express.json());

  // Health probe — bare 200, no auth.
  app.get("/healthz", (_req, res) => res.status(200).send("ok"));

  // OAuth resource server metadata. The MCP client fetches this on
  // first request (or on a 401), learns the WorkOS authorization
  // server URL, kicks off the OAuth flow, then comes back with a
  // bearer token. We're the resource server; WorkOS is the AS.
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: {
        issuer: ISSUER_URL,
        authorization_endpoint: `${ISSUER_URL}/authorize`,
        token_endpoint: `${ISSUER_URL}/token`,
        registration_endpoint: `${ISSUER_URL}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      },
      resourceServerUrl: new URL(PUBLIC_URL),
      scopesSupported: ["cronicle:read", "cronicle:write"],
      resourceName: "cronicle",
    }),
  );

  // /mcp is the protocol endpoint. Bearer token required (verified
  // against WorkOS JWKS by jwtVerifyMiddleware). On 401, the client
  // discovers /.well-known and starts the OAuth flow.
  app.post("/mcp", jwtVerifyMiddleware(JWKS_URL, ISSUER_URL), async (req, res) => {
    // Each request gets its own short-lived transport + server pair —
    // simple stateful-per-request model. Stateful sessions can be
    // added later by keying the transport on the MCP session id
    // header. For now this works for any non-streaming workflow.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const server = buildMcpServer();
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, req.body);
    } finally {
      // Close transport after the request completes. For long-lived
      // SSE streams we'd hold this open; today's tools are short-
      // request/response so this is fine.
      transport.close();
    }
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[cronicle-mcp-http] listening on :${PORT}, public ${PUBLIC_URL}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[cronicle-mcp-http] fatal:", err);
  process.exit(1);
});
