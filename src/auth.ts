// JWT verification middleware for the HTTP transport.
//
// Implements the resource-server side of MCP OAuth: verify the
// Authorization: Bearer <jwt> header against WorkOS's JWKS. JWKS is
// fetched once and cached in-process (jose's createRemoteJWKSet handles
// rotation automatically — refreshes when a JWT references an unknown
// kid).
//
// On verification failure we return 401 with WWW-Authenticate so the
// MCP client knows to discover /.well-known/oauth-protected-resource
// and kick off the OAuth flow.

import type { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

// JWKS fetcher is global-ish — one per (jwksUrl, issuer) pair, but
// our process only talks to a single tenant so we lazy-init once.
let jwksGetter: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksUrl: string | null = null;

function getJWKS(jwksUrl: string) {
  if (jwksGetter && cachedJwksUrl === jwksUrl) return jwksGetter;
  jwksGetter = createRemoteJWKSet(new URL(jwksUrl));
  cachedJwksUrl = jwksUrl;
  return jwksGetter;
}

// We reuse the SDK's AuthInfo shape so that req.auth lines up with
// what StreamableHTTPServerTransport reads. The SDK requires:
//   - token: the original bearer string
//   - clientId: the OAuth client id (WorkOS uses `azp` or `client_id`)
//   - scopes: array of scope strings
// We additionally stash the WorkOS `sub` (user_id) on the auth object
// via the index signature so downstream tools can resolve to a user
// without re-decoding the JWT.
declare module "express-serve-static-core" {
  interface Request {
    auth?: {
      token: string;
      clientId: string;
      scopes: string[];
      // not in AuthInfo's required set, but we attach for tool use
      subject?: string;
      claims?: Record<string, unknown>;
    };
  }
}

export function jwtVerifyMiddleware(jwksUrl: string, issuer: string) {
  return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      challenge(res, "missing_bearer", "Authorization Bearer token required");
      return;
    }
    const token = header.slice("Bearer ".length).trim();
    try {
      const { payload } = await jwtVerify(token, getJWKS(jwksUrl), {
        issuer,
        // No audience check yet — WorkOS-issued tokens don't always
        // carry `aud` for resource servers. When WorkOS resource-
        // server registration adds this, add audience: PUBLIC_URL.
      });
      if (!payload.sub) {
        challenge(res, "invalid_token", "JWT has no `sub` claim");
        return;
      }
      // WorkOS uses `azp` (authorized party) for the client id, with
      // `client_id` as a fallback. Scopes arrive either as a space-
      // delimited `scope` string or already as an array.
      const clientId =
        (typeof payload["azp"] === "string" && payload["azp"]) ||
        (typeof payload["client_id"] === "string" && payload["client_id"]) ||
        "unknown";
      const scopes: string[] = Array.isArray(payload["scopes"])
        ? (payload["scopes"] as string[])
        : typeof payload["scope"] === "string"
        ? (payload["scope"] as string).split(/\s+/).filter(Boolean)
        : [];
      req.auth = {
        token,
        clientId,
        scopes,
        subject: payload.sub,
        claims: payload as Record<string, unknown>,
      };
      next();
    } catch (e) {
      challenge(res, "invalid_token", (e as Error).message);
    }
  };
}

// challenge sends a 401 with the WWW-Authenticate header that MCP
// clients use to discover the .well-known doc + OAuth params. The
// `resource_metadata` parameter is the spec'd way to point clients
// at our metadata URL.
function challenge(res: Response, error: string, description: string): void {
  res
    .status(401)
    .set(
      "WWW-Authenticate",
      `Bearer realm="cronicle-mcp", error="${error}", error_description="${description}"`,
    )
    .json({ error, error_description: description });
}
