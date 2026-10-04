import { describe, expect, test } from "bun:test";
import {
  ConnectionRoutingError,
  createConnectionReplyPublisher,
  createLegacyRoutingLogger,
  resolveReadyConnection,
  serializeConnectionEnvelope,
  serializeHerdrEventEnvelope,
  validateConnectionId,
} from "./protocol";
import {
  isConnectionRpcEnvelope,
  resolveRpcRoute,
  type ConnectionRpcRequest,
} from "./rpc-routing";

type FakeRuntime = {
  id: string;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
};

function registry(
  entries: Record<string, FakeRuntime | null>,
  defaultId = "a",
) {
  return {
    defaultId: () => defaultId,
    has: (connectionId: string) => Object.hasOwn(entries, connectionId),
    readyRuntimeLease: (connectionId: string) => {
      const runtime = entries[connectionId] ?? null;
      return runtime
        ? {
            connectionId,
            generation: 1,
            runtime,
            isCurrent: () => entries[connectionId] === runtime,
          }
        : null;
    },
  };
}

function request(
  method: string,
  connectionId?: unknown,
  connectionGeneration?: unknown,
): ConnectionRpcRequest {
  return {
    id: `${method}-id`,
    method,
    params: { resource_id: "same-id" },
    ...(connectionId === undefined ? {} : { connection_id: connectionId }),
    ...(connectionGeneration === undefined
      ? {}
      : { connection_generation: connectionGeneration }),
  };
}

