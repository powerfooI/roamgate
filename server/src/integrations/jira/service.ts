import {
  JIRA_PAGE_SIZE,
  type JiraConfigUpdate,
  type JiraConfigView,
  type JiraFilters,
  type JiraIssue,
  type JiraSearchResult,
} from "../../../../shared/jira";
import type { JiraCredentialStore } from "./credentials";
import { buildJql } from "./jql";
import {
  JiraError,
  createJiraApi,
  createMcpClient,
  jiraAuthError,
  type JiraApi,
} from "./mcp-client";
import {
  authorizeUrl,
  discoverOAuthEndpoints,
  exchangeOAuthCode,
  pkcePair,
  randomToken,
  refreshOAuthToken,
  registerOAuthClient,
  type FetchLike,
  type OAuthStateStore,
} from "./oauth";
import {
  JQL_MAX_LENGTH,
  applyJiraConfigUpdate,
  defaultJiraSettings,
  jiraConfigView,
  type JiraSettings,
} from "./settings";

export const JIRA_OAUTH_CALLBACK_PATH = "/api/integrations/jira/oauth/callback";
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

export type JiraServiceOptions = {
  readSettings(): Promise<JiraSettings | undefined>;
  /** Persists the result of `update`; `undefined` removes the integration. */
  updateSettings(
    update: (current: JiraSettings | undefined) => JiraSettings | undefined,
  ): Promise<JiraSettings | undefined>;
  credentials: JiraCredentialStore;
  states: OAuthStateStore;
  fetch: FetchLike;
  now?: () => number;
  clientVersion?: string;
  /** Test seam: replaces the MCP-backed Jira API. */
  api?: JiraApi;
};

function notConfigured(): JiraError {
  return new JiraError(
    "Jira is not configured. Open Configuration › Integrations › Jira.",
    "jira_not_configured",
  );
}

/** Accepts only a bare http(s) origin from the browser. */
export function callbackRedirectUri(origin: unknown): string {
  if (typeof origin !== "string") throw new Error("Missing page origin.");
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("Invalid page origin.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.origin !== origin.replace(/\/+$/, "") ||
    url.username ||
    url.password
  )
    throw new Error("Invalid page origin.");
  return `${url.origin}${JIRA_OAUTH_CALLBACK_PATH}`;
}

