// Thin HTTP client for the cronicle-infra public api.
//
// Reads two env vars at process start (the MCP server is a long-lived
// subprocess, so we cache them once):
//
//   CRONICLE_API_URL   base URL of cronicle-infra (e.g. https://cronicle.example/v1
//                      — note: NO trailing slash, NO /v1 suffix — we add /v1 below)
//   CRONICLE_TOKEN     bearer token. Format: cronicle_pat_<32 random>.
//                      Generated in the cronicle UI: Settings → API Tokens.
//                      (Future: WorkOS-issued OAuth access tokens for
//                      the AuthKit-for-MCP flow — same Authorization
//                      header, JWT instead of PAT prefix.)
//
// All requests go through one chokepoint (`api()`) so error handling,
// timeout, and auth stay consistent. Tools build their own typed
// request/response shapes on top.

const API_URL = (process.env.CRONICLE_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const TOKEN = process.env.CRONICLE_TOKEN ?? "";

// Default timeout — 30s covers slow PG cold-starts on the DOKS managed db
// without making the LLM wait forever on a misconfigured api URL.
const DEFAULT_TIMEOUT_MS = 30_000;

export class CronicleAPIError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const summary =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${status}`;
    super(summary);
    this.name = "CronicleAPIError";
    this.status = status;
    this.body = body;
  }
}

// api is the single dispatch point for everything that goes over the
// wire. Tools call this; nothing else. Centralizes auth header,
// timeout, JSON encoding, error shape.
export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  if (!TOKEN) {
    throw new Error(
      "CRONICLE_TOKEN is not set. Generate a PAT in the cronicle UI (Settings → API Tokens) and add it to your MCP server config.",
    );
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "cronicle-mcp/0.1",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    // Best-effort JSON parse; some endpoints (PUT cronicle.hcl) return
    // empty bodies on success. Empty → undefined; truthy non-JSON →
    // surface as the raw text so the tool can show it.
    let parsed: unknown;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    if (!resp.ok) {
      throw new CronicleAPIError(resp.status, parsed ?? null);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

// --- Typed wrappers for the endpoints the MCP tools call ----------------

export type Deployment = {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  status: string;
  listener_url?: string;
  created_at: string;
};

export async function createDeployment(
  orgID: string,
  projectID: string,
  name: string,
): Promise<Deployment> {
  return api<Deployment>("/v1/deployments", {
    method: "POST",
    body: { org_id: orgID, project_id: projectID, name },
  });
}

export async function putProjectHCL(
  projectID: string,
  hcl: string,
  ifMatch: number,
): Promise<{ version: number }> {
  // PUT with If-Match: 0 is the create-new-project version path; existing
  // projects need the current version returned by GET cronicle.hcl.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(
      `${API_URL}/v1/projects/${encodeURIComponent(projectID)}/cronicle.hcl`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          "If-Match": String(ifMatch),
          "User-Agent": "cronicle-mcp/0.1",
        },
        body: JSON.stringify({ hcl }),
        signal: ctrl.signal,
      },
    );
    if (!resp.ok) {
      const text = await resp.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
      throw new CronicleAPIError(resp.status, body);
    }
    const text = await resp.text();
    if (!text) return { version: ifMatch + 1 };
    return JSON.parse(text) as { version: number };
  } finally {
    clearTimeout(timer);
  }
}

// listDeployments returns the api's view of all deployments visible to
// the caller. Today the api doesn't filter by org; callers do that
// client-side (with the org column in the response). Acceptable while
// we're single-org.
export async function listDeployments(): Promise<{ deployments: Deployment[] }> {
  return api<{ deployments: Deployment[] }>("/v1/deployments");
}

// putSchedule inserts or updates one schedule block inside the project
// HCL via the splicer. PUT is upsert — existing schedule named `name`
// is replaced, otherwise the block is appended. The api validates the
// post-splice HCL as a whole and rejects on parse failure with
// per-line issues.
export async function putSchedule(
  projectID: string,
  scheduleName: string,
  scheduleHCL: string,
): Promise<{ project_id: string; name: string; version: number }> {
  return api<{ project_id: string; name: string; version: number }>(
    `/v1/projects/${encodeURIComponent(projectID)}/schedules/${encodeURIComponent(scheduleName)}`,
    { method: "PUT", body: { hcl: scheduleHCL } },
  );
}

// syncFromRepo refetches the project's cronicle.hcl from its declared
// `repo { url, branch }` block and PUTs as a new version. Returns
// "already_in_sync" when the remote HCL byte-equals the stored one.
// 400 on Mode B projects (no top-level repo block).
export type SyncFromRepoResponse = {
  status: "synced" | "already_in_sync";
  version: number;
  source: string;
  branch: string;
};

export async function syncFromRepo(projectID: string): Promise<SyncFromRepoResponse> {
  return api<SyncFromRepoResponse>(
    `/v1/projects/${encodeURIComponent(projectID)}/sync-from-repo`,
    { method: "POST" },
  );
}

// createSecret persists a project-scoped secret (org-scoped variant
// exists too but most use cases fit per-project). The api encrypts
// `value` at rest; this client never sees plaintext past the wire.
export type SecretMeta = {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  version: number;
  created_at: string;
};

export async function createSecret(
  orgID: string,
  projectID: string,
  name: string,
  value: string,
): Promise<SecretMeta> {
  return api<SecretMeta>(
    `/v1/projects/${encodeURIComponent(projectID)}/secrets`,
    { method: "POST", body: { org_id: orgID, name, value } },
  );
}

// listRuns asks the project's cronicled runtime for recent runs via
// the api's deployment proxy. cronicled owns the runs table; the api
// just forwards. Shape is whatever the listener returns — we type the
// fields we know about and pass the rest through as `extra`.
//
// Note: this requires the deployment's listener_url to be reachable
// from the api (it is in-cluster). Returns an empty list when the
// project has no deployment yet.
export type RunSummary = {
  run_id: string;
  schedule: string;
  status: string;        // "running" | "succeeded" | "failed" | "skipped" | ...
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  task_count?: number;
};

export async function listRuns(
  projectID: string,
  scheduleName?: string,
  limit?: number,
): Promise<RunSummary[]> {
  // Find the deployment for this project first; the proxy is keyed by
  // deployment id, not project id.
  const deps = await listDeployments();
  const dep = deps.deployments.find((d) => d.project_id === projectID);
  if (!dep) return [];
  const q = new URLSearchParams();
  if (scheduleName) q.set("schedule", scheduleName);
  if (limit) q.set("limit", String(limit));
  const qs = q.toString();
  const path = `/v1/deployments/${encodeURIComponent(dep.id)}/proxy/v1/runs${qs ? "?" + qs : ""}`;
  // The listener returns either a bare array or an object — accept both
  // for forward compat with future cronicled changes.
  const resp = await api<RunSummary[] | { runs: RunSummary[] }>(path);
  return Array.isArray(resp) ? resp : resp.runs ?? [];
}
