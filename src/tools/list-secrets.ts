// Tool: cronicle_list_secrets
//
// Discovery — "does my project have ANTHROPIC_API_KEY set?" The api
// returns metadata only; never the plaintext. Important: when the
// LLM sees a missing secret, it should call cronicle_set_secret to
// add it (NOT try to guess what value should be there).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listSecrets } from "../api.js";

const inputSchema = z.object({
  project_slug: z.string().describe("The cronicle project."),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_list_secrets",
    {
      title: "List a project's secrets",
      description:
        "Returns the names + versions of every secret on a project. Plaintext is never returned. Use to verify which `$secret.NAME` references in the HCL are actually populated before triggering a run.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      try {
        const secrets = await listSecrets(raw.project_slug);
        if (secrets.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No secrets set on "${raw.project_slug}". Use cronicle_set_secret to add one.`,
              },
            ],
          };
        }
        const lines = [`${secrets.length} secret${secrets.length === 1 ? "" : "s"} on "${raw.project_slug}":\n`];
        for (const s of secrets) {
          lines.push(`• ${s.name} (v${s.version}, created ${s.created_at})`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Could not list secrets: ${(e as Error).message}` }],
        };
      }
    },
  );
}
