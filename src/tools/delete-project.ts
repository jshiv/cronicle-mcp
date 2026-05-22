// Tool: cronicle_delete_project
//
// Removes the project's deployment (worker pod + record). The
// stored cronicle.hcl row is left behind; recreating with the same
// slug rebinds to the old config. To fully wipe a project (incl.
// HCL + secrets), delete via the UI today — a single
// "delete-project-and-config" api endpoint is a TODO.
//
// The LLM should confirm with the user before calling this. Destructive.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deleteProject } from "../api.js";

const inputSchema = z.object({
  project_slug: z.string().describe("The cronicle project to delete."),
  confirm: z
    .literal("delete")
    .describe(
      "Pass the literal string \"delete\" to confirm. Belt-and-suspenders against accidental destructive calls.",
    ),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_delete_project",
    {
      title: "Delete a cronicle project",
      description:
        "DESTRUCTIVE. Removes the project's worker deployment. Active schedules stop running. The stored cronicle.hcl row remains (recreating the project with the same slug reuses it); a future endpoint will wipe both. Confirm with the user before calling.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      try {
        await deleteProject(raw.project_slug);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Deleted project "${raw.project_slug}". The worker is gone; active schedules stopped. ` +
                `Note: the stored cronicle.hcl is preserved for audit — recreating the project with the ` +
                `same slug will rebind to it. To fully wipe, delete via the cronicle UI.`,
            },
          ],
        };
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: `Could not delete project: ${(e as Error).message}` }] };
      }
    },
  );
}
