import { describe, expect, test } from "bun:test";
import {
  ATLASSIAN_MCP_ENDPOINT,
  JiraError,
  adfToText,
  createJiraApi,
  createMcpClient,
  parseJiraIssue,
  parseSseReply,
} from "./mcp-client";
import type { FetchLike } from "./oauth";

type Handler = (message: any, headers: Record<string, string>) => Response;

function fakeMcp(handler: Handler) {
  const seen: { message: any; headers: Record<string, string> }[] = [];
  const fetcher: FetchLike = async (url, init) => {
    expect(url).toBe(ATLASSIAN_MCP_ENDPOINT);
    const headers = init?.headers as Record<string, string>;
    const message = JSON.parse(String(init?.body));
    seen.push({ message, headers });
    if (message.method === "initialize")
      return Response.json(
        { jsonrpc: "2.0", id: message.id, result: {} },
        { headers: { "mcp-session-id": "session-1" } },
      );
    if (message.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    return handler(message, headers);
  };
  return { fetcher, seen };
}

function toolReply(id: number, text: string, isError = false) {
  return Response.json({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError },
  });
}

describe("MCP client", () => {
  test("initializes once and reuses the session id", async () => {
    const { fetcher, seen } = fakeMcp((message) =>
      toolReply(message.id, "ok"),
    );
    const client = createMcpClient({
      fetch: fetcher,
      tokens: { token: async () => "t1", refresh: async () => "t2" },
    });
    expect(await client.callTool("a", {})).toBe("ok");
    expect(await client.callTool("b", {})).toBe("ok");
    expect(seen.filter((entry) => entry.message.method === "initialize"))
      .toHaveLength(1);
    const call = seen.find((entry) => entry.message.params?.name === "b")!;
    expect(call.headers["mcp-session-id"]).toBe("session-1");
    expect(call.headers.authorization).toBe("Bearer t1");
  });

  test("refreshes once on 401 and retries with the new token (AC19)", async () => {
    let refreshes = 0;
    const { fetcher, seen } = fakeMcp((message, headers) =>
      headers.authorization === "Bearer stale"
        ? new Response("unauthorized", { status: 401 })
        : toolReply(message.id, "fresh"),
    );
    const client = createMcpClient({
      fetch: async (url, init) => {
        const headers = init?.headers as Record<string, string>;
        if (
          headers.authorization === "Bearer stale" &&
          JSON.parse(String(init?.body)).method !== "tools/call"
        )
          return new Response("unauthorized", { status: 401 });
        return fetcher(url, init);
      },
      tokens: {
        token: async () => "stale",
        refresh: async (stale) => {
          expect(stale).toBe("stale");
          refreshes++;
          return "fresh";
        },
      },
    });
    expect(await client.callTool("x", {})).toBe("fresh");
    expect(refreshes).toBe(1);
    expect(
      seen.filter((entry) => entry.message.method === "tools/call"),
    ).toHaveLength(1);
  });

  test("a failed refresh reports that sign-in is required", async () => {
    const client = createMcpClient({
      fetch: async () => new Response("unauthorized", { status: 401 }),
      tokens: {
        token: async () => "stale",
        refresh: async () => {
          throw new Error("invalid_grant");
        },
      },
    });
    await expect(client.callTool("x", {})).rejects.toThrow(
      "Jira sign-in required",
    );
  });

  test("reads replies sent as server-sent events", async () => {
    const { fetcher } = fakeMcp(
      (message) =>
        new Response(
          `event: message\ndata: {"jsonrpc":"2.0","method":"note"}\n\nevent: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "sse" }] } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const client = createMcpClient({
      fetch: fetcher,
      tokens: { token: async () => "t", refresh: async () => "t" },
    });
    expect(await client.callTool("x", {})).toBe("sse");
  });

  test("tool errors mentioning JQL are reported as bad JQL", async () => {
    const { fetcher } = fakeMcp((message) =>
      toolReply(message.id, "Error in the JQL Query: bad", true),
    );
    const client = createMcpClient({
      fetch: fetcher,
      tokens: { token: async () => "t", refresh: async () => "t" },
    });
    const error = await client.callTool("x", {}).catch((value) => value);
    expect(error).toBeInstanceOf(JiraError);
    expect((error as JiraError).code).toBe("jira_bad_jql");
  });
});

test("parseSseReply ignores other messages", () => {
  expect(
    parseSseReply('data: {"jsonrpc":"2.0","id":2,"result":1}\n\n', 1),
  ).toBeNull();
});

test("adfToText flattens paragraphs", () => {
  expect(
    adfToText({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
        { type: "paragraph", content: [{ type: "text", text: "World" }] },
      ],
    }),
  ).toBe("Hello\nWorld\n");
});

test("parseJiraIssue maps fields and builds the browse URL", () => {
  expect(
    parseJiraIssue(
      {
        key: "SDS-1",
        fields: {
          summary: "S",
          description: "D",
          issuetype: { name: "Bug" },
          status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
          priority: { name: "Low" },
          assignee: { displayName: "Lloyd Leagas" },
          updated: "2026-11-01T10:00:00.000+0000",
        },
      },
      "https://acme.atlassian.net",
    ),
  ).toEqual({
    key: "SDS-1",
    summary: "S",
    description: "D",
    type: "Bug",
    status: "In Progress",
    status_category: "indeterminate",
    priority: "Low",
    assignee: { name: "Lloyd Leagas", initials: "LL" },
    updated_at: "2026-11-01T10:00:00.000+0000",
    url: "https://acme.atlassian.net/browse/SDS-1",
  });
});

test("search passes the page token and returns the next one", async () => {
  const calls: any[] = [];
  const api = createJiraApi({
    callTool: async (name, args) => {
      calls.push({ name, args });
      return JSON.stringify({
        issues: [{ key: "SDS-2", fields: {} }],
        nextPageToken: "p2",
        isLast: false,
      });
    },
  });
  const result = await api.search(
    "cloud",
    "https://acme.atlassian.net",
    "project = SDS",
    "p1",
    25,
  );
  expect(calls[0]).toEqual({
    name: "searchJiraIssuesUsingJql",
    args: { cloudId: "cloud", jql: "project = SDS", maxResults: 25, nextPageToken: "p1" },
  });
  expect(result.next_page_token).toBe("p2");
  expect(result.issues.map((issue) => issue.key)).toEqual(["SDS-2"]);
});