describe("connection protocol routing", () => {
  test("rejects scalar, array, and null RPC envelopes", () => {
    for (const value of [null, [], "rpc", 42, true]) {
      expect(isConnectionRpcEnvelope(value)).toBe(false);
    }
    expect(isConnectionRpcEnvelope({ id: "rpc" })).toBe(true);
  });

  test("keeps bridge-global methods unscoped and rejects misleading identity fields", () => {
    const routes = registry({});
    for (const method of ["bridge.ping", "bridge.status", "connections.list"]) {
      expect(
        resolveRpcRoute({
          request: request(method),
          registry: routes,
          legacyClient: {},
        }),
      ).toEqual({ scope: "bridge" });
      expect(() =>
        resolveRpcRoute({
          request: request(method, { malformed: true }, { malformed: true }),
          registry: routes,
          legacyClient: {},
        }),
      ).toThrow("must not include connection identity");
    }
  });

  test("routes duplicate resource ids and terminal operations only to the explicit runtime", () => {
    const a: FakeRuntime = { id: "a", calls: [] };
    const b: FakeRuntime = { id: "b", calls: [] };
    const routes = registry({ a, b });

    for (const [method, connectionId] of [
      ["workspace.list", "a"],
      ["pane.read", "b"],
      ["terminal.input", "a"],
      ["terminal.resize", "b"],
      ["terminal.scroll", "a"],
    ] as const) {
      const rpc = request(method, connectionId);
      const route = resolveRpcRoute({
        request: rpc,
        registry: routes,
        legacyClient: {},
      });
      expect(route.scope).toBe("connection");
      if (route.scope === "connection") {
        route.runtime.calls.push({ method, params: rpc.params ?? {} });
        expect(route.connectionId).toBe(connectionId);
      }
    }

    expect(a.calls.map((call) => call.method)).toEqual([
      "workspace.list",
      "terminal.input",
      "terminal.scroll",
    ]);
    expect(b.calls.map((call) => call.method)).toEqual([
      "pane.read",
      "terminal.resize",
    ]);
    expect(a.calls.every((call) => call.params.resource_id === "same-id")).toBe(
      true,
    );
    expect(b.calls.every((call) => call.params.resource_id === "same-id")).toBe(
      true,
    );
  });

  test("uses only omitted ids for legacy default fallback and bounds warnings", () => {
    const a: FakeRuntime = { id: "a", calls: [] };
    const logs: string[] = [];
    const legacyLogger = createLegacyRoutingLogger({
      log: (message) => logs.push(message),
    });
    const client = {};
    const routes = registry({ a });

    for (const method of [
      "terminal.input",
      "terminal.resize",
      "workspace.list",
      "pane.list",
    ]) {
      const route = resolveRpcRoute({
        request: request(method),
        registry: routes,
        legacyClient: client,
        legacyLogger,
      });
      expect(route).toMatchObject({
        scope: "connection",
        connectionId: "a",
        runtime: a,
        usedLegacyDefault: true,
      });
    }

    resolveRpcRoute({
      request: request("workspace.list"),
      registry: routes,
      legacyClient: {},
      legacyLogger,
    });
    resolveRpcRoute({
      request: request("terminal.input"),
      registry: routes,
      legacyClient: {},
      legacyLogger,
    });
    for (const endpoint of ["file-download", "file-upload"]) {
      legacyLogger.http(endpoint, "a");
      legacyLogger.http(endpoint, "a");
    }

    expect(logs).toHaveLength(6);
    expect(
      logs.filter((line) => line.includes("deprecated unscoped RPC")),
    ).toHaveLength(2);
    expect(
      logs.filter((line) => line.includes("generation-unscoped RPC")),
    ).toHaveLength(2);
    expect(logs[4]).toContain("endpoint=file-download");
    expect(logs[5]).toContain("endpoint=file-upload");
  });

  test("rejects malformed, unknown, and not-ready explicit ids without fallback", () => {
    const ready: FakeRuntime = { id: "a", calls: [] };
    const routes = registry({ a: ready, waiting: null });

    for (const value of [null, "", "../a", "a/b", {}, "x".repeat(129)]) {
      expect(() => resolveReadyConnection(routes, value)).toThrow(
        "invalid connection_id",
      );
    }
    const logs: string[] = [];
    expect(() =>
      resolveRpcRoute({
        request: request("workspace.list", "forged\nlog"),
        registry: routes,
        legacyClient: {},
        legacyLogger: createLegacyRoutingLogger({
          log: (message) => logs.push(message),
        }),
      }),
    ).toThrow("invalid connection_id");
    expect(logs).toEqual([]);

    try {
      resolveReadyConnection(routes, "missing", 7);
      throw new Error("expected unknown connection failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectionRoutingError);
      expect(error).toMatchObject({
        status: 404,
        connectionId: "missing",
        connectionGeneration: 7,
        message: "unknown connection: missing",
      });
    }
    try {
      resolveReadyConnection(routes, "waiting");
      throw new Error("expected not-ready connection failure");
    } catch (error) {
      expect(error).toMatchObject({
        status: 503,
        connectionId: "waiting",
        message: "connection is not ready: waiting",
      });
    }
    expect(resolveReadyConnection(routes, undefined).runtime).toBe(ready);
  });

  test("validates expected runtime generations before dispatch", () => {
    const ready: FakeRuntime = { id: "a", calls: [] };
    const routes = registry({ a: ready });
    expect(resolveReadyConnection(routes, "a", 1)).toMatchObject({
      connectionId: "a",
      generation: 1,
      runtime: ready,
    });
    for (const value of [null, "1", -1, 1.5, Number.NaN]) {
      try {
        resolveReadyConnection(routes, "a", value);
        throw new Error("expected malformed generation failure");
      } catch (error) {
        expect(error).toMatchObject({
          status: 400,
          connectionId: "a",
          message: "invalid connection_generation",
        });
      }
    }
    try {
      resolveRpcRoute({
        request: request("pane.close", "a", 2),
        registry: routes,
        legacyClient: {},
      });
      throw new Error("expected stale generation failure");
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        connectionId: "a",
        connectionGeneration: 2,
        message: "connection generation changed: a",
      });
    }
    expect(ready.calls).toEqual([]);
    expect(
      resolveRpcRoute({
        request: request("workspace.list", "a"),
        registry: routes,
        legacyClient: {},
      }),
    ).toMatchObject({ scope: "connection", generation: 1 });
  });

  test("keeps delayed responses tagged with the originally resolved connection", () => {
    const a: FakeRuntime = { id: "a", calls: [] };
    const b: FakeRuntime = { id: "b", calls: [] };
    let defaultId = "a";
    const routes = {
      defaultId: () => defaultId,
      has: (connectionId: string) =>
        connectionId === "a" || connectionId === "b",
      readyRuntimeLease: (connectionId: string) => {
        const runtime =
          connectionId === "a" ? a : connectionId === "b" ? b : null;
        return runtime
          ? {
              connectionId,
              generation: 1,
              runtime,
              isCurrent: () =>
                (connectionId === "a" ? a : connectionId === "b" ? b : null) ===
                runtime,
            }
          : null;
      },
    };
    const route = resolveRpcRoute({
      request: request("workspace.list"),
      registry: routes,
      legacyClient: {},
    });
    if (route.scope !== "connection") throw new Error("expected route");

    defaultId = "b";
    expect(route.isCurrent()).toBe(true);
    const delayedResponse = JSON.parse(
      serializeConnectionEnvelope(route.connectionId, {
        id: "delayed",
        result: { workspace_id: "same-id" },
      }),
    );
    expect(delayedResponse).toMatchObject({
      connection_id: "a",
      result: { workspace_id: "same-id" },
    });
  });

  test("invalidates a resolved lease when the same connection id is replaced", () => {
    const oldRuntime: FakeRuntime = { id: "a-old", calls: [] };
    const replacement: FakeRuntime = { id: "a-new", calls: [] };
    const entries: Record<string, FakeRuntime | null> = { a: oldRuntime };
    const route = resolveRpcRoute({
      request: request("workspace.list", "a"),
      registry: registry(entries),
      legacyClient: {},
    });
    if (route.scope !== "connection") throw new Error("expected route");

    expect(route.generation).toBe(1);
    expect(route.isCurrent()).toBe(true);
    const messages: string[] = [];
    const publisher = createConnectionReplyPublisher({
      connectionId: route.connectionId,
      generation: route.generation,
      requestId: "delayed",
      isCurrent: route.isCurrent,
      send: (payload) => {
        messages.push(payload);
        return true;
      },
    });

    entries.a = replacement;
    expect(route.isCurrent()).toBe(false);
    expect(
      publisher.send(
        { id: "delayed", result: { workspace_id: "same" } },
        "workspace-list",
      ),
    ).toBe(true);
    expect(
      publisher.send(
        { id: "delayed", result: { workspace_id: "same" } },
        "workspace-list",
      ),
    ).toBe(false);
    expect(messages.map((message) => JSON.parse(message))).toEqual([
      {
        connection_id: "a",
        connection_generation: 1,
        id: "delayed",
        error: { message: "connection changed during request" },
      },
    ]);
  });

  test("tags responses, errors, events, terminal frames, and clipboard pushes", () => {
    const messages = [
      serializeConnectionEnvelope("a", { id: "1", result: { same: "id" } }),
      serializeConnectionEnvelope("a", {
        id: "2",
        error: { message: "failed" },
      }),
      serializeHerdrEventEnvelope("a", {
        event: "workspace.updated",
        data: { workspace_id: "same" },
      }),
      serializeConnectionEnvelope("a", {
        terminal: { terminal_id: "same", bytes: "YQ==" },
      }),
      serializeConnectionEnvelope("a", {
        terminal_clipboard: { terminal_id: "same", data: "YQ==" },
      }),
    ].map((value) => JSON.parse(value));

    expect(messages.every((message) => message.connection_id === "a")).toBe(
      true,
    );
    expect(messages[0].result).toEqual({ same: "id" });
    expect(messages[1].error.message).toBe("failed");
    expect(messages[2]).toMatchObject({
      connection_id: "a",
      event: "workspace.updated",
      data: { workspace_id: "same" },
    });
    expect(messages[3].terminal.terminal_id).toBe("same");
    expect(messages[4].terminal_clipboard.terminal_id).toBe("same");
  });

  test("keeps old web consumers compatible with additive top-level identity", () => {
    const response = JSON.parse(
      serializeConnectionEnvelope("legacy-default", {
        id: "rpc",
        result: { ok: true },
      }),
    );
    const terminalMessage = JSON.parse(
      serializeConnectionEnvelope("legacy-default", {
        terminal: {
          terminal_id: "term",
          width: 80,
          height: 24,
          full: true,
          bytes: "",
        },
      }),
    );

    // This mirrors the current web/src/api.ts access pattern: it reads result
    // and nested terminal payloads and ignores unknown top-level properties.
    expect(response.result).toEqual({ ok: true });
    expect(terminalMessage.terminal).toMatchObject({
      terminal_id: "term",
      width: 80,
      height: 24,
    });
  });

  test("validates ids and protects the reserved envelope field", () => {
    expect(validateConnectionId("remote.dev:1_default")).toBe(
      "remote.dev:1_default",
    );
    expect(() =>
      serializeConnectionEnvelope("a", { connection_id: "b", result: {} }),
    ).toThrow("reserved connection_id");
    expect(() =>
      serializeConnectionEnvelope(
        "a",
        { connection_generation: 2, result: {} },
        1,
      ),
    ).toThrow("reserved connection_generation");
    for (const field of [
      "connection_id",
      "connection_generation",
      "hello",
      "id",
      "result",
      "error",
      "control",
      "terminal",
      "terminal_clipboard",
      "assistant",
    ]) {
      expect(() =>
        serializeHerdrEventEnvelope("a", {
          event: "workspace.updated",
          data: {},
          [field]: field === "hello" ? true : "forged",
        }),
      ).toThrow(`reserved ${field}`);
    }
  });
});
