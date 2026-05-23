---
name: push-code-to-repo
description: Take local code (a directory or file set) and publish it to a cronicle-hosted repo, then turn it into a Mode-A cronicle project. Picks git push (if user has $CRONICLE_PAT) or cronicle_commit_files (MCP-only) automatically.
---

# push-code-to-repo

Goal: end-to-end "I have code, get it scheduled on cronicle" — without
running into the secret/PAT auth gotchas.

## Inputs

- `repo_name` — name for the new cronicle-hosted repo (`[a-z][a-z0-9-]{0,62}$`)
- `local_dir` (optional) — local path with the code + cronicle.hcl. Default: current directory.
- `files` (optional, alternative to local_dir) — `[{path, content}]` for the in-chat composition path.

## Procedure

**Step 1 — confirm the cronicle.hcl shape.**

The repo's `cronicle.hcl` MUST contain a top-level `repo` block matching
the cronicle-hosted URL, e.g.:

```hcl
repo {
  url    = "https://api.triggerflux.dev/<org>/git/<repo>.git"
  branch = "main"
}
```

Without it, future `cronicle_sync_from_repo` calls return
"not managed by a repo". If the user's HCL is missing it, offer to
add it before pushing.

**Step 2 — create the cronicle-hosted repo.**

Call `cronicle_create_repo(name=<repo_name>)`. Note the returned clone
URL (it has `x:$CRONICLE_PAT` placeholder).

**Step 3 — pick a push path based on the user's environment.**

Run a probe to decide:

```bash
# detect git CLI + PAT availability
[ -x "$(command -v git)" ] && echo "GIT_OK"
[ -n "$CRONICLE_PAT" ] && echo "PAT_OK"
[ -d "$LOCAL_DIR/.git" ] || [ -z "$(ls "$LOCAL_DIR" 2>/dev/null)" ] && echo "DIR_OK"
```

Choose:

- **Path A — git push** (preferred when GIT_OK + PAT_OK and the user has local code on disk):
  - Use shell interpolation; never echo `$CRONICLE_PAT`.
  - ```bash
    cd "$LOCAL_DIR"
    git init -b main 2>/dev/null || true
    git add -A
    git -c user.email="cronicle@triggerflux.dev" -c user.name="cronicle" commit -m "$MSG"
    git remote add cronicle "https://x:$CRONICLE_PAT@api.triggerflux.dev/git/$ORG/$REPO_NAME.git" 2>/dev/null || \
      git remote set-url cronicle "https://x:$CRONICLE_PAT@api.triggerflux.dev/git/$ORG/$REPO_NAME.git"
    git push -u cronicle main
    ```
  - Advantages: preserves history, handles binary, leverages user's git config.

- **Path B — `cronicle_commit_files` MCP** (when no git CLI / no PAT / files are composed in-chat):
  - Gather files into `[{path, content}]` shape.
  - Call `cronicle_commit_files(repo=<repo_name>, message=<msg>, files=<list>)`.
  - Advantages: works from mobile, no shell, no PAT in URL.

If both paths are available, default to A unless the user explicitly
prefers B or the files are being composed in-chat (i.e. not on disk).

**Step 4 — init the project.**

Call `cronicle_init_project_from_repo(repo_url=<clone-url>)`. Slug + deployment name derive automatically.

**Step 5 — resolve secrets via the `set-secret` skill.**

For each `$secret.NAME` in the HCL, invoke the `set-secret` skill with
`project_slug=<derived>`, `name=<NAME>`. The skill handles
org-scope-first detection and tells the user what to do.

**Step 6 — verify.**

Call `cronicle_run_schedule_now(project_slug=<derived>, schedule_name=<first>)`.
Then `cronicle_list_runs` ~20s later. Report status.

## Anti-patterns

- ❌ Always using `cronicle_commit_files` even when the user has `git` and `$CRONICLE_PAT` set — robs them of git history features
- ❌ Pushing without first verifying the `repo` block in cronicle.hcl matches the cronicle-hosted URL — leaves the project demoted to Mode-B silently
- ❌ Pushing without ensuring the user has a PAT they can use — error message will be cryptic ("authentication required")
- ❌ Hard-failing on a missing secret — surface the `set-secret` skill flow instead

## Why two push paths

- Desktop user with `git` in shell + PAT exported → git push is the principle-of-least-astonishment choice; it's the workflow they already know.
- Mobile user, or any client without shell access → `cronicle_commit_files` lets the same flow work without leaving chat.

Both reach the same cronicle-git bare repo. The skill keeps Claude from
forcing the wrong one.
