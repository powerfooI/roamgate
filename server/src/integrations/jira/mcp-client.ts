import {
  JIRA_AUTH_ERROR_PREFIX,
  initialsFor,
  jiraBrowseUrl,
  type JiraIssue,
} from "../../../../shared/jira";
import type { FetchLike } from "./oauth";

// The Atlassian MCP OAuth token does not work for direct Jira REST calls, so
// Jira is reached through the MCP server's tools, as Kandev does
// (apps/backend/internal/jira/mcp_client.go). This is a minimal client for the
// MCP Streamable HTTP transport: JSON-RPC over POST, replies as JSON or SSE.
export const ATLASSIAN_MCP_ENDPOINT = "https://mcp.atlassian.com/v1/mcp/authv2";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_LIMIT = 8 << 20;

export class JiraError extends Error {
  constructor(
    message: string,
    readonly code:
      | "jira_not_configured"
      | "jira_auth_required"
      | "jira_bad_jql"
      | "jira_unavailable",
    readonly status?: number,
  ) {
    super(message);
  }
}

export function jiraAuthError(detail?: string): JiraError {
  return new JiraError(
    `${JIRA_AUTH_ERROR_PREFIX}: ${detail || "sign in to Atlassian again from Configuration › Integrations › Jira."}`,
    "jira_auth_required",
    401,
  );
}

export type McpTokenSource = {
  /** The current access token (refreshed first when near expiry). */
  token(): Promise<string>;
  /** Called once after a 401; resolves to a fresh token or rejects. */
  refresh(staleToken: string): Promise<string>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string;
  result?: any;
  error?: { code: number; message: string };
};

/** Extracts the JSON-RPC reply with the given id from an SSE body. */
export function parseSseReply(
  body: string,
  id: number,
): JsonRpcResponse | null {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      const message = JSON.parse(data) as JsonRpcResponse;
      if (message && message.id === id) return message;
    } catch {}
  }
  return null;
}

export function createMcpClient(options: {
  fetch: FetchLike;
  tokens: McpTokenSource;
  endpoint?: string;
  clientVersion?: string;
}) {
  const endpoint = options.endpoint ?? ATLASSIAN_MCP_ENDPOINT;
  let sessionId: string | null = null;
  let initialized: Promise<void> | null = null;
  let nextId = 1;

  async function post(
    token: string,
    message: Record<string, unknown>,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (message.method !== "initialize")
      headers["mcp-protocol-version"] = MCP_PROTOCOL_VERSION;
    let response: Response;
    try {
      response = await options.fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new JiraError(
        `Jira is unreachable: ${(error as Error).message}`,
        "jira_unavailable",
      );
    }
    if (response.status === 401 || response.status === 403)
      throw jiraAuthError();
    return response;
  }

  async function request(
    token: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    const id = nextId++;
    const response = await post(token, { jsonrpc: "2.0", id, method, params });
    if (response.status === 404 && sessionId) {
      sessionId = null;
      initialized = null;
      throw new JiraError("MCP session expired", "jira_unavailable", 404);
    }
    const text = await response.text();
    if (text.length > RESPONSE_LIMIT)
      throw new JiraError("Jira response too large", "jira_unavailable");
    if (!response.ok)
      throw new JiraError(
        `Jira request failed (${response.status})`,
        "jira_unavailable",
        response.status,
      );
    const session = response.headers.get("mcp-session-id");
    if (session) sessionId = session;
    const reply = (response.headers.get("content-type") ?? "").includes(
      "text/event-stream",
    )
      ? parseSseReply(text, id)
      : (() => {
          try {
            return JSON.parse(text) as JsonRpcResponse;
          } catch {
            return null;
          }
        })();
    if (!reply)
      throw new JiraError("Jira returned an invalid reply", "jira_unavailable");
    if (reply.error)
      throw new JiraError(
        `Jira error: ${reply.error.message}`,
        "jira_unavailable",
      );
    return reply.result;
  }

  async function initialize(token: string) {
    await request(token, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "roamgate", version: options.clientVersion ?? "1" },
    });
    // A notification: the server answers 202 with no body.
    await post(token, { jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async function callOnce(
    token: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    initialized ??= initialize(token).catch((error) => {
      initialized = null;
      throw error;
    });
    await initialized;
    const result = await request(token, "tools/call", {
      name,
      arguments: args,
    });
    const text =
      (Array.isArray(result?.content) ? result.content : []).find(
        (item: any) => item?.type === "text" && typeof item.text === "string",
      )?.text ?? "";
    if (result?.isError) {
      if (/jql/i.test(text))
        throw new JiraError(`Invalid JQL: ${text}`, "jira_bad_jql", 400);
      if (/unauthori[sz]ed|401/i.test(text)) throw jiraAuthError();
      throw new JiraError(
        text ? `Jira error: ${text}` : "Jira returned an error",
        "jira_unavailable",
      );
    }
    return text;
  }

  return {
    /** Calls a tool; on 401 refreshes once and retries once (AC19). */
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const token = await options.tokens.token();
      try {
        return await callOnce(token, name, args);
      } catch (error) {
        if (error instanceof JiraError && error.status === 404) {
          return callOnce(token, name, args);
        }
        if (!(error instanceof JiraError) || error.code !== "jira_auth_required")
          throw error;
        let fresh: string;
        try {
          fresh = await options.tokens.refresh(token);
        } catch (refreshError) {
          throw jiraAuthError((refreshError as Error).message);
        }
        sessionId = null;
        initialized = null;
        return callOnce(fresh, name, args);
      }
    },
    reset() {
      sessionId = null;
      initialized = null;
    },
  };
}
export type McpClient = ReturnType<typeof createMcpClient>;

