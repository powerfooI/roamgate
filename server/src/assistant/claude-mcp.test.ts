import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { createRangerMcp } from "./claude-mcp";
import { AssistantUserError } from "./errors";
import type { RangerTool } from "./ranger-tools";

function tool(name: string, call: RangerTool["call"]): RangerTool {
  return {
    name,
    description: `The ${name} tool`,
    parameters: Type.Object({ workspace_id: Type.String() }),
    replay: "safe",
    sequential: false,
    call,
  };
}

function setup(tools: RangerTool[]) {
  const mcp = createRangerMcp(() => ({
    url: "http://127.0.0.1:1/mcp",
    stop: () => {},
  }));
  const sources: unknown[] = [];
  const controller = new AbortController();
  const lease = mcp.open({
    tools,
    signal: controller.signal,
    sources: (found) => sources.push(...found),
  });
  const config = JSON.parse(lease.config);
  const server = config.mcpServers.ranger;
  const rpc = async (
    body: unknown,
    authorization = server.headers.Authorization,
  ) => {
    const response = await mcp.handle(
      new Request(server.url, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    return {
      status: response.status,
      body: response.status === 200 ? await response.json() : null,
    };
  };
  return { mcp, lease, server, rpc, sources, controller };
}

describe("Ranger's MCP server for Claude Code", () => {
  test("lists the turn's tools and runs them, passing their sources", async () => {
    const { rpc, server, sources } = setup([
      tool("workspace_status", async (params) => ({
        text: `status of ${(params as { workspace_id: string }).workspace_id}`,
        sources: [{ id: "s1" }],
      })),
    ]);
    expect(server.type).toBe("http");
    expect(server.headers.Authorization).toMatch(/^Bearer [0-9a-f-]{36}$/);
    const init = await rpc({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-11-25" },
    });
    expect(init.body.result.protocolVersion).toBe("2025-11-25");
    expect(
      (await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }))
        .status,
    ).toBe(202);
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list.body.result.tools).toEqual([
      {
        name: "workspace_status",
        description: "The workspace_status tool",
        inputSchema: expect.objectContaining({ type: "object" }),
      },
    ]);
    const called = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "workspace_status", arguments: { workspace_id: "w7" } },
    });
    expect(called.body.result).toEqual({
      content: [
        { type: "text", text: 'status of w7\n\nSources: [{"id":"s1"}]' },
      ],
    });
    expect(sources).toEqual([{ id: "s1" }]);
  });

  test("refuses other tokens, and the turn's own once it ended", async () => {
    const { rpc, lease } = setup([
      tool("workspace_status", async () => ({ text: "x" })),
    ]);
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect((await rpc(list, "Bearer nope")).status).toBe(401);
    expect((await rpc(list, "")).status).toBe(401);
    lease.close();
    expect((await rpc(list)).status).toBe(401);
  });

  test("tool errors show their safe message, any other is masked", async () => {
    const { rpc } = setup([
      tool("safe", async () => {
        throw new AssistantUserError("That workspace is not allowed.");
      }),
      tool("leaky", async () => {
        throw new Error("connect ENOENT /secret/socket");
      }),
    ]);
    const call = (name: string) =>
      rpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name, arguments: { workspace_id: "w1" } },
      });
    expect((await call("safe")).body.result).toEqual({
      content: [{ type: "text", text: "That workspace is not allowed." }],
      isError: true,
    });
    expect((await call("leaky")).body.result).toEqual({
      content: [
        {
          type: "text",
          text: "Workspace tool unavailable, stale, or outside the authorized scope.",
        },
      ],
      isError: true,
    });
    expect((await call("missing")).body.error.code).toBe(-32602);
  });

  test("a stopped turn runs no more tools", async () => {
    let ran = 0;
    const { rpc, controller } = setup([
      tool("workspace_status", async () => {
        ran += 1;
        return { text: "x" };
      }),
    ]);
    controller.abort();
    const called = await rpc({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "workspace_status", arguments: { workspace_id: "w1" } },
    });
    expect(called.body.result.isError).toBe(true);
    expect(ran).toBe(0);
  });
});
