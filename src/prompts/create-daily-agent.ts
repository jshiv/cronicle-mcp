// Prompt: cronicle:create-daily-agent
//
// "I want a cron job that does X every day and sends me the result"
// is the dominant use case. Without a skill, Claude composes the HCL
// from scratch every time and often forgets cronicle-specific
// conventions ($scratch, depends, agent block fields, secret refs).
// This skill bundles those conventions plus a known-good 3-task
// pattern (fetch → agent summarize → deliver) and tells Claude
// exactly which tools to call.
//
// User invokes via:  /cronicle:create-daily-agent
// Claude prompts for the three blanks (source, focus, delivery), then
// composes the HCL + calls cronicle_create_project.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const argsSchema = z.object({
  source: z
    .string()
    .describe(
      "What data to fetch. e.g. 'last 24h of posts from r/Rivian', 'yesterday's PR titles from a GitHub repo', 'overnight Sentry errors'.",
    ),
  focus: z
    .string()
    .describe(
      "What the agent should report on. e.g. 'top discussions and any bug reports about the voice assistant', 'breaking changes worth flagging', 'error spikes by service'.",
    ),
  delivery: z
    .string()
    .describe(
      "Where to send the report. e.g. 'Slack webhook URL stored as SLACK_WEBHOOK_URL', 'my email via Resend', 'append to a Notion doc'.",
    ),
  time: z
    .string()
    .optional()
    .describe("When to fire. Defaults to '0 9 * * * America/Los_Angeles' (9am Pacific daily). Accepts any cron expression."),
});

type Args = z.infer<typeof argsSchema>;

export function register(server: McpServer): void {
  server.registerPrompt(
    "cronicle:create-daily-agent",
    {
      title: "Build a daily agent (fetch → summarise → deliver)",
      description:
        "Compose a cronicle.hcl for a 3-task daily pipeline: fetch some data, have Claude summarise it with a focus, deliver the result. Use for 'I want a cron job that ___ every day' requests.",
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
  const cron = args.time ?? "0 9 * * *";
  return `Build a cronicle project that does the following on the schedule \`${cron}\` (America/Los_Angeles unless the cron expression overrides):

1. **Fetch**: ${args.source}
2. **Summarise**: ${args.focus}
3. **Deliver**: ${args.delivery}

## Compose the cronicle.hcl

Use this 4-task DAG (skip task 1 if no Python deps needed):

\`\`\`hcl
schedule "<descriptive_name>" {
  cron     = "${cron}"
  timezone = "America/Los_Angeles"

  // OPTIONAL: top-level repo block if the user wants Mode-A
  // (repo-managed) workflow. Skip otherwise.

  task "install_deps" {
    command = ["sh", "scripts/setup.sh"]
  }

  task "fetch" {
    depends = ["install_deps"]
    command = ["python3", "scripts/fetch.py", "\${scratch}/data.json"]
  }

  task "summarise" {
    depends = ["fetch"]
    env     = ["ANTHROPIC_API_KEY=$secret.ANTHROPIC_API_KEY"]
    agent {
      model      = "claude-haiku-4-5"
      prompt     = <<-EOT
        Today is \${date}. Read \${scratch}/data.json — it contains
        <describe what data.json holds>.

        Write a concise report to \${scratch}/report.md with these
        sections:

        ## Headline
        One sentence on the most important thing.

        ## <Topic-specific section>
        ${args.focus}

        ## Sentiment / Notable
        One sentence wrap-up.

        Keep under 400 words. Use text_editor to write the file.
        Reply: REPORT WRITTEN.
      EOT
      tools      = ["text_editor", "bash"]
      max_turns  = 10
      wallclock  = "3m"
      budget_usd = 0.20
    }
  }

  task "deliver" {
    depends = ["summarise"]
    env     = [<secret refs for the delivery target>]
    command = [<delivery command — typically curl to a webhook>]
  }
}
\`\`\`

## Cronicle-specific conventions you MUST follow

- **\`\${scratch}\`** is a per-run scratch dir; tasks share it via \`depends\`. Use it for any inter-task file handoff.
- **\`\${date}\`** is the current date as YYYY-MM-DD, substituted at task-start time. Use in agent prompts.
- **\`$secret.NAME\`** is how secrets get injected into env. Set them via the \`cronicle_set_secret\` tool BEFORE the first run (otherwise the schedule fires and immediately fails).
- **\`depends = [...]\`** is the only way to order tasks. No implicit ordering.
- The \`agent\` block belongs INSIDE a task. \`prompt\` is a here-doc; keep under ~500 lines.
- For the \`deliver\` step, common shapes:
  - Slack webhook: \`["sh", "-c", "curl -fsSL -X POST -H 'Content-Type: application/json' -d \\"{\\\\\\"text\\\\\\": $(jq -Rs . < \${scratch}/report.md)}\\" \\"$SLACK_WEBHOOK_URL\\""]\`
  - Email via Resend: \`["sh", "scripts/email.sh"]\` with the script reading the report + posting to Resend's API.

## What to do next

1. Pick a descriptive \`schedule "name"\` (snake_case, used in the URL).
2. Decide a project slug (kebab-case URL-safe).
3. Compose the HCL above with the user's specifics.
4. Call \`cronicle_create_project\` with the project slug + composed HCL.
5. For every \`$secret.NAME\` referenced in env, call \`cronicle_set_secret\` to set its value. **Confirm with the user before pasting any secret value into the tool call** — they may need to fetch it from their password manager. After setting, never echo the secret value back.
6. After the project is created, call \`cronicle_list_runs\` once with the schedule name to confirm the worker is healthy (status: "succeeded" or "skipped" on the first heartbeat tick).
7. Tell the user the project URL + when the next run will fire.

## Anti-patterns to avoid

- Don't put the agent's \`prompt\` outside the \`agent { }\` block.
- Don't reference \`\${scratch}\` in the cron field — only in task commands + agent prompts.
- Don't use \`pip install\` in a task command directly — use \`scripts/setup.sh\` for idempotency and PEP 668 compatibility on alpine.
- Don't bake secrets into the HCL — always use \`$secret.NAME\`.`;
}
