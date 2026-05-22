// Tool: cronicle_init_project_from_repo
//
// One-call Mode-A bootstrap. The LLM passes a repo URL; this tool:
//   1. Fetches cronicle.hcl from the repo via the api's /v1/repos/fetch-hcl
//      (which also validates the file parses + has a top-level repo
//      block — the Mode-A precondition).
//   2. Creates the deployment.
//   3. PUTs the fetched HCL as the project's seed config.
//   4. Rolls back the deployment if the PUT fails (mirrors the
//      cronicle-web BFF's project-create transaction).
//
// Pairs with the /cronicle:init-from-repo prompt as the "happy path"
// for the mobile workflow: "create a cronicle project from this repo
// I made earlier." Without this tool the LLM has to fetch the HCL
// itself (via curl / WebFetch), pass it inline to create_project,
// and remember to use the repo URL as the source for sync later.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createDeployment,
  putProjectHCL,
  fetchHCLFromRepo,
  deriveSlugFromRepoURL,
  api,
  CronicleAPIError,
} from "../api.js";

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/;

const inputSchema = z.object({
  repo_url: z
    .string()
    .describe(
      "Public GitHub repo URL. https://github.com/owner/repo or git@github.com:owner/repo.git. The repo must have a cronicle.hcl at its root with a top-level `repo` block (Mode-A precondition).",
    ),
  branch: z.string().optional().describe("Branch to fetch from. Defaults to 'main'."),
  project_slug: z
    .string()
    .optional()
    .describe(
      "URL-safe project slug. Defaults to the repo name (e.g. 'rivian-reddit-monitor' from .../rivian-reddit-monitor). Lowercase letters, digits, hyphens; can't start or end with a hyphen.",
    ),
  deployment_name: z
    .string()
    .optional()
    .describe("Human-readable name for the worker pod. Defaults to project_slug."),
  org: z
    .string()
    .optional()
    .describe("Org slug. Defaults to CRONICLE_DEFAULT_ORG or 'personal'."),
});

type Input = z.infer<typeof inputSchema>;

export function register(server: McpServer): void {
  server.registerTool(
    "cronicle_init_project_from_repo",
    {
      title: "Initialise a cronicle project from a git repo (one call)",
      description:
        "Bootstraps a Mode-A project: fetches the repo's cronicle.hcl, creates the deployment, persists the HCL. The repo's cronicle.hcl must have a top-level `repo` block — without it the api 400s with a fix-it message that this tool surfaces verbatim.\n\nUse for 'create a project from this repo' requests. After the project is created, set any `$secret.NAME` references via cronicle_set_secret before the first run.",
      inputSchema: inputSchema.shape,
    },
    async (raw: Input) => {
      const slug = raw.project_slug ?? deriveSlugFromRepoURL(raw.repo_url);
      if (!slug) {
        return errorResponse(
          `Could not derive a project slug from "${raw.repo_url}". Pass project_slug explicitly.`,
        );
      }
      if (!SLUG_REGEX.test(slug)) {
        return errorResponse(
          `Slug "${slug}" is invalid. Must match /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/ — lowercase letters, digits, hyphens; no leading/trailing hyphen.`,
        );
      }
      const orgID = raw.org ?? process.env.CRONICLE_DEFAULT_ORG ?? "personal";
      const deploymentName = raw.deployment_name ?? slug;

      // 1) Fetch + validate HCL from the repo. Surfaces the Mode-A
      //    precondition 400 ("no top-level repo block") + parse errors
      //    + 404 (cronicle.hcl missing) verbatim — all are actionable
      //    by the user.
      let fetched;
      try {
        fetched = await fetchHCLFromRepo(raw.repo_url, raw.branch);
      } catch (e) {
        if (e instanceof CronicleAPIError) {
          return errorResponse(`Could not fetch cronicle.hcl from repo: ${e.message}`);
        }
        return errorResponse(`Could not fetch cronicle.hcl from repo: ${(e as Error).message}`);
      }

      // 2) Create the deployment.
      let deployment;
      try {
        deployment = await createDeployment(orgID, slug, deploymentName);
      } catch (e) {
        if (e instanceof CronicleAPIError && e.status === 402) {
          return errorResponse(
            `Cannot create project: ${e.message}. Upgrade your plan at the cronicle Billing page.`,
          );
        }
        return errorResponse(`Could not create deployment: ${(e as Error).message}`);
      }

      // 3) Persist the HCL. Roll back the deployment on failure so we
      //    don't leave a half-created project.
      try {
        await putProjectHCL(slug, fetched.hcl, 0);
      } catch (e) {
        try {
          await api(`/v1/deployments/${encodeURIComponent(deployment.id)}`, { method: "DELETE" });
        } catch {
          // Rollback failed — surface the original error anyway.
        }
        if (e instanceof CronicleAPIError) {
          return errorResponse(
            `cronicle.hcl rejected: ${e.message}. Deployment rolled back; fix the HCL in the repo and try again.`,
          );
        }
        return errorResponse(`Could not persist cronicle.hcl: ${(e as Error).message}`);
      }

      const webBase = (process.env.CRONICLE_WEB_URL ?? process.env.CRONICLE_API_URL ?? "").replace(/\/+$/, "");
      const projectURL = webBase
        ? `${webBase}/${encodeURIComponent(orgID)}/projects/${encodeURIComponent(slug)}/schedules`
        : "(set CRONICLE_WEB_URL to render a clickable URL)";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Created project "${slug}" under org "${orgID}" from ${fetched.source}@${fetched.branch}.\n\n` +
              `Deployment: ${deployment.id} (status: ${deployment.status})\n` +
              `Project URL: ${projectURL}\n\n` +
              `Next steps:\n` +
              `1. Scan the HCL for $secret.NAME references and set each via cronicle_set_secret.\n` +
              `2. Once secrets are set, cronicle_run_schedule_now to test, then cronicle_list_runs to verify.\n` +
              `3. To pull future repo edits: cronicle_sync_from_repo with project_slug="${slug}".`,
          },
        ],
      };
    },
  );
}

function errorResponse(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
