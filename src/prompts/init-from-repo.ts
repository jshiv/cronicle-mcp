// Prompt: cronicle:init-from-repo
//
// "Take this repo and turn it into a cronicle project." The repo
// already has a cronicle.hcl + scripts; we want a one-call shortcut
// that uses Mode-A sync going forward.
//
// Surfaces the top-level-repo-block precondition explicitly so the
// LLM doesn't have to learn it from a 400.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const argsSchema = z.object({
  repo_url: z
    .string()
    .describe(
      "GitHub repo URL. https://github.com/owner/repo or git@github.com:owner/repo.git both work. Must be public for now.",
    ),
  branch: z.string().optional().describe("Branch to track. Defaults to 'main'."),
  project_slug: z
    .string()
    .optional()
    .describe(
      "URL-safe project slug. Defaults to the repo name (e.g. 'rivian-reddit-monitor').",
    ),
});

type Args = z.infer<typeof argsSchema>;

export function register(server: McpServer): void {
  server.registerPrompt(
    "cronicle:init-from-repo",
    {
      title: "Initialize a cronicle project from a git repo (Mode A)",
      description:
        "Provision a new cronicle project whose cronicle.hcl lives in a git repo. Subsequent edits to the repo's cronicle.hcl are pulled by `cronicle_sync_from_repo`. Use for 'set up a cronicle project from this repo' requests.",
      argsSchema: argsSchema.shape,
    },
    (args: Args) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: buildPrompt(args),
          },
        },
      ],
    }),
  );
}

function buildPrompt(args: Args): string {
  const branch = args.branch ?? "main";
  return `Set up a cronicle project that's managed by the repo at ${args.repo_url} on branch \`${branch}\`. The repo should already have a \`cronicle.hcl\` at its root.

## Mode-A precondition

For repo-managed sync to work, the repo's \`cronicle.hcl\` MUST have a top-level \`repo\` block:

\`\`\`hcl
repo {
  url    = "${args.repo_url}"
  branch = "${branch}"
}

schedule "..." { ... }
\`\`\`

Without that block, the project initialises but can't be re-synced. The api will refuse the fetch with a clear error message telling the user to add the block.

## Steps

1. **Fetch the repo's cronicle.hcl manually first** so you can show the user what's about to be created. Use the GitHub raw URL: \`https://raw.githubusercontent.com/<owner>/<repo>/${branch}/cronicle.hcl\`. If you can't fetch it from this environment, describe what you'd verify and ask the user to paste the file contents.

2. **Verify the top-level repo block** is present. If not, tell the user to add it and push, then retry.

3. **Pick the project slug**: default to the repo name (kebab-case). Ask the user to confirm or override.

4. **Call \`cronicle_create_project\`** with:
   - \`project_slug\`: the chosen slug
   - \`deployment_name\`: same as project_slug (unless the user wants a different display name)
   - \`cronicle_hcl\`: the fetched + validated HCL
   - \`org\`: omit (defaults to user's default org)

5. **Set required secrets**: scan the HCL for every \`$secret.NAME\` reference. For each, call \`cronicle_set_secret\` ONLY AFTER asking the user for the value. **Never paste a secret value into your output text** — confirm by name + version only.

6. **Confirm first run health**: wait ~30s for the worker pod to provision, then call \`cronicle_list_runs\` to verify the schedule starts firing on its cron.

## Sync workflow going forward

Whenever the user pushes a change to the repo's \`cronicle.hcl\`:
- Call \`cronicle_sync_from_repo\` with the project_slug
- Returns either \`synced\` (version bump) or \`already_in_sync\` (no change)
- Schedules update within ~1s via cronicled's config reload

## Edge cases

- Private repos: not supported yet — tell the user to make it public, or wait for the deploy-key feature.
- Repo without \`cronicle.hcl\` at root: ask the user where it lives; the create endpoint accepts a custom path arg via the api, but the MCP tool doesn't expose it yet.
- Existing project with the same slug: the create endpoint will fail. Either pick a different slug or guide the user to sync into the existing project via \`cronicle_sync_from_repo\` instead.`;
}