export function createJiraService(options: JiraServiceOptions) {
  const now = options.now ?? Date.now;
  let refreshing: Promise<string> | null = null;
  let api: JiraApi | null = options.api ?? null;

  async function refresh(staleToken: string): Promise<string> {
    refreshing ??= (async () => {
      const credentials = options.credentials.read();
      if (!credentials) throw jiraAuthError();
      // Another caller already rotated the token.
      if (credentials.access_token !== staleToken) return credentials.access_token;
      const token = await refreshOAuthToken(
        options.fetch,
        credentials.token_endpoint,
        credentials.client_id,
        credentials.refresh_token,
      );
      // The old refresh token is now invalid: persist the new pair at once.
      options.credentials.write({
        ...credentials,
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        expires_at: new Date(now() + token.expires_in * 1000).toISOString(),
      });
      return token.access_token;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function client(): JiraApi {
    api ??= createJiraApi(
      createMcpClient({
        fetch: options.fetch,
        clientVersion: options.clientVersion,
        tokens: {
          async token() {
            const credentials = options.credentials.read();
            if (!credentials) throw jiraAuthError();
            if (Date.parse(credentials.expires_at) - now() < REFRESH_MARGIN_MS)
              return refresh(credentials.access_token);
            return credentials.access_token;
          },
          refresh,
        },
      }),
    );
    return api;
  }

  function resetClient() {
    if (!options.api) api = null;
  }

  /** Credentials count only for the site they were issued for. */
  function hasCredentialsFor(settings: JiraSettings | undefined): boolean {
    const credentials = options.credentials.read();
    return (
      !!credentials &&
      !!settings?.site_url &&
      credentials.site_url === settings.site_url
    );
  }

  async function view(): Promise<JiraConfigView> {
    const settings = await options.readSettings();
    return jiraConfigView(settings, hasCredentialsFor(settings));
  }

  async function connected(): Promise<
    JiraSettings & { site_url: string; cloud_id: string }
  > {
    const settings = await options.readSettings();
    if (!settings?.site_url || !hasCredentialsFor(settings)) throw notConfigured();
    if (!settings.cloud_id) throw jiraAuthError();
    return settings as JiraSettings & { site_url: string; cloud_id: string };
  }

  /** Records the outcome of a call that proves (or disproves) the sign-in. */
  async function recordAuth<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof JiraError && error.code === "jira_auth_required")
        await options
          .updateSettings((current) =>
            current
              ? {
                  ...current,
                  auth_error: error.message.slice(0, 1000),
                  auth_checked_at: new Date(now()).toISOString(),
                }
              : current,
          )
          .catch(() => undefined);
      throw error;
    }
  }

  async function startOAuth(params: { origin?: unknown }) {
    const settings = await options.readSettings();
    if (!settings?.site_url)
      throw new Error("Enter and save your Atlassian site URL first.");
    const redirectUri = callbackRedirectUri(params.origin);
    const endpoints = await discoverOAuthEndpoints(options.fetch);
    const clientId = await registerOAuthClient(
      options.fetch,
      endpoints.registration,
      redirectUri,
    );
    const { verifier, challenge } = pkcePair();
    const pending = options.states.add({
      state: randomToken(16),
      site_url: settings.site_url,
      client_id: clientId,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      token_endpoint: endpoints.token,
    });
    return { authorize_url: authorizeUrl(endpoints, pending, challenge) };
  }

  /** Completes the browser redirect (AC18). Returns the signed-in account. */
  async function completeOAuth(
    code: string | null,
    state: string | null,
  ): Promise<{ account: string; site_url: string }> {
    const pending = options.states.take(state);
    if (!pending) throw new Error("This sign-in link is invalid or has expired.");
    if (!code) throw new Error("Atlassian did not return an authorization code.");
    const settings = await options.readSettings();
    if (settings?.site_url !== pending.site_url)
      throw new Error("The Jira site changed during sign-in. Try again.");
    const token = await exchangeOAuthCode(options.fetch, pending, code);
    options.credentials.write({
      version: 1,
      site_url: pending.site_url,
      client_id: pending.client_id,
      token_endpoint: pending.token_endpoint,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: new Date(now() + token.expires_in * 1000).toISOString(),
    });
    resetClient();
    try {
      const resources = await client().accessibleResources();
      const cloud = resources.find(
        (resource) => resource.url.replace(/\/+$/, "") === pending.site_url,
      );
      if (!cloud)
        throw new Error(
          `${pending.site_url} is not one of the sites this Atlassian account can access.`,
        );
      const user = await client().userInfo();
      await options.updateSettings((current) => ({
        ...(current ?? defaultJiraSettings()),
        cloud_id: cloud.id,
        auth_account: user.name || user.email || undefined,
        auth_checked_at: new Date(now()).toISOString(),
        auth_error: undefined,
      }));
      return { account: user.name || user.email || "", site_url: pending.site_url };
    } catch (error) {
      // Signed in to the wrong site or the API failed: do not keep tokens
      // that look connected but fail every request.
      options.credentials.remove();
      resetClient();
      throw error;
    }
  }

  async function testConnection(): Promise<JiraConfigView> {
    const settings = await options.readSettings();
    if (!settings?.site_url || !hasCredentialsFor(settings)) throw notConfigured();
    try {
      const user = await client().userInfo();
      await options.updateSettings((current) =>
        current
          ? {
              ...current,
              auth_account: user.name || user.email || current.auth_account,
              auth_checked_at: new Date(now()).toISOString(),
              auth_error: undefined,
            }
          : current,
      );
    } catch (error) {
      await options.updateSettings((current) =>
        current
          ? {
              ...current,
              auth_checked_at: new Date(now()).toISOString(),
              auth_error: ((error as Error).message || "Connection failed").slice(0, 1000),
            }
          : current,
      );
    }
    return view();
  }

  async function search(params: {
    filters?: JiraFilters;
    jql?: unknown;
    page_token?: unknown;
  }): Promise<JiraSearchResult> {
    const settings = await connected();
    const raw = typeof params.jql === "string" ? params.jql.trim() : "";
    if (raw.length > JQL_MAX_LENGTH)
      throw new JiraError("JQL is too long.", "jira_bad_jql");
    const jql = raw || buildJql(params.filters ?? {});
    const result = await recordAuth(() =>
      client().search(
        settings.cloud_id,
        settings.site_url,
        jql,
        typeof params.page_token === "string" && params.page_token
          ? params.page_token
          : null,
        JIRA_PAGE_SIZE,
      ),
    );
    return { ...result, jql };
  }

  async function issue(params: { key?: unknown }): Promise<JiraIssue> {
    const key = typeof params.key === "string" ? params.key.trim().toUpperCase() : "";
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new Error("Enter an issue key like SDS-123.");
    const settings = await connected();
    return recordAuth(() => client().issue(settings.cloud_id, settings.site_url, key));
  }

  /**
   * Comments on the issue, then applies the transition whose target status
   * matches `status` (AC61). Throws on the first failure, saying how far it got.
   */
  async function syncBack(
    key: string,
    comment: string,
    status: string,
  ): Promise<void> {
    const settings = await connected();
    await recordAuth(() => client().addComment(settings.cloud_id, key, comment));
    const transitions = await client().transitions(settings.cloud_id, key);
    const target = transitions.find(
      (transition) => transition.to.toLowerCase() === status.toLowerCase(),
    );
    if (!target)
      throw new Error(
        `Commented on ${key}, but no transition leads to "${status}".`,
      );
    try {
      await client().transition(settings.cloud_id, key, target.id);
    } catch (error) {
      throw new Error(
        `Commented on ${key}, but the transition failed: ${(error as Error).message}`,
      );
    }
  }

  async function handle(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "bridge.jira.config.get":
        return view();
      case "bridge.jira.config.update": {
        const saved = await options.updateSettings((current) =>
          applyJiraConfigUpdate(
            current ?? defaultJiraSettings(),
            params as JiraConfigUpdate,
          ),
        );
        // A different site needs a fresh sign-in: drop the old site's tokens.
        const credentials = options.credentials.read();
        if (credentials && credentials.site_url !== saved?.site_url)
          options.credentials.remove();
        resetClient();
        return view();
      }
      case "bridge.jira.config.remove":
        options.credentials.remove();
        await options.updateSettings(() => undefined);
        resetClient();
        return view();
      case "bridge.jira.oauth.start":
        return startOAuth(params);
      case "bridge.jira.test":
        return testConnection();
      case "bridge.jira.projects": {
        const settings = await connected();
        return {
          projects: await recordAuth(() => client().projects(settings.cloud_id)),
        };
      }
      case "bridge.jira.statuses": {
        const project = typeof params.project === "string" ? params.project : "";
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(project)) return { statuses: [] };
        const settings = await connected();
        return {
          statuses: await recordAuth(() =>
            client().statuses(settings.cloud_id, project),
          ),
        };
      }
      case "bridge.jira.search":
        return search(params as Parameters<typeof search>[0]);
      case "bridge.jira.issue":
        return issue(params);
      default:
        throw new Error(`unknown Jira method: ${method}`);
    }
  }

  return { handle, completeOAuth, syncBack, view };
}
export type JiraService = ReturnType<typeof createJiraService>;
