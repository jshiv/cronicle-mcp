// Tool: cronicle_get_schedule
//
// Read one schedule block as raw HCL + a structured projection. Used
// by the debug-failing-schedule skill, and by any LLM that needs to
// round-trip an edit (read existing → modify → cronicle_add_schedule
// with the new content).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSchedule, CronicleAPIError } from "../api.js";

const inputSchema = z.object({
  project_slug: z.string().describe("The cronicle project the schedule lives in."),
  schedule_name: z.string().describe("The label inside `schedule \"name\" { ... }`."),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_get_schedule",
    {
      title: "Get a schedule's HCL",
      description:
        "Returns one schedule block as raw HCL + the project's current HCL version. Use before cronicle_add_schedule to round-trip an edit — read, modify, put.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      try {
        const s = await getSchedule(raw.project_slug, raw.schedule_name);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Schedule "${s.name}" in project "${s.project_id}" (project HCL at version ${s.version}):\n\n` +
                "```hcl\n" +
                s.hcl +
                "\n```\n\n" +
                `Last updated: ${s.updated_at}`,
            },
          ],
        };
      } catch (e) {
        if (e instanceof CronicleAPIError && e.status === 404) {
          return errorResponse(
            `Schedule "${raw.schedule_name}" not found in project "${raw.project_slug}". Use cronicle_list_projects to find the right project, then check the cronicle UI for valid schedule names.`,
          );
        }
        return errorResponse(`Could not fetch schedule: ${(e as Error).message}`);
      }
    },
  );
}

function errorResponse(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
