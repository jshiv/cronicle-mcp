---
name: set-secret
description: Resolve and (if needed) set a cronicle project secret. Enforces the org-scope-first / UI-second / tool-arg-last policy so secret values don't accidentally land in conversation context.
---

# set-secret

Goal: ensure a `$secret.NAME` reference in a project's HCL will resolve
at runtime, without leaking the value into conversation/transcript.

## Inputs

- `project_slug` — the cronicle project
- `name` — UPPER_SNAKE_CASE secret name (the bit after `$secret.`)
- `value_source` (optional) — `env:NAME` to read from an env var, `prompt` to ask the user

## Procedure

**Step 1 — check where it already resolves.**

Call `cronicle_secret_status(project_slug=<slug>, name=<name>)`. One of:

- `scope=org_scope` → done. The secret propagates to this project. No action needed. Confirm to the user that it's already wired.
- `scope=project_scope` → done. The secret is already set on the project. Ask the user if they want to rotate. If not, exit.
- `scope=unset` → continue to step 2.

**Step 2 — pick the right channel based on the secret's nature.**

Classify the secret:

| nature | example | preferred channel |
|---|---|---|
| Vendor API key, reused across projects | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | org-scope via UI |
| Delivery destination tied to user | `NTFY_URL` | org-scope if user wants it shared; project-scope UI otherwise |
| One-off project credential | `MYSQL_URL` for one project | project-scope via UI |
| Read from caller's local env | `$CRONICLE_PAT`, `$ANTHROPIC_API_KEY` | **only if user explicitly authorizes** |

**Step 3a — UI path (preferred for new values).**

Tell the user the URL and pause. Examples:

- org-scope: `https://triggerflux.dev/<org>/secrets`
- project-scope: `https://triggerflux.dev/<org>/projects/<slug>/secrets`

Wait for confirmation, then re-run `cronicle_secret_status` to verify.

**Step 3b — tool-arg path (only with explicit consent).**

If the user says "go ahead, use my local env" AND the value source is
an env var:

1. Confirm with one final check: "I'm about to read `$NAME` from your shell env and pass it to `cronicle_set_secret`. The value will appear in this conversation's tool-call args (encrypted at rest on the api side, but visible in the chat transcript). Proceed?"
2. On explicit yes, read the env var via a bash command that does **NOT** echo it:
   ```bash
   # ✗ never: echo "$NAME" — value lands in transcript
   # ✓ ok: pipe into a tool call directly without intermediate echo
   ```
   The clean shape: structure your tool call so the value flows directly into the `value` arg without being printed first.
3. Call `cronicle_set_secret(project_slug, name, value)`.
4. Confirm by name + version only. Never echo the value back.

**Step 4 — verify.**

After any write, call `cronicle_secret_status` once more and confirm the
expected scope. Then confirm to the user: "set `NAME` (v1) on
<project|org>".

## Anti-patterns

- ❌ `cronicle_set_secret` without first checking `cronicle_secret_status` — risks overwriting an org-scope value with a project-scope one (silently breaks org-wide rotation)
- ❌ Echoing `$NAME` to stdout before calling `cronicle_set_secret` — value lands in transcript and conversation logs
- ❌ Curling the api with the value in the body — bypasses the MCP boundary the user has explicitly asked you to use
- ❌ Asking the user to "paste the value here" — they can paste it into the UI form, which is safer

## Why this policy

- Org-scope avoids per-project copy-pasting and gives one rotation point
- The UI lets browser autofill / password managers contribute the value, so the user never types it
- Tool-arg path is the escape hatch when nothing else works — but it's loud (in transcript) so it's the last resort
