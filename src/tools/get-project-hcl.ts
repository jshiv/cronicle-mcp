// Tool: cronicle_get_project_hcl
//
// Returns the full project cronicle.hcl as raw text. The
// per-schedule path (cronicle_get_schedule) is fine for "show me one
// schedule"; this is for "show me the whole file" — debugging a
// schedule-ordering issue, auditing what's deployed, or copying the
// HCL into a repo for Mode-A conversion.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProjectHCL, CronicleAPIError } from "../api.js";

const inputSchema = z.object({
  project_slug: z.string().describe("The cronicle project."),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_get_project_hcl",
    {
      title: "Get the full cronicle.hcl for a project",
      description:
        "Returns the full project HCL as raw text. Use for 'show me the whole file' or before copying the HCL into a git repo for Mode-A conversion. For one schedule at a time use cronicle_get_schedule.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      try {
        const hcl = await getProjectHCL(raw.project_slug);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `cronicle.hcl for project "${raw.project_slug}":\n\n` +
                "```hcl\n" +
                hcl +
                "\n```",
            },
          ],
        };
      } catch (e) {
        if (e instanceof CronicleAPIError && e.status === 404) {
          return errorResponse(
            `Project "${raw.project_slug}" not found, or has no cronicle.hcl persisted yet. Use cronicle_list_projects to confirm the slug.`,
          );
        }
        return errorResponse(`Could not fetch project HCL: ${(e as Error).message}`);
      }
    },
  );
}

function errorResponse(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
