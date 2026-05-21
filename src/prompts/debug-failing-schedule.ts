// Prompt: cronicle:debug-failing-schedule
//
// "My schedule isn't working" is the second most common ask after
// "build me a schedule." Without a skill, Claude tends to guess at
// causes without checking the actual state. This skill makes it
// pull the real run history + HCL first, then diagnose from
// evidence.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const argsSchema = z.object({
  project_slug: z.string().describe("The cronicle project to debug."),
  schedule_name: z
    .string()
    .optional()
    .describe(
      "Specific schedule to focus on. Omit to look at all schedules in the project.",
    ),
});

type Args = z.infer<typeof argsSchema>;

export function register(server: McpServer): void {
  server.registerPrompt(
    "cronicle:debug-failing-schedule",
    {
      title: "Debug a failing cronicle schedule",
      description:
        "Pulls recent runs + the current HCL for a project (or specific schedule) and walks through the most common failure modes. Use for 'why isn't my schedule working' or 'my agent task keeps failing'.",
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
  const scope = args.schedule_name
    ? `schedule "${args.schedule_name}" in project "${args.project_slug}"`
    : `project "${args.project_slug}"`;

  return `Diagnose why ${scope} isn't working. Don't guess — pull real evidence first.

## Step 1: confirm the project exists + check deployment status

Call \`cronicle_list_projects\`. Look for "${args.project_slug}". If status is anything other than "running", that's your answer — the worker pod isn't healthy.

## Step 2: pull recent runs

Call \`cronicle_list_runs\` with project_slug="${args.project_slug}"${
    args.schedule_name ? ` and schedule="${args.schedule_name}"` : ""
  }. Look at:

- **\`status\` field**: "failed" / "skipped" / "succeeded" / "running"
- **\`finished_at - started_at\` duration**: anomalously short (<100ms) suggests early failure in task setup; long durations near \`wallclock\` suggest agent budget exhaustion
- **\`task_count\` vs schedule's expected task count**: mismatch means a task short-circuited

If the runs list is empty, the schedule never fired. That usually means:
- The deployment isn't healthy yet (revisit Step 1)
- The cron expression in the HCL is malformed (check syntax: 5 fields, no quotes inside)
- The schedule is paused (the UI's pause toggle lives in cronicled state.db, not HCL — ask the user if they paused it)

## Step 3: look at the schedule HCL${args.schedule_name ? "" : "s"}

For now, the MCP doesn't have a \`get_schedule\` tool yet, so ask the user to share the relevant HCL from their project URL (\`/<org>/projects/${args.project_slug}/schedules${args.schedule_name ? `/${args.schedule_name}` : ""}\`).

Once you have the HCL, look for these common bugs in priority order:

### A. Missing secrets
Every \`env = ["NAME=$secret.NAME"]\` reference needs a corresponding secret set via \`cronicle_set_secret\`. A missing secret causes "unresolved secret references: NAME" in the shell stderr. Common offenders: \`ANTHROPIC_API_KEY\`, \`SLACK_WEBHOOK_URL\`, anything project-specific.

### B. Wrong scratch path
Tasks share \`\${scratch}\` ONLY within a single run. If a task uses \`/tmp/foo.json\` instead of \`\${scratch}/foo.json\`, the next task can't find it (different working dir or different worker pod).

### C. Missing \`depends\`
Two tasks without \`depends\` run in parallel. If task B reads what task A wrote, B must list A in \`depends = ["a"]\`.

### D. Cron format
cronicle uses standard 5-field cron (\`min hour dom mon dow\`) OR \`@every 30s\` style. Check for:
- Extra fields (6 fields = seconds-leading; cronicle rejects)
- Quotes inside the value
- Timezone in the wrong place (\`timezone\` is a separate field, not embedded in cron)

### E. Agent budget exhausted
If the failing task is an \`agent { }\` block and the run duration matches \`wallclock\` exactly OR the spend equals \`budget_usd\`, the agent timed out / capped out. Either:
- Increase \`max_turns\` / \`wallclock\` / \`budget_usd\`
- Shrink the agent's input (truncate the data.json the upstream task writes)
- Switch to a cheaper model (\`claude-haiku-4-5\`)

### F. Repo block issues (Mode A only)
If the project has a top-level \`repo { url, branch }\` block, the runtime tries to clone the repo before every task. Common failures:
- Private repo without a deploy key: clone returns 404
- Branch typo: \`branch = "master"\` when the default is "main"

### G. Container missing tools
The stock cronicled alpine image has sh + busybox. Anything else (\`python3\`, \`jq\`, \`curl\`) needs to be installed by an \`install_deps\` task. PEP 668 forces \`pip install --user --break-system-packages\` on alpine 3.20+.

## Step 4: report the diagnosis

Tell the user:
1. What you found (specific evidence from the run history or HCL).
2. The smallest change that should fix it.
3. Offer to apply the fix via \`cronicle_add_schedule\` (replacing the broken block) and \`cronicle_set_secret\` (if a secret was missing).

## Don't

- Don't speculate about causes without checking the runs list first.
- Don't recommend modifying the HCL based on what it "should" look like — read the actual HCL the user has.
- Don't tell the user "try again later" — that's the answer of last resort, not first.`;
}
