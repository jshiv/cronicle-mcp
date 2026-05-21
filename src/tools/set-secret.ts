// Tool: cronicle_set_secret
//
// Persists a project-scoped secret. Schedules reference these via
// `env = ["NAME=$secret.NAME"]` in their HCL — typical use cases are
// ANTHROPIC_API_KEY, SLACK_WEBHOOK_URL, database URLs, etc.
//
// The plaintext value flows api → DB and is encrypted at rest. We
// never echo it back; the tool's response carries only the secret's
// metadata (name, version, created_at).
//
// IMPORTANT for LLM safety: the tool description warns the model NOT
// to include secret values in any visible content output. Claude
// will see the plaintext in its tool-call arguments — that's
// unavoidable for the call to work — but should not paraphrase or
// confirm it in a user-visible reply.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createSecret, CronicleAPIError } from "../api.js";

const inputSchema = z.object({
  project_slug: z.string().describe("The project the secret belongs to."),
  name: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, {
      message: "Secret name must be UPPER_SNAKE_CASE (matches env-var convention).",
    })
    .describe(
      "Secret name. UPPER_SNAKE_CASE — schedules reference it as `env = [\"NAME=$secret.NAME\"]`.",
    ),
  value: z
    .string()
    .min(1)
    .describe(
      "The secret value (plaintext). The api encrypts at rest; this tool never echoes the value back. DO NOT include the plaintext in any user-visible reply — confirm only that the secret was set.",
    ),
  org: z
    .string()
    .optional()
    .describe("Org slug. Defaults to CRONICLE_DEFAULT_ORG env var, or 'personal'."),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_set_secret",
    {
      title: "Set a project secret",
      description:
        "Creates or updates a project-scoped secret. Schedules reference these via `env = [\"NAME=$secret.NAME\"]` in their HCL. Common use cases: ANTHROPIC_API_KEY, SLACK_WEBHOOK_URL, database URLs.\n\nThe plaintext is encrypted at rest by the api. **Never include the secret value in any visible reply** — confirm the secret was set by name and version only.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      const orgID = raw.org ?? process.env.CRONICLE_DEFAULT_ORG ?? "personal";
      try {
        const meta = await createSecret(orgID, raw.project_slug, raw.name, raw.value);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Set secret "${meta.name}" (v${meta.version}) on project "${raw.project_slug}". ` +
                `Schedules in this project can now reference it as $secret.${meta.name}.`,
            },
          ],
        };
      } catch (e) {
        if (e instanceof CronicleAPIError) {
          return errorResponse(`API rejected the secret: ${e.message}`);
        }
        return errorResponse(`Could not set secret: ${(e as Error).message}`);
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
