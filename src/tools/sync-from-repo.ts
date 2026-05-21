// Tool: cronicle_sync_from_repo
//
// Pulls the project's cronicle.hcl from its declared `repo { url,
// branch }` block and PUTs it as a new version. The user-facing
// equivalent of clicking the "Sync now" button on the cronicle
// schedules page for Mode-A projects.
//
// 400 when the project doesn't have a top-level repo block (Mode B —
// UI-owned). The tool surfaces that distinctly so the LLM knows
// whether to suggest "this project isn't repo-managed" vs "the sync
// just didn't change anything."

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { syncFromRepo, CronicleAPIError } from "../api.js";

const inputSchema = z.object({
  project_slug: z.string().describe("The project to sync. Must be Mode-A (created via 'Init from repo' or with a top-level repo block in its HCL)."),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_sync_from_repo",
    {
      title: "Re-sync a project's cronicle.hcl from its repo",
      description:
        "For Mode-A (repo-managed) projects: refetch cronicle.hcl from the project's declared repo and apply it as a new version. Use after pushing edits to the cronicle.hcl in the repo.\n\nReturns `already_in_sync` (no version bump) when the repo HCL byte-matches what's stored. Fails with 400 on Mode-B (UI-owned) projects — those don't sync from a repo.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      try {
        const result = await syncFromRepo(raw.project_slug);
        if (result.status === "already_in_sync") {
          return {
            content: [
              {
                type: "text" as const,
                text: `"${raw.project_slug}" is already in sync with ${result.source}@${result.branch} (version ${result.version}). No changes applied.`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Synced "${raw.project_slug}" from ${result.source}@${result.branch}.\n` +
                `New version: ${result.version}. cronicled will pick up the change within ~1 second.`,
            },
          ],
        };
      } catch (e) {
        if (e instanceof CronicleAPIError) {
          if (e.status === 400 && e.message.includes("not managed by a repo")) {
            return errorResponse(
              `Project "${raw.project_slug}" isn't managed by a repo. Add a top-level \`repo { url = "..." }\` block to its cronicle.hcl (via the UI) and try again, or recreate the project via "Init from repo".`,
            );
          }
          return errorResponse(`Sync failed: ${e.message}`);
        }
        return errorResponse(`Could not sync: ${(e as Error).message}`);
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
