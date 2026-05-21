// Tool: cronicle_add_schedule
//
// Adds (or updates) one `schedule "name" { ... }` block inside an
// existing project's cronicle.hcl. Backed by the api's hclsplicer:
// existing schedule with the same name is replaced; otherwise the
// block is appended. The full file is re-validated on the way in,
// so a syntax error in the new block surfaces with line diagnostics
// rather than silently corrupting the file.
//
// Why one schedule at a time (vs replacing the whole HCL): the LLM's
// intent is typically "add this one workflow"; bundling several is
// risky because a parse error in any one rejects the entire PUT.
// Per-schedule upserts let the LLM iterate.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { putSchedule, CronicleAPIError } from "../api.js";

const inputSchema = z.object({
  project_slug: z
    .string()
    .describe("The project to add the schedule to (the slug, not the display name)."),
  schedule_name: z
    .string()
    .describe(
      "The label inside `schedule \"...\" { ... }`. Must match the label in the HCL block exactly. URL-safe (letters, digits, underscores, hyphens).",
    ),
  schedule_hcl: z
    .string()
    .min(20)
    .describe(
      "The full schedule block as HCL. Must contain exactly one `schedule \"NAME\" { ... }` whose NAME matches schedule_name. Example:\n\n  schedule \"morning_brief\" {\n    cron = \"0 9 * * *\"\n    task \"brief\" {\n      command = [\"sh\", \"-c\", \"echo hi\"]\n    }\n  }\n\nWhen replacing an existing schedule, include the full block (not a diff).",
    ),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_add_schedule",
    {
      title: "Add or update a schedule in a project",
      description:
        "Adds a new `schedule { }` block to an existing cronicle project's HCL, OR updates an existing schedule with the same name. The api's HCL splicer handles upsert semantics; the full file is validated post-splice.\n\nUse cronicle_create_project to start a project from scratch.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      try {
        const result = await putSchedule(raw.project_slug, raw.schedule_name, raw.schedule_hcl);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Schedule "${raw.schedule_name}" upserted in project "${raw.project_slug}".\n` +
                `Project HCL is now at version ${result.version}.\n` +
                `cronicled will pick up the change within ~1 second; the new schedule will fire on its next cron tick.`,
            },
          ],
        };
      } catch (e) {
        if (e instanceof CronicleAPIError) {
          // 400 with issues[] means parser caught something — surface
          // the line/column so the LLM can fix and retry.
          const body = e.body as { error?: string; issues?: Array<{ line?: number; column?: number; summary?: string; detail?: string }> } | null;
          if (body?.issues && body.issues.length > 0) {
            const issueLines = body.issues
              .map((i) => `  line ${i.line ?? "?"}: ${i.summary ?? i.detail ?? "(no message)"}`)
              .join("\n");
            return errorResponse(
              `cronicle.hcl validation failed:\n${issueLines}\n\nFix the schedule_hcl and try again.`,
            );
          }
          return errorResponse(`API rejected the schedule: ${e.message}`);
        }
        return errorResponse(`Could not upsert schedule: ${(e as Error).message}`);
      }
    },
  );
}

function errorResponse(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
