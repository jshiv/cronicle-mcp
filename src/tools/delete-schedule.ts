// Tool: cronicle_delete_schedule
//
// Removes one `schedule "name" { ... }` block from the project HCL.
// Sibling schedules untouched. The api validates the post-delete
// file as a whole so removing the last schedule fails (would create
// an inert project).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deleteSchedule, CronicleAPIError } from "../api.js";

const inputSchema = z.object({
  project_slug: z.string().describe("The cronicle project."),
  schedule_name: z.string().describe("Schedule label to remove."),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_delete_schedule",
    {
      title: "Delete a schedule from a project",
      description:
        "Removes one schedule block from the project's cronicle.hcl. Sibling schedules untouched. Fails (with a clear message) if the schedule isn't found or if deleting it would leave the project with zero schedules.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      try {
        const r = await deleteSchedule(raw.project_slug, raw.schedule_name);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Schedule "${raw.schedule_name}" deleted from "${raw.project_slug}". ` +
                `Project HCL is now at version ${r.version}.`,
            },
          ],
        };
      } catch (e) {
        if (e instanceof CronicleAPIError && e.status === 404) {
          return errorResponse(`Schedule "${raw.schedule_name}" not found in "${raw.project_slug}".`);
        }
        return errorResponse(`Could not delete schedule: ${(e as Error).message}`);
      }
    },
  );
}

function errorResponse(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
