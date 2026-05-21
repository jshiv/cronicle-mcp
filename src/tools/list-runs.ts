// Tool: cronicle_list_runs
//
// "Did my schedule actually fire? Did it succeed?" This is the
// monitoring half of the conversational flow — the user asks Claude
// from their phone to check on their cron job and Claude has to be
// able to answer with real data.
//
// Data comes from the project's cronicled runtime via the api's
// deployment proxy. We don't expose the raw proxy URL — the tool
// finds the project's deployment id automatically so the LLM never
// has to think about it.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listRuns, type RunSummary } from "../api.js";

const inputSchema = z.object({
  project_slug: z.string().describe("The project whose runs you want to see."),
  schedule: z
    .string()
    .optional()
    .describe("Optional: filter to one schedule's runs. Omit for all schedules."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max runs to return. Defaults to the listener's default (20-ish)."),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_list_runs",
    {
      title: "List recent runs for a cronicle project",
      description:
        "Lists recent runs (executions) of the project's schedules — status, start/finish times, duration, task count. Use this after creating a schedule to confirm it's actually firing, or to debug a failing cron.\n\nReturns an empty list when the project has no deployment yet (still being provisioned).",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      const runs = await listRuns(raw.project_slug, raw.schedule, raw.limit);
      if (runs.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No runs found for project "${raw.project_slug}"` +
                (raw.schedule ? ` schedule "${raw.schedule}"` : "") +
                ".\n\nIf the project was just created, the worker pod may still be coming up — try again in 30s.",
            },
          ],
        };
      }
      const lines: string[] = [`Found ${runs.length} run${runs.length === 1 ? "" : "s"}:\n`];
      for (const r of runs) {
        lines.push(formatRun(r));
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}

function formatRun(r: RunSummary): string {
  const parts: string[] = [];
  parts.push(`• ${r.schedule} — ${r.status}`);
  if (r.started_at) parts.push(`    started:  ${r.started_at}`);
  if (r.finished_at) parts.push(`    finished: ${r.finished_at}`);
  if (typeof r.duration_ms === "number") {
    parts.push(`    duration: ${formatDuration(r.duration_ms)}`);
  }
  if (typeof r.task_count === "number") {
    parts.push(`    tasks:    ${r.task_count}`);
  }
  parts.push(`    run_id:   ${r.run_id}`);
  return parts.join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${(s / 60).toFixed(1)}m`;
}
