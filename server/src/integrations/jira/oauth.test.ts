import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  OAUTH_STATE_TTL_MS,
  authorizeUrl,
  createOAuthStateStore,
  discoverOAuthEndpoints,
  exchangeOAuthCode,
  pkcePair,
  refreshOAuthToken,
  registerOAuthClient,
  type FetchLike,
} from "./oauth";

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetcher: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return { fetcher, calls };
}

const metadata = {
  authorization_endpoint: "https://auth.example/authorize",
  token_endpoint: "https://auth.example/token",
  registration_endpoint: "https://auth.example/register",
};

describe("discovery", () => {
  test("follows protected-resource metadata to the authorization server", async () => {
    const { fetcher } = fakeFetch({
      "https://mcp.atlassian.com/.well-known/oauth-protected-resource": () =>
        Response.json({ authorization_servers: ["https://auth.example/"] }),
      "https://auth.example/.well-known/oauth-authorization-server": () =>
        Response.json(metadata),
    });
    expect(await discoverOAuthEndpoints(fetcher)).toEqual({
      authorization: metadata.authorization_endpoint,
      token: metadata.token_endpoint,
      registration: metadata.registration_endpoint,
    });
  });

  test("falls back to the resource's own server metadata", async () => {
    const { fetcher } = fakeFetch({
      "https://mcp.atlassian.com/.well-known/oauth-authorization-server": () =>
        Response.json(metadata),
    });
    expect((await discoverOAuthEndpoints(fetcher)).token).toBe(
      metadata.token_endpoint,
    );
  });

  test("rejects metadata with missing or non-HTTPS endpoints", async () => {
    const { fetcher } = fakeFetch({
      "https://mcp.atlassian.com/.well-known/oauth-authorization-server": () =>
        Response.json({ ...metadata, token_endpoint: "http://auth.example/t" }),
    });
    await expect(discoverOAuthEndpoints(fetcher)).rejects.toThrow(
      "missing required endpoints",
    );
  });
});

test("PKCE challenge is the S256 of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  expect(verifier.length).toBeGreaterThanOrEqual(43);
  expect(challenge).toBe(
    createHash("sha256").update(verifier).digest("base64url"),
  );
});

test("registration requests a public PKCE client", async () => {
  const { fetcher, calls } = fakeFetch({
    [metadata.registration_endpoint]: () => Response.json({ client_id: "c1" }),
  });
  expect(
    await registerOAuthClient(
      fetcher,
      metadata.registration_endpoint,
      "https://roamgate.example/cb",
    ),
  ).toBe("c1");
  const body = JSON.parse(String(calls[0].init?.body));
  expect(body.token_endpoint_auth_method).toBe("none");
  expect(body.redirect_uris).toEqual(["https://roamgate.example/cb"]);
});

test("authorize URL carries PKCE, state, resource and scopes", () => {
  const url = new URL(
    authorizeUrl(
      { authorization: metadata.authorization_endpoint },
      { client_id: "c1", redirect_uri: "https://r.example/cb", state: "s1" },
      "challenge",
    ),
  );
  expect(url.searchParams.get("code_challenge")).toBe("challenge");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("state")).toBe("s1");
  expect(url.searchParams.get("resource")).toBe("https://mcp.atlassian.com");
  expect(url.searchParams.get("scope")).toContain("offline_access");
});

describe("token requests", () => {
  const pending = {
    state: "s1",
    site_url: "https://acme.atlassian.net",
    client_id: "c1",
    code_verifier: "verifier",
    redirect_uri: "https://r.example/cb",
    token_endpoint: metadata.token_endpoint,
    created_at: 0,
  };

  test("code exchange sends the stored verifier", async () => {
    const { fetcher, calls } = fakeFetch({
      [metadata.token_endpoint]: () =>
        Response.json({ access_token: "a", refresh_token: "r", expires_in: 60 }),
    });
    expect(await exchangeOAuthCode(fetcher, pending, "code1")).toEqual({
      access_token: "a",
      refresh_token: "r",
      expires_in: 60,
    });
    const form = new URLSearchParams(String(calls[0].init?.body));
    expect(form.get("code_verifier")).toBe("verifier");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("client_secret")).toBeNull();
  });

  test("refresh fails without a rotated refresh token", async () => {
    const { fetcher } = fakeFetch({
      [metadata.token_endpoint]: () => Response.json({ access_token: "a" }),
    });
    await expect(
      refreshOAuthToken(fetcher, metadata.token_endpoint, "c1", "r0"),
    ).rejects.toThrow("refresh tokens");
  });

  test("OAuth errors surface their description", async () => {
    const { fetcher } = fakeFetch({
      [metadata.token_endpoint]: () =>
        Response.json(
          { error: "invalid_grant", error_description: "expired" },
          { status: 400 },
        ),
    });
    await expect(
      refreshOAuthToken(fetcher, metadata.token_endpoint, "c1", "r0"),
    ).rejects.toThrow("invalid_grant: expired");
  });
});

describe("state store", () => {
  const base = {
    site_url: "https://acme.atlassian.net",
    client_id: "c1",
    code_verifier: "v",
    redirect_uri: "https://r.example/cb",
    token_endpoint: metadata.token_endpoint,
  };

  test("a state can be used once", () => {
    const store = createOAuthStateStore();
    store.add({ ...base, state: "s1" });
    expect(store.take("s1")?.client_id).toBe("c1");
    expect(store.take("s1")).toBeNull();
    expect(store.take(null)).toBeNull();
    expect(store.take("unknown")).toBeNull();
  });

  test("a state expires after ten minutes", () => {
    let now = 1_000;
    const store = createOAuthStateStore(() => now);
    store.add({ ...base, state: "s1" });
    now += OAUTH_STATE_TTL_MS + 1;
    expect(store.take("s1")).toBeNull();
  });

  test("pending states are bounded", () => {
    const store = createOAuthStateStore();
    for (let index = 0; index < 40; index++)
      store.add({ ...base, state: `s${index}` });
    expect(store.size()).toBe(16);
    expect(store.take("s0")).toBeNull();
    expect(store.take("s39")).not.toBeNull();
  });
});
