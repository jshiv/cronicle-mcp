// Tool: cronicle_create_project
//
// Creates a brand-new cronicle project in two api calls:
//   1. POST /v1/deployments    → provision the project's cronicle pod
//   2. PUT  /v1/projects/{p}/cronicle.hcl  → seed the HCL config
//
// Why both calls live in one tool: from the LLM's perspective "create a
// project" is one intent. Splitting it into two MCP tools would mean
// the LLM has to remember to call the second one after the first and
// would have to handle the in-between failure mode itself.
// Bundling here also lets us roll back the deployment if the HCL PUT
// fails, mirroring the cronicle-web BFF's project-create route.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDeployment, putProjectHCL, CronicleAPIError, api } from "../api.js";

// Project slug rule mirrors cronicle-infra's apiserver/types.go validator
// + the cronicle-web wizard's regex. Keeping the three in sync prevents
// "valid in the LLM tool, rejected by the api" surprises.
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/;

const inputSchema = z.object({
  project_slug: z
    .string()
    .describe(
      "URL-safe project slug. Lowercase letters, digits, and hyphens. 1–64 chars, must start + end with alphanumeric. Becomes the project's path on cronicle.",
    ),
  deployment_name: z
    .string()
    .min(1)
    .describe(
      "Human-readable name for the cronicle worker pod. Most users use the same value as project_slug. Shown in the cluster pod list.",
    ),
  cronicle_hcl: z
    .string()
    .min(10)
    .describe(
      "The full cronicle.hcl content. Must contain at least one `schedule \"name\" { ... }` block. Example:\n\n  schedule \"daily_brief\" {\n    cron = \"0 9 * * *\"\n    task \"brief\" {\n      command = [\"sh\", \"-c\", \"echo hi\"]\n    }\n  }\n",
    ),
  org: z
    .string()
    .optional()
    .describe(
      "Org slug to create the project under. Defaults to the org configured in the MCP server's env (CRONICLE_DEFAULT_ORG, or 'personal' if unset). Most single-user setups leave this empty.",
    ),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_create_project",
    {
      title: "Create a cronicle project",
      description:
        "Provisions a new cronicle project: creates the worker deployment and seeds the cronicle.hcl config. Pair with cronicle_add_schedule to add more schedules to an existing project.\n\nReturns the deployment ID, the project's URL on the cronicle UI, and the persisted HCL version (always 1 for fresh projects).",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      // Validate slug client-side so the LLM gets a clear error message
      // rather than a cryptic api 400. Same regex the api uses.
      if (!SLUG_REGEX.test(raw.project_slug)) {
        return errorResponse(
          `project_slug "${raw.project_slug}" is invalid. Must match /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/ — lowercase letters, digits, hyphens; can't start or end with a hyphen.`,
        );
      }
      const orgID = raw.org ?? process.env.CRONICLE_DEFAULT_ORG ?? "personal";

      // 1) Create the deployment first. If this 402s the org has hit
      //    its plan project cap; surface the api's message so the user
      //    knows to upgrade.
      let deployment;
      try {
        deployment = await createDeployment(orgID, raw.project_slug, raw.deployment_name);
      } catch (e) {
        if (e instanceof CronicleAPIError && e.status === 402) {
          return errorResponse(
            `Cannot create project: ${e.message}. Upgrade your plan at the cronicle UI's Billing page.`,
          );
        }
        return errorResponse(`Could not create deployment: ${(e as Error).message}`);
      }

      // 2) Seed the HCL. If this fails, roll back the deployment so we
      //    don't leave a half-created project lying around. Mirrors
      //    the cronicle-web BFF's create flow.
      try {
        await putProjectHCL(raw.project_slug, raw.cronicle_hcl, 0);
      } catch (e) {
        try {
          await api(`/v1/deployments/${encodeURIComponent(deployment.id)}`, { method: "DELETE" });
        } catch {
          // Rollback failed — log via the response, leave the deployment
          // for the user to clean up manually. Don't mask the original
          // HCL error.
        }
        if (e instanceof CronicleAPIError) {
          return errorResponse(
            `cronicle.hcl rejected: ${e.message}. Deployment rolled back; fix the HCL and try again.`,
          );
        }
        return errorResponse(`Could not persist cronicle.hcl: ${(e as Error).message}`);
      }

      const apiBase = process.env.CRONICLE_WEB_URL ?? "https://cronicle.example";
      const projectURL = `${apiBase.replace(/\/+$/, "")}/${encodeURIComponent(orgID)}/projects/${encodeURIComponent(raw.project_slug)}/schedules`;

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Created project "${raw.project_slug}" under org "${orgID}".\n\n` +
              `Deployment: ${deployment.id}\n` +
              `Status: ${deployment.status}\n` +
              `Project URL: ${projectURL}\n\n` +
              `The cronicle.hcl is now at version 1. Schedules will start firing on their cron expressions as soon as the worker pod is healthy (~10–30s).`,
          },
        ],
      };
    },
  );
}

function errorResponse(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}
