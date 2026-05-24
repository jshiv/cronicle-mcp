---
name: init-from-cronicle-repo
description: Provision a cronicle Mode-A project from an existing cronicle-hosted repo URL. Handles secret resolution via the org-first policy.
---

# init-from-cronicle-repo

Goal: take a cronicle-hosted repo URL (one the user already pushed to,
or one they were given) and turn it into a running scheduled project.

This is the "I already have the repo, just deploy it" skill. For the
"I have local code, get it onto cronicle" flow, use
`push-code-to-repo` instead — it composes this skill at the end.

## Inputs

- `repo_url` — cronicle-hosted URL, e.g. `https://api.cronicle.dev/git/<org>/<name>.git`
- `branch` (optional) — default `main`

## Procedure

**Step 1 — init.**

Call `cronicle_init_project_from_repo(repo_url=<url>, branch=<branch>)`.

The slug + deployment name derive automatically from the repo URL — you
do NOT pass them. The api will:

1. Fetch `cronicle.hcl` from the bare repo via the cluster-internal
   route (no PAT needed server-side)
2. Validate it (parse + ≥1 schedule + top-level `repo` block matching
   the URL)
3. Create the deployment + persist the HCL

If validation fails, the response carries diagnostics. Most common
issues:

- "HCL has no top-level `repo` block" → add the block, push a new commit, retry
- HCL syntax errors (e.g. `${MS}` interpreted by HCL when meant as bash) → fix and re-push

**Step 1b — HOW THE REPO FILES REACH THE WORKER (read once, never forget):**

The top-level `repo { url = ... }` block is more than metadata for
sync. It makes the schedule "repo-aware" — at first task exec, the
worker auto-clones the repo into its workdir, and the `${path}`
template variable substitutes to that checkout. On subsequent runs the
worker fetches + checks out the latest commit, so a `git push`
propagates to the next run automatically.

Concretely: if the repo has a `digest.py` at the root and the HCL says

    task "run" {
      command = ["python3", "${path}/digest.py"]
    }

then the worker runs `python3 /<checkout>/digest.py` with `digest.py`
already on disk. **This is the canonical pattern. Do NOT base64-embed
scripts in HCL** — that's a workaround Claude sessions reach for when
they don't realize `${path}` exists and the repo is already there.

**Step 2 — read back the HCL.**

Call `cronicle_get_project_hcl(project_slug=<derived>)` to know which
`$secret.NAME` references need resolving. Build the list.

**Step 3 — resolve each secret via `set-secret` skill.**

For each name, invoke the `set-secret` skill. Critically: the skill
will check `cronicle_secret_status` first, which means if an
`ANTHROPIC_API_KEY` is already set at org-scope, no per-project action
is needed. Don't ask the user for values that are already there.

**Step 4 — first run.**

Call `cronicle_run_schedule_now(project_slug=<derived>, schedule_name=<first>)`
to verify. Wait ~20s, then `cronicle_list_runs` and report the status.

If the first run fails with "unresolved secret references", re-run
`cronicle_secret_status` for each referenced name; one is probably
unset somewhere the worker can see.

## Anti-patterns

- ❌ Asking the user for `ANTHROPIC_API_KEY` without first checking
  `cronicle_list_org_secrets` / `cronicle_secret_status` — wastes
  their time when it's already set platform-wide
- ❌ Calling `cronicle_create_project` instead of `init_project_from_repo`
  when the user has a cronicle-hosted URL — bypasses the Mode-A sync
  loop and the user can't `cronicle_sync_from_repo` later
- ❌ Skipping the first-run verification — a successful init doesn't
  mean the first cron tick will succeed; secrets / commands / env
  could still be broken
- ❌ **Base64-embedding scripts in HCL.** The repo is auto-cloned at
  `${path}` on the worker; reference files directly with
  `command = ["python3", "${path}/file.py"]`. Embedding makes the HCL
  unreadable, doubles the source-of-truth, and is unnecessary.
- ❌ Using `${repo}` — that's not a thing. The variable is `${path}`.

## Common follow-ups

After this skill succeeds:

- `cronicle_sync_from_repo(project_slug)` — pull new commits
- `cronicle_stop_project(project_slug)` / `cronicle_start_project(project_slug)` — pause without losing state
- `cronicle_delete_project(project_slug, confirm="delete")` — tear down (HCL row stays for audit)
- `cronicle_delete_repo(name, confirm="delete")` — tear down the repo too (separate confirmation)
