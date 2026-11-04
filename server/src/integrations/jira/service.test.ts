import { describe, expect, test } from "bun:test";
import { createMemoryCredentialStore, type JiraCredentials } from "./credentials";
import { JiraError, jiraAuthError, type JiraApi } from "./mcp-client";
import { createOAuthStateStore, type FetchLike } from "./oauth";
import {
  JIRA_OAUTH_CALLBACK_PATH,
  callbackRedirectUri,
  createJiraService,
} from "./service";
import { defaultJiraSettings, type JiraSettings } from "./settings";

const credentials: JiraCredentials = {
  version: 1,
  site_url: "https://acme.atlassian.net",
  client_id: "c1",
  token_endpoint: "https://auth.example/token",
  access_token: "secret-access",
  refresh_token: "secret-refresh",
  expires_at: "2099-01-01T00:00:00.000Z",
};

function fakeApi(overrides: Partial<JiraApi> = {}): JiraApi {
  return {
    userInfo: async () => ({ name: "Ada" }),
    accessibleResources: async () => [
      { id: "cloud-1", url: "https://acme.atlassian.net/" },
    ],
    search: async () => ({ issues: [], next_page_token: null }),
    issue: async () => {
      throw new Error("not used");
    },
    projects: async () => [{ key: "SDS", name: "SDS" }],
    statuses: async () => ["To Do"],
    transitions: async () => [{ id: "31", name: "Review", to: "In Review" }],
    transition: async () => undefined,
    addComment: async () => undefined,
    ...overrides,
  };
}

const oauthFetch: FetchLike = async (url) => {
  if (url.endsWith("/.well-known/oauth-protected-resource"))
    return new Response("", { status: 404 });
  if (url.endsWith("/.well-known/oauth-authorization-server"))
    return Response.json({
      authorization_endpoint: "https://auth.example/authorize",
      token_endpoint: "https://auth.example/token",
      registration_endpoint: "https://auth.example/register",
    });
  if (url === "https://auth.example/register")
    return Response.json({ client_id: "c1" });
  if (url === "https://auth.example/token")
    return Response.json({
      access_token: "secret-access",
      refresh_token: "secret-refresh",
      expires_in: 3600,
    });
  return new Response("", { status: 404 });
};

function setup(
  initial: JiraSettings | undefined,
  options: { creds?: JiraCredentials | null; api?: JiraApi } = {},
) {
  let settings = initial;
  const store = createMemoryCredentialStore(
    options.creds === undefined ? credentials : options.creds,
  );
  const states = createOAuthStateStore();
  const service = createJiraService({
    readSettings: async () => settings,
    updateSettings: async (update) => {
      settings = update(settings);
      return settings;
    },
    credentials: store,
    states,
    fetch: oauthFetch,
    api: options.api ?? fakeApi(),
  });
  return { service, store, states, settings: () => settings };
}

const configured: JiraSettings = {
  ...defaultJiraSettings(),
  enabled: true,
  site_url: "https://acme.atlassian.net",
  cloud_id: "cloud-1",
};

describe("config RPCs", () => {
  test("no RPC result carries a token (AC2)", async () => {
    const { service } = setup(configured);
    for (const [method, params] of [
      ["bridge.jira.config.get", {}],
      ["bridge.jira.config.update", { default_jql: "project = SDS" }],
      ["bridge.jira.test", {}],
      ["bridge.jira.oauth.start", { origin: "https://roamgate.example" }],
    ] as const) {
      const wire = JSON.stringify(await service.handle(method, params));
      expect(wire).not.toContain("secret-access");
      expect(wire).not.toContain("secret-refresh");
    }
  });

  test("an invalid update saves nothing (AC16)", async () => {
    const { service, settings } = setup(configured);
    await expect(
      service.handle("bridge.jira.config.update", {
        site_url: "https://x.example.com",
        default_jql: "changed",
      }),
    ).rejects.toThrow();
    expect(settings()?.default_jql).toBe(configured.default_jql);
  });

  test("changing the site URL signs out of the old site (AC9, AC28)", async () => {
    const { service, store, settings } = setup(configured);
    const view = (await service.handle("bridge.jira.config.update", {
      site_url: "https://other.atlassian.net",
    })) as any;
    expect(store.read()).toBeNull();
    expect(settings()?.cloud_id).toBeUndefined();
    expect(view.auth.state).toBe("not_configured");
  });

  test("saving the same site URL keeps the sign-in", async () => {
    const { service, store } = setup(configured);
    const view = (await service.handle("bridge.jira.config.update", {
      site_url: "https://acme.atlassian.net/",
      default_jql: "project = SDS",
    })) as any;
    expect(store.read()).not.toBeNull();
    expect(view.auth.state).toBe("authenticated");
  });

  test("credentials for another site never count as signed in", async () => {
    const { service } = setup(configured, {
      creds: { ...credentials, site_url: "https://old.atlassian.net" },
    });
    const view = (await service.handle("bridge.jira.config.get", {})) as any;
    expect(view.auth.state).toBe("not_configured");
  });

  test("remove deletes config and credentials (AC26)", async () => {
    const { service, store, settings } = setup(configured);
    const view = (await service.handle("bridge.jira.config.remove", {})) as any;
    expect(store.read()).toBeNull();
    expect(settings()).toBeUndefined();
    expect(view.auth.state).toBe("not_configured");
  });

  test("test connection records the account or the error (AC20)", async () => {
    const ok = setup(configured);
    const view = (await ok.service.handle("bridge.jira.test", {})) as any;
    expect(view.auth.state).toBe("authenticated");
    expect(view.auth.account).toBe("Ada");
    expect(view.auth.checked_at).toBeString();

    const failing = setup(configured, {
      api: fakeApi({
        userInfo: async () => {
          throw jiraAuthError();
        },
      }),
    });
    const failed = (await failing.service.handle("bridge.jira.test", {})) as any;
    expect(failed.auth.state).toBe("error");
    expect(failed.auth.error).toContain("Jira sign-in required");
  });
});

