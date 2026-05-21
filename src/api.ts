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
