// Tool: cronicle_run_schedule_now
//
// One-off trigger. Queues an immediate run of the schedule, ignoring
// the cron. Returns immediately — the run itself happens
// asynchronously; pair with cronicle_list_runs to monitor.
//
// Most common after editing a schedule or setting a missing secret —
// "let's see if it works now."

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { triggerSchedule } from "../api.js";

const inputSchema = z.object({
  project_slug: z.string().describe("The cronicle project."),
  schedule_name: z.string().describe("Schedule to trigger now."),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_run_schedule_now",
    {
      title: "Manually trigger a schedule run",
      description:
        "Queues a one-off run of the schedule, bypassing the cron. Use to test a freshly-edited schedule or to re-run after fixing a missing secret. Returns immediately; call cronicle_list_runs ~5–30s later to see the result.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      try {
        await triggerSchedule(raw.project_slug, raw.schedule_name);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Queued a manual run of "${raw.schedule_name}" in "${raw.project_slug}". ` +
                `Call cronicle_list_runs in 5–30 seconds to see the outcome.`,
            },
          ],
        };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Could not trigger run: ${(e as Error).message}` }],
        };
      }
    },
  );
}