describe("OAuth", () => {
  test("redirect URI comes from a bare origin only", () => {
    expect(callbackRedirectUri("https://roamgate.example")).toBe(
      `https://roamgate.example${JIRA_OAUTH_CALLBACK_PATH}`,
    );
    for (const bad of [
      "https://roamgate.example/path",
      "javascript:alert(1)",
      "https://user:pw@roamgate.example",
      42,
    ])
      expect(() => callbackRedirectUri(bad)).toThrow();
  });

  test("start needs a saved site URL", async () => {
    const { service } = setup(undefined, { creds: null });
    await expect(
      service.handle("bridge.jira.oauth.start", { origin: "https://r.example" }),
    ).rejects.toThrow("site URL");
  });

  test("start then complete stores tokens and the cloud ID (AC17, AC18)", async () => {
    const site = { ...defaultJiraSettings(), site_url: "https://acme.atlassian.net" };
    const { service, store, settings, states } = setup(site, { creds: null });
    const { authorize_url } = (await service.handle("bridge.jira.oauth.start", {
      origin: "https://r.example",
    })) as { authorize_url: string };
    const state = new URL(authorize_url).searchParams.get("state");
    expect(states.size()).toBe(1);
    const result = await service.completeOAuth("code-1", state);
    expect(result.account).toBe("Ada");
    expect(store.read()?.refresh_token).toBe("secret-refresh");
    expect(settings()?.cloud_id).toBe("cloud-1");
    // Single use.
    await expect(service.completeOAuth("code-1", state)).rejects.toThrow(
      "invalid or has expired",
    );
  });

  test("an unknown state saves nothing", async () => {
    const site = { ...defaultJiraSettings(), site_url: "https://acme.atlassian.net" };
    const { service, store } = setup(site, { creds: null });
    await expect(service.completeOAuth("code", "forged")).rejects.toThrow();
    expect(store.read()).toBeNull();
  });

  test("a site the account cannot access discards the tokens", async () => {
    const site = { ...defaultJiraSettings(), site_url: "https://acme.atlassian.net" };
    const { service, store } = setup(site, {
      creds: null,
      api: fakeApi({ accessibleResources: async () => [] }),
    });
    const { authorize_url } = (await service.handle("bridge.jira.oauth.start", {
      origin: "https://r.example",
    })) as { authorize_url: string };
    await expect(
      service.completeOAuth("c", new URL(authorize_url).searchParams.get("state")),
    ).rejects.toThrow("not one of the sites");
    expect(store.read()).toBeNull();
  });
});

describe("search", () => {
  test("builds JQL from filters, or runs raw JQL as written (AC34, AC35)", async () => {
    const calls: string[] = [];
    const { service } = setup(configured, {
      api: fakeApi({
        search: async (_cloud, _site, jql, token, max) => {
          calls.push(`${jql}|${token}|${max}`);
          return { issues: [], next_page_token: "next" };
        },
      }),
    });
    const structured = (await service.handle("bridge.jira.search", {
      filters: { project: "SDS", assignee: "me" },
    })) as any;
    expect(structured.jql).toBe(
      'project = "SDS" AND assignee = currentUser() ORDER BY updated DESC',
    );
    expect(structured.next_page_token).toBe("next");
    await service.handle("bridge.jira.search", {
      jql: "labels = x",
      filters: { project: "IGNORED" },
      page_token: "p2",
    });
    expect(calls[1]).toBe("labels = x|p2|25");
  });

  test("fails clearly when Jira is not configured", async () => {
    const { service } = setup(undefined, { creds: null });
    const error = await service
      .handle("bridge.jira.search", {})
      .catch((value) => value);
    expect((error as JiraError).code).toBe("jira_not_configured");
  });
});

describe("sync back", () => {
  test("comments, then transitions to the matching status (AC61)", async () => {
    const events: string[] = [];
    const { service } = setup(configured, {
      api: fakeApi({
        addComment: async (_cloud, key, body) => {
          events.push(`comment ${key} ${body}`);
        },
        transition: async (_cloud, key, id) => {
          events.push(`transition ${key} ${id}`);
        },
      }),
    });
    await service.syncBack("SDS-1", "Done", "in review");
    expect(events).toEqual(["comment SDS-1 Done", "transition SDS-1 31"]);
  });

  test("keeps the comment and reports a missing transition (AC62)", async () => {
    const events: string[] = [];
    const { service } = setup(configured, {
      api: fakeApi({
        addComment: async () => {
          events.push("comment");
        },
        transitions: async () => [],
      }),
    });
    await expect(service.syncBack("SDS-1", "Done", "QA")).rejects.toThrow(
      'no transition leads to "QA"',
    );
    expect(events).toEqual(["comment"]);
  });
});
