import { createHash, randomBytes } from "node:crypto";

// Atlassian's remote MCP server is both the OAuth 2.1 authorization server and
// the resource server, as in Kandev (apps/backend/internal/jira/oauth.go).
// Dynamic client registration + PKCE means no app or client secret to create.
export const ATLASSIAN_MCP_RESOURCE = "https://mcp.atlassian.com";
export const ATLASSIAN_MCP_SCOPES =
  "offline_access read:me read:account read:jira-user read:jira-work write:jira-work search:jira-work";
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 16;
const RESPONSE_LIMIT = 1 << 20;
const REQUEST_TIMEOUT_MS = 15_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type OAuthEndpoints = {
  authorization: string;
  token: string;
  registration: string;
};

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export type PendingOAuthState = {
  state: string;
  site_url: string;
  client_id: string;
  code_verifier: string;
  redirect_uri: string;
  token_endpoint: string;
  created_at: number;
};

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function randomToken(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function readJson(response: Response, what: string): Promise<any> {
  const text = await response.text();
  if (text.length > RESPONSE_LIMIT) throw new Error(`${what}: response too large`);
  if (!response.ok) {
    let detail = "";
    try {
      const body = JSON.parse(text);
      detail = [body.error, body.error_description].filter(Boolean).join(": ");
    } catch {}
    throw new Error(`${what} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what}: invalid JSON response`);
  }
}

function withTimeout(init: RequestInit = {}): RequestInit {
  return { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "error" };
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/** RFC 9728 protected-resource metadata, then RFC 8414 server metadata. */
export async function discoverOAuthEndpoints(
  fetcher: FetchLike,
  resource = ATLASSIAN_MCP_RESOURCE,
): Promise<OAuthEndpoints> {
  let issuer = resource;
  try {
    const response = await fetcher(
      `${resource}/.well-known/oauth-protected-resource`,
      withTimeout({ headers: { accept: "application/json" } }),
    );
    if (response.ok) {
      const body = await readJson(response, "OAuth resource discovery");
      const server = httpsUrl(body?.authorization_servers?.[0]);
      if (server) issuer = server.replace(/\/+$/, "");
    }
  } catch {
    // Older servers publish only the authorization-server document.
  }
  const metadata = await readJson(
    await fetcher(
      `${issuer}/.well-known/oauth-authorization-server`,
      withTimeout({ headers: { accept: "application/json" } }),
    ),
    "OAuth server discovery",
  );
  const authorization = httpsUrl(metadata?.authorization_endpoint);
  const token = httpsUrl(metadata?.token_endpoint);
  const registration = httpsUrl(metadata?.registration_endpoint);
  if (!authorization || !token || !registration)
    throw new Error("OAuth server metadata is missing required endpoints");
  return { authorization, token, registration };
}

export async function registerOAuthClient(
  fetcher: FetchLike,
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string> {
  const body = await readJson(
    await fetcher(
      registrationEndpoint,
      withTimeout({
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_name: "Roamgate",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: ATLASSIAN_MCP_SCOPES,
        }),
      }),
    ),
    "OAuth client registration",
  );
  if (typeof body?.client_id !== "string" || !body.client_id)
    throw new Error("OAuth client registration returned no client ID");
  return body.client_id;
}

export function authorizeUrl(
  endpoints: Pick<OAuthEndpoints, "authorization">,
  pending: Pick<PendingOAuthState, "client_id" | "redirect_uri" | "state">,
  challenge: string,
): string {
  const url = new URL(endpoints.authorization);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: pending.client_id,
    redirect_uri: pending.redirect_uri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: pending.state,
    resource: ATLASSIAN_MCP_RESOURCE,
    scope: ATLASSIAN_MCP_SCOPES,
  };
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  return url.toString();
}

async function tokenRequest(
  fetcher: FetchLike,
  tokenEndpoint: string,
  form: Record<string, string>,
): Promise<TokenResponse> {
  const body = await readJson(
    await fetcher(
      tokenEndpoint,
      withTimeout({
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          ...form,
          resource: ATLASSIAN_MCP_RESOURCE,
        }).toString(),
      }),
    ),
    "OAuth token request",
  );
  if (
    typeof body?.access_token !== "string" ||
    !body.access_token ||
    typeof body?.refresh_token !== "string" ||
    !body.refresh_token
  )
    throw new Error(
      "The token endpoint did not return the required access and refresh tokens",
    );
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in:
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : 3600,
  };
}

export function exchangeOAuthCode(
  fetcher: FetchLike,
  pending: PendingOAuthState,
  code: string,
): Promise<TokenResponse> {
  return tokenRequest(fetcher, pending.token_endpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirect_uri,
    client_id: pending.client_id,
    code_verifier: pending.code_verifier,
  });
}

export function refreshOAuthToken(
  fetcher: FetchLike,
  tokenEndpoint: string,
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  return tokenRequest(fetcher, tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
}

/** Single-use, 10-minute OAuth states held in memory (AC17, AC18). */
export function createOAuthStateStore(now: () => number = Date.now) {
  const states = new Map<string, PendingOAuthState>();
  function prune() {
    for (const [key, value] of states)
      if (now() - value.created_at > OAUTH_STATE_TTL_MS) states.delete(key);
    while (states.size > MAX_PENDING_STATES) {
      const oldest = states.keys().next().value;
      if (oldest === undefined) break;
      states.delete(oldest);
    }
  }
  return {
    add(pending: Omit<PendingOAuthState, "created_at">): PendingOAuthState {
      const value = { ...pending, created_at: now() };
      states.set(value.state, value);
      prune();
      return value;
    },
    take(state: string | null | undefined): PendingOAuthState | null {
      if (!state) return null;
      const value = states.get(state);
      states.delete(state);
      if (!value || now() - value.created_at > OAUTH_STATE_TTL_MS) return null;
      return value;
    },
    size: () => states.size,
  };
}
export type OAuthStateStore = ReturnType<typeof createOAuthStateStore>;