/** Flattens Atlassian Document Format (or a plain string) to text. */
export function adfToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as { type?: string; text?: string; content?: unknown[] };
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const inner = (node.content ?? []).map(adfToText).join("");
  return ["paragraph", "heading", "listItem", "codeBlock", "blockquote"].includes(
    node.type ?? "",
  )
    ? `${inner}\n`
    : inner;
}

function parseJson(text: string, what: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new JiraError(`Jira returned invalid ${what}`, "jira_unavailable");
  }
}

function statusCategory(key: unknown): JiraIssue["status_category"] {
  return key === "done" ? "done" : key === "indeterminate" ? "indeterminate" : "new";
}

export function parseJiraIssue(raw: any, siteUrl: string): JiraIssue | null {
  if (!raw || typeof raw.key !== "string") return null;
  const fields = raw.fields ?? {};
  const assignee =
    typeof fields.assignee?.displayName === "string"
      ? {
          name: fields.assignee.displayName,
          initials: initialsFor(fields.assignee.displayName),
        }
      : null;
  return {
    key: raw.key,
    summary: typeof fields.summary === "string" ? fields.summary : "",
    description: adfToText(fields.description).trim(),
    type: typeof fields.issuetype?.name === "string" ? fields.issuetype.name : "",
    status: typeof fields.status?.name === "string" ? fields.status.name : "",
    status_category: statusCategory(fields.status?.statusCategory?.key),
    priority:
      typeof fields.priority?.name === "string" ? fields.priority.name : null,
    assignee,
    updated_at: typeof fields.updated === "string" ? fields.updated : "",
    url: jiraBrowseUrl(siteUrl, raw.key),
  };
}

export type JiraTransition = { id: string; name: string; to: string };

/** Jira operations used by Roamgate, as Atlassian MCP tool calls. */
export function createJiraApi(mcp: Pick<McpClient, "callTool">) {
  return {
    async userInfo(): Promise<{ name: string; email?: string }> {
      const body = parseJson(await mcp.callTool("atlassianUserInfo", {}), "user");
      return {
        name: typeof body?.name === "string" ? body.name : "",
        ...(typeof body?.email === "string" ? { email: body.email } : {}),
      };
    },
    async accessibleResources(): Promise<{ id: string; url: string }[]> {
      const body = parseJson(
        await mcp.callTool("getAccessibleAtlassianResources", {}),
        "resources",
      );
      return (Array.isArray(body) ? body : []).filter(
        (entry) => typeof entry?.id === "string" && typeof entry?.url === "string",
      );
    },
    async search(
      cloudId: string,
      siteUrl: string,
      jql: string,
      pageToken: string | null,
      maxResults: number,
    ): Promise<{ issues: JiraIssue[]; next_page_token: string | null }> {
      const args: Record<string, unknown> = { cloudId, jql, maxResults };
      if (pageToken) args.nextPageToken = pageToken;
      const body = parseJson(
        await mcp.callTool("searchJiraIssuesUsingJql", args),
        "search results",
      );
      const issues = (Array.isArray(body?.issues) ? body.issues : [])
        .map((issue: unknown) => parseJiraIssue(issue, siteUrl))
        .filter(Boolean) as JiraIssue[];
      const next =
        !body?.isLast && typeof body?.nextPageToken === "string" && body.nextPageToken
          ? body.nextPageToken
          : null;
      return { issues, next_page_token: next };
    },
    async issue(cloudId: string, siteUrl: string, key: string): Promise<JiraIssue> {
      const issue = parseJiraIssue(
        parseJson(
          await mcp.callTool("getJiraIssue", { cloudId, issueIdOrKey: key }),
          "issue",
        ),
        siteUrl,
      );
      if (!issue) throw new JiraError(`Issue ${key} was not found`, "jira_unavailable");
      return issue;
    },
    async projects(cloudId: string): Promise<{ key: string; name: string }[]> {
      const body = parseJson(
        await mcp.callTool("getVisibleJiraProjects", { cloudId }),
        "projects",
      );
      return (Array.isArray(body?.values) ? body.values : [])
        .filter((project: any) => typeof project?.key === "string")
        .map((project: any) => ({
          key: project.key,
          name: typeof project.name === "string" ? project.name : project.key,
        }));
    },
    async statuses(cloudId: string, project: string): Promise<string[]> {
      const body = parseJson(
        await mcp.callTool("getJiraProjectIssueTypesMetadata", {
          cloudId,
          projectIdOrKey: project,
        }),
        "statuses",
      );
      const names = new Set<string>();
      for (const type of Array.isArray(body) ? body : [])
        for (const status of Array.isArray(type?.statuses) ? type.statuses : [])
          if (typeof status?.name === "string") names.add(status.name);
      return [...names];
    },
    async transitions(cloudId: string, key: string): Promise<JiraTransition[]> {
      const body = parseJson(
        await mcp.callTool("getTransitionsForJiraIssue", {
          cloudId,
          issueIdOrKey: key,
        }),
        "transitions",
      );
      return (Array.isArray(body?.transitions) ? body.transitions : [])
        .filter((entry: any) => typeof entry?.id === "string")
        .map((entry: any) => ({
          id: entry.id,
          name: typeof entry.name === "string" ? entry.name : "",
          to: typeof entry.to?.name === "string" ? entry.to.name : "",
        }));
    },
    async transition(cloudId: string, key: string, transitionId: string) {
      await mcp.callTool("transitionJiraIssue", {
        cloudId,
        issueIdOrKey: key,
        transition: { id: transitionId },
      });
    },
    async addComment(cloudId: string, key: string, body: string) {
      await mcp.callTool("addCommentToJiraIssue", {
        cloudId,
        issueIdOrKey: key,
        commentBody: body,
      });
    },
  };
}
export type JiraApi = ReturnType<typeof createJiraApi>;
