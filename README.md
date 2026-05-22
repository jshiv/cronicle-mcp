# cronicle-mcp

> ⚠️ **Superseded.** The hosted MCP server is now folded into the
> cronicle api itself (Go, in
> [`cronicle-infra/internal/mcp`](https://github.com/jshiv/cronicle-infra/tree/main/internal/mcp)),
> mounted at `https://api.triggerflux.dev/mcp`. The Go implementation
> has the same 16 tools + 3 prompts as the TypeScript surface here,
> plus full WorkOS OAuth (no PAT copy-paste required).
>
> Configure your MCP client with just the URL — no install step:
>
> ```bash
> claude mcp add cronicle --transport http https://api.triggerflux.dev/mcp
> ```
>
> On first tool call Claude opens a browser to WorkOS, you sign in,
> the JWT is bound to your Claude install. Done.
>
> This repository is kept as the **spec / reference** for the tool
> schemas + prompt templates. New work happens in the Go impl. Don't
> npm install this package — it talks to a paired backend route shape
> that the Go impl has diverged from.

---

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

### Discovery
| tool | what it does |
|---|---|
| `cronicle_list_projects` | Lists projects grouped by org. First call before any modifying op. |
| `cronicle_get_project_hcl` | Returns the full cronicle.hcl for a project as raw text. |
| `cronicle_list_runs` | Recent runs for a project (or one schedule) — status, duration, task count. |
| `cronicle_list_secrets` | Names + versions of project secrets. Plaintext never returned. |
| `cronicle_get_schedule` | One schedule's HCL + project version. Round-trip-edit prerequisite. |

### Create / modify
| tool | what it does |
|---|---|
| `cronicle_create_project` | Provisions a project from an inline HCL string. With rollback on partial failure. |
| `cronicle_init_project_from_repo` | One-call Mode-A bootstrap — fetches cronicle.hcl from a repo, creates the project. |
| `cronicle_add_schedule` | Upsert one `schedule { }` block via the api's HCL splicer. |
| `cronicle_delete_schedule` | Remove one schedule from a project. |
| `cronicle_set_secret` | Create/update a project-scoped secret. Plaintext never echoed back. |
| `cronicle_delete_secret` | Remove a secret. Warns about active schedules referencing it. |

### Runtime control
| tool | what it does |
|---|---|
| `cronicle_pause_schedule` | Stop the cron from firing without modifying the HCL. |
| `cronicle_resume_schedule` | Reverse of pause. |
| `cronicle_run_schedule_now` | One-off manual trigger, bypassing the cron. |

### Ops
| tool | what it does |
|---|---|
| `cronicle_sync_from_repo` | Mode-A re-sync from the project's declared repo. |
| `cronicle_delete_project` | DESTRUCTIVE. Removes the worker deployment. Gated by `confirm:"delete"`. |

## Prompts (skills)

User-invokable templates that orient Claude toward a specific task. Type `/cronicle:` in your MCP client to see them.

| prompt | what it does |
|---|---|
| `cronicle:create-daily-agent` | Compose a 3-task daily pipeline (fetch → agent summarise → deliver). Bakes in cronicle conventions (`$scratch`, `$secret.NAME`, `depends`, agent block fields). |
| `cronicle:debug-failing-schedule` | Pull recent runs + HCL for a project, walk through the most common failure modes (missing secrets, wrong scratch path, cron syntax, agent budget exhausted, etc.). |
| `cronicle:init-from-repo` | Bootstrap a Mode-A project from a git repo. Verifies the top-level `repo` block, walks through secret setup, confirms first-run health. |

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
