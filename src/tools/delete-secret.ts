// Tool: cronicle_delete_secret
//
// Removes a project-scoped secret. Schedules that reference it via
// `$secret.NAME` will start failing on their next run with
// "unresolved secret references: NAME" — the LLM should warn the user
// when there are schedules still referencing the secret.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deleteSecret, CronicleAPIError } from "../api.js";

const inputSchema = z.object({
  project_slug: z.string().describe("The cronicle project."),
  name: z.string().describe("Secret name to delete (UPPER_SNAKE_CASE)."),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_delete_secret",
    {
      title: "Delete a project secret",
      description:
        "Removes a project-scoped secret. Schedules referencing it via `$secret.NAME` will start failing on their next run. Confirm with the user first if any active schedules depend on this secret (use cronicle_get_schedule to check).",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      try {
        await deleteSecret(raw.project_slug, raw.name);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Deleted secret "${raw.name}" from "${raw.project_slug}". ` +
                `Any schedule referencing $secret.${raw.name} will fail until you replace it.`,
            },
          ],
        };
      } catch (e) {
        if (e instanceof CronicleAPIError && e.status === 404) {
          return { isError: true, content: [{ type: "text" as const, text: `Secret "${raw.name}" wasn't set on "${raw.project_slug}".` }] };
        }
        return { isError: true, content: [{ type: "text" as const, text: `Could not delete secret: ${(e as Error).message}` }] };
      }
    },
  );
}
