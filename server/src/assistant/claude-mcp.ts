import type { AssistantSource } from "../../../shared/assistant";
import { randomUUID } from "node:crypto";
import { surfaceAssistantUserError } from "./errors";
import type { RangerTool } from "./ranger-tools";

/** The MCP server name: Claude Code calls its tools `mcp__ranger__<name>`. */
export const RANGER_MCP_SERVER = "ranger";
const MASKED_TOOL_ERROR =
  "Workspace tool unavailable, stale, or outside the authorized scope.";

/** One Claude Code turn's view of Ranger's tools. */
export type RangerMcpTurn = {
  tools: RangerTool[];
  /** Ends the tool calls still running when the turn stops. */
  signal: AbortSignal;
  /** Sources a tool cited, as it returns them. */
  sources?(sources: AssistantSource[]): void;
};

export type RangerMcpLease = {
  /** The `--mcp-config` value naming this turn's server. */
  config: string;
  close(): void;
};

type Listener = { url: string; stop(): void };
type Listen = (fetch: (req: Request) => Promise<Response>) => Listener;

/**
 * Ranger's tools for Claude Code: a Streamable HTTP MCP server on loopback,
 * plain HTTP whatever the bridge serves, so the CLI needs no certificate.
 * Each turn gets its own bearer token, valid only while the turn runs: a
 * call from a turn that ended, or from anything else, is refused.
 */
export function createRangerMcp(
  listen: Listen = (fetch) => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
    return {
      url: `http://127.0.0.1:${server.port}/mcp`,
      stop: () => void server.stop(true),
    };
  },
) {
  const turns = new Map<string, RangerMcpTurn>();
  let listener: Listener | null = null;

  async function call(turn: RangerMcpTurn, message: Record<string, unknown>) {
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion:
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: RANGER_MCP_SERVER, version: "1" },
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: turn.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.parameters,
          })),
        };
      case "tools/call": {
        const tool = turn.tools.find((entry) => entry.name === params.name);
        if (!tool) throw new RpcError(-32602, "Unknown tool");
        try {
          turn.signal.throwIfAborted();
          const result = await tool.call(params.arguments ?? {}, turn.signal);
          const sources = (result.sources ?? []) as AssistantSource[];
          if (sources.length) turn.sources?.(sources);
          return {
            content: [
              {
                type: "text",
                text: sources.length
                  ? `${result.text}\n\nSources: ${JSON.stringify(sources)}`
                  : result.text,
              },
            ],
          };
        } catch (error) {
          let text = MASKED_TOOL_ERROR;
          try {
            surfaceAssistantUserError(error, MASKED_TOOL_ERROR);
          } catch (surfaced) {
            text = (surfaced as Error).message;
          }
          return { content: [{ type: "text", text }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, "Method not found");
    }
  }

  async function handle(req: Request): Promise<Response> {
    if (req.method !== "POST")
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    const token = /^Bearer (.+)$/.exec(
      req.headers.get("authorization") ?? "",
    )?.[1];
    const turn = token ? turns.get(token) : undefined;
    if (!turn) return new Response(null, { status: 401 });
    let message: unknown;
    try {
      message = await req.json();
    } catch {
      return Response.json(rpcError(null, -32700, "Parse error"));
    }
    if (!message || typeof message !== "object" || Array.isArray(message))
      return Response.json(rpcError(null, -32600, "Invalid request"));
    const request = message as Record<string, unknown>;
    // Notifications get no answer.
    if (request.id === undefined) return new Response(null, { status: 202 });
    try {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: await call(turn, request),
      });
    } catch (error) {
      return Response.json(
        error instanceof RpcError
          ? rpcError(request.id, error.code, error.message)
          : rpcError(request.id, -32603, "Internal error"),
      );
    }
  }

  return {
    /** Serves `turn`'s tools until the lease is closed. */
    open(turn: RangerMcpTurn): RangerMcpLease {
      listener ??= listen(handle);
      const token = randomUUID();
      turns.set(token, turn);
      return {
        config: JSON.stringify({
          mcpServers: {
            [RANGER_MCP_SERVER]: {
              type: "http",
              url: listener.url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        }),
        close: () => {
          turns.delete(token);
        },
      };
    },
    /** For tests: the handler the listener serves. */
    handle,
    stop() {
      turns.clear();
      listener?.stop();
      listener = null;
    },
  };
}
export type RangerMcp = ReturnType<typeof createRangerMcp>;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
