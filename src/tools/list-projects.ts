// Tool: cronicle_list_projects
//
// Discovery — "what does the user already have?" Without this, the LLM
// can't answer questions like "show me my projects" or "which project
// is the daily-brief schedule under." The grouping logic mirrors the
// cronicle-web /[org]/projects page (deployments → projects by slug).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listDeployments, type Deployment } from "../api.js";

const inputSchema = z.object({
  org: z
    .string()
    .optional()
    .describe(
      "Filter to one org. Omit to list across all orgs visible to the token.",
    ),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_list_projects",
    {
      title: "List cronicle projects",
      description:
        "Lists all cronicle projects the caller can see, grouped by org. For each project: name, deployment status, last-seen timestamp.\n\nUse before cronicle_add_schedule, cronicle_set_secret, etc. so you have a valid project_slug. The cronicle UI URL for each project is included.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      const { deployments } = await listDeployments();
      const filtered = raw.org
        ? deployments.filter((d) => d.org_id === raw.org)
        : deployments;
      if (filtered.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: raw.org
                ? `No projects found in org "${raw.org}".`
                : "No projects found.",
            },
          ],
        };
      }

      // Group by (org, project) so a project with multiple deployments
      // shows as one entry with both. Today most projects are 1:1.
      type Row = { org: string; project: string; deployments: Deployment[] };
      const byKey = new Map<string, Row>();
      for (const d of filtered) {
        const k = `${d.org_id}/${d.project_id}`;
        const row = byKey.get(k) ?? { org: d.org_id, project: d.project_id, deployments: [] };
        row.deployments.push(d);
        byKey.set(k, row);
      }

      const webBase = (process.env.CRONICLE_WEB_URL ?? process.env.CRONICLE_API_URL ?? "")
        .replace(/\/+$/, "");

      const lines: string[] = [];
      lines.push(`Found ${byKey.size} project${byKey.size === 1 ? "" : "s"}:\n`);
      for (const row of byKey.values()) {
        const statuses = row.deployments.map((d) => d.status).join(", ");
        lines.push(`• ${row.org}/${row.project}`);
        lines.push(`    status: ${statuses}`);
        if (webBase) {
          lines.push(`    url:    ${webBase}/${encodeURIComponent(row.org)}/projects/${encodeURIComponent(row.project)}/schedules`);
        }
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
