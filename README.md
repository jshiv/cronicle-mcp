# cronicle-mcp

MCP server for [Cronicle](https://github.com/jshiv/cronicle) — lets Claude
create projects, schedule agent jobs, and monitor runs on your behalf.

Pairs with the cronicle backend (cronicle-infra) and authenticates via
personal access tokens (PATs) generated in the cronicle web UI.

## Install

```bash
npm install -g cronicle-mcp
```

Or invoke via `npx` directly from your MCP client config (no install
step — npx fetches it on first launch).

## Configure your MCP client

### Claude Desktop / Claude Code

Add to your MCP config (see [`examples/claude-desktop-config.json`](./examples/claude-desktop-config.json)):

```json
{
  "mcpServers": {
    "cronicle": {
      "command": "npx",
      "args": ["-y", "cronicle-mcp"],
      "env": {
        "CRONICLE_API_URL": "https://your-cronicle-api.example",
        "CRONICLE_TOKEN":   "cronicle_pat_..."
      }
    }
  }
}
```

| env var | required | meaning |
|---|---|---|
| `CRONICLE_API_URL` | yes | Base URL of your cronicle backend (no trailing slash). |
| `CRONICLE_TOKEN` | yes | Personal access token. Generate in cronicle UI → Account → API tokens. |
| `CRONICLE_DEFAULT_ORG` | no | Default org slug for tools that take an `org` param. Falls back to `personal`. |
| `CRONICLE_WEB_URL` | no | Public web URL used to build clickable project links in tool responses. Defaults to `CRONICLE_API_URL`. |

## Tools

| tool | what it does |
|---|---|
| `cronicle_create_project` | Provisions a new cronicle project — creates the worker deployment and seeds the cronicle.hcl. Pair with the LLM composing an HCL block to go from intent (*"a daily Reddit summary"*) to running pipeline in one tool call. |

More tools coming: `cronicle_add_schedule`, `cronicle_list_runs`,
`cronicle_sync_from_repo`, `cronicle_set_secret`.

## Develop locally

```bash
npm install
npm run build
node dist/server.js   # boots; awaiting JSON-RPC on stdin
```

To smoke-test against a local cronicle backend (e.g. on `kind`):

```bash
# In one terminal — port-forward to your kind api
kubectl -n cronicle-platform port-forward svc/cronicle-api 8080:8080

# In another — point the MCP server at it + run
CRONICLE_API_URL=http://localhost:8080 \
CRONICLE_TOKEN=cronicle_pat_... \
  node dist/server.js
```

## Roadmap

- ✅ stdio transport + PAT auth (this release)
- ⏭ HTTP+SSE transport + AuthKit-for-MCP (OAuth 2.1 + DCR via WorkOS)
- ⏭ Remaining tools (`add_schedule`, `list_runs`, `sync_from_repo`, `set_secret`)
- ⏭ Skills bundled alongside tools for the *"build me a cronicle agent"* prompt patterns

## License

MIT
