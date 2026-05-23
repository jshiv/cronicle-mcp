# cronicle skills

Client-side skills that encode the cronicle MCP usage policy: when to
prefer org-scoped secrets, when to use git push vs `cronicle_commit_files`,
how to handle PATs without leaking them.

## Install

These skills run in Claude Code (or any MCP host that supports skill
files). Copy them into your local skills directory:

```bash
mkdir -p ~/.claude/skills/cronicle
cp -r path/to/cronicle-mcp/skills/*.md ~/.claude/skills/cronicle/
```

Once installed, invoke a skill in chat with a slash command, e.g.
`/cronicle:push-code-to-repo` or `/cronicle:set-secret`.

## Why skills + MCP together

MCP exposes **capabilities** (atomic tools the server runs). Skills
encode **policy** (the procedure Claude follows when chaining those
tools with local actions). The split lets us solve problems that
neither side could on its own:

| concern | MCP alone | MCP + skill |
|---|---|---|
| Read $CRONICLE_PAT from env for git push | impossible (server can't see client env) | skill shell-interpolates `$CRONICLE_PAT` into the git command — value never enters Claude's transcript |
| Check org-scope before asking user for a secret value | requires Claude to remember the policy on every call | skill encodes "always `cronicle_secret_status` first" once |
| Multi-step bootstrap (create_repo → push → init → set_secrets → run_now) | five tool calls Claude reasons through each time | one slash command |

## Index

- [`push-code-to-repo.md`](./push-code-to-repo.md) — Local code → cronicle-hosted project, Mode-A
- [`set-secret.md`](./set-secret.md) — Secret-resolution policy (org-scope → UI → tool-arg)
- [`init-from-cronicle-repo.md`](./init-from-cronicle-repo.md) — Bootstrap a project from an existing cronicle-hosted repo

## PAT location convention

Skills look for the cronicle PAT in this order:

1. `$CRONICLE_PAT` shell env var (canonical)
2. The `Authorization: Bearer cronicle_pat_...` header in `~/.claude.json` (where Claude Code stashes it for MCP transport)

When using the PAT for git push, skills always use shell interpolation
(e.g. `git push https://x:$CRONICLE_PAT@...`) so the value is resolved
at exec time. The variable name appears in the conversation; the value
does not.
