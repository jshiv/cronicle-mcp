// Tool: cronicle_pause_schedule / cronicle_resume_schedule
//
// Runtime control — pause stops the schedule's cron from firing
// without modifying the HCL. State lives in cronicled's state.db,
// not the project HCL, so pause survives a sync_from_repo. Resume is
// the inverse — both are idempotent (re-pausing a paused schedule is
// a no-op).
//
// Why two tools, not one with a state arg: explicit verbs read
// better in LLM tool calls + the api is shaped this way already.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pauseSchedule, resumeSchedule } from "../api.js";

const argsSchema = z.object({
  project_slug: z.string().describe("The cronicle project."),
  schedule_name: z.string().describe("Schedule label to toggle."),
});

type Args = z.infer<typeof argsSchema>;

export function registerPause(server: McpServer): void {
  server.registerTool(
    "cronicle_pause_schedule",
    {
      title: "Pause a schedule",
      description:
        "Stops the schedule from firing on its cron. The HCL is untouched; the runtime ignores the schedule until resumed. Pausing is durable + survives HCL edits. Idempotent.",
      inputSchema: argsSchema.shape,
    },
    async (raw: Args) => {
      try {
        await pauseSchedule(raw.project_slug, raw.schedule_name);
        return {
          content: [
            {
              type: "text" as const,
              text: `Paused "${raw.schedule_name}" in "${raw.project_slug}". The cron won't fire until you resume.`,
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: `Could not pause: ${(e as Error).message}` }] };
      }
    },
  );
}

export function registerResume(server: McpServer): void {
  server.registerTool(
    "cronicle_resume_schedule",
    {
      title: "Resume a paused schedule",
      description:
        "Re-enables a paused schedule. The cron fires on its next tick. Idempotent — resuming an already-active schedule is a no-op.",
      inputSchema: argsSchema.shape,
    },
    async (raw: Args) => {
      try {
        await resumeSchedule(raw.project_slug, raw.schedule_name);
        return {
          content: [
            {
              type: "text" as const,
              text: `Resumed "${raw.schedule_name}" in "${raw.project_slug}". Next cron tick will fire.`,
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: `Could not resume: ${(e as Error).message}` }] };
      }
    },
  );
}
