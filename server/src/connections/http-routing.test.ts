import { describe, expect, test } from "bun:test";
import {
  connectionRoutingErrorResponse,
  parseConnectionHttpRoute,
  publishConnectionHttpResponse,
  rawRequestPathname,
  resolveConnectionHttpRoute,
  withConnectionResponseHeader,
  type ConnectionHttpEndpoint,
} from "./http-routing";
import { ConnectionRoutingError, createLegacyRoutingLogger } from "./protocol";

type Runtime = { id: string };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function registry(entries: Record<string, Runtime | null>) {
  return {
    defaultId: () => "legacy-default",
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

const endpointCases: Array<{
  endpoint: ConnectionHttpEndpoint;
  suffix: string;
  legacyPath: string;
  method: string;
}> = [
  {
    endpoint: "herdr-info",
    suffix: "/herdr-info",
    legacyPath: "/api/herdr-info",
    method: "GET",
  },
  {
    endpoint: "upload-image",
    suffix: "/upload-image",
    legacyPath: "/api/upload-image",
    method: "POST",
  },
  {
    endpoint: "terminal-upload",
    suffix: "/terminal-upload",
    legacyPath: "/api/terminal-upload",
    method: "POST",
  },
  {
    endpoint: "agent-session-download",
    suffix: "/agent-session/download",
    legacyPath: "/api/agent-session/download",
    method: "GET",
  },
  {
    endpoint: "agent-session-atif",
    suffix: "/agent-session/atif",
    legacyPath: "/api/agent-session/atif",
    method: "GET",
  },
  {
    endpoint: "file-download",
    suffix: "/file/download",
    legacyPath: "/api/file/download",
    method: "GET",
  },
  {
    endpoint: "file-upload",
    suffix: "/file/upload",
    legacyPath: "/api/file/upload",
    method: "POST",
  },
  {
    endpoint: "file-delete",
    suffix: "/file/delete",
    legacyPath: "/api/file/delete",
    method: "POST",
  },
];

describe("connection HTTP routing", () => {
  test("parses every scoped endpoint and legacy alias", () => {
    for (const testCase of endpointCases) {
      expect(
        parseConnectionHttpRoute(
          `/api/connections/remote-dev${testCase.suffix}`,
          testCase.method,
        ),
      ).toEqual({
        kind: "connection",
        endpoint: testCase.endpoint,
        requestedConnectionId: "remote-dev",
        legacy: false,
      });
      expect(
        parseConnectionHttpRoute(testCase.legacyPath, testCase.method),
      ).toEqual({
        kind: "connection",
        endpoint: testCase.endpoint,
        requestedConnectionId: undefined,
        legacy: true,
      });
    }
    expect(parseConnectionHttpRoute("/api/health", "GET")).toBeNull();
  });

  test("preserves raw absolute paths before URL dot-segment normalization", () => {
    expect(
      rawRequestPathname(
        "http://127.0.0.1:8787/api/connections/../file/download?x=1",
      ),
    ).toBe("/api/connections/../file/download");
    expect(
      rawRequestPathname(
        "https://example.test/api/connections/%2e%2e/file/download#fragment",
      ),
    ).toBe("/api/connections/%2e%2e/file/download");
    expect(rawRequestPathname("http://example.test")).toBe("/");
    expect(rawRequestPathname("/api/herdr-info?x=1")).toBe("/api/herdr-info");
  });

  test("decodes safe ids and rejects malformed encoding and traversal", () => {
    expect(
      parseConnectionHttpRoute(
        "/api/connections/remote%2Ddev/file/download",
        "GET",
      ),
    ).toMatchObject({
      kind: "connection",
      requestedConnectionId: "remote-dev",
    });

    for (const pathname of [
      "/api/connections/%ZZ/file/download",
      "/api/connections/%2F/file/download",
      "/api/connections/%2e%2e/file/download",
      "/api/connections/../file/download",
      "/api/connections/remote%252Fdev/file/download",
      "/api/connections//file/download",
    ]) {
      expect(parseConnectionHttpRoute(pathname, "GET")).toMatchObject({
        kind: "error",
        error: { status: 400 },
      });
    }
  });

  test("rejects unknown endpoint suffixes and wrong methods", () => {
    expect(
      parseConnectionHttpRoute(
        "/api/connections/remote-dev/file/unknown",
        "GET",
      ),
    ).toMatchObject({ kind: "error", error: { status: 404 } });
    expect(
      parseConnectionHttpRoute(
        "/api/connections/remote-dev/file/download",
        "POST",
      ),
    ).toMatchObject({
      kind: "error",
      error: { status: 405, connectionId: "remote-dev" },
    });
    expect(
      parseConnectionHttpRoute("/api/file/download", "POST"),
    ).toMatchObject({ kind: "error", error: { status: 405 } });
  });

  test("resolves explicit and legacy routes without cross-runtime fallback", () => {
    const legacy: Runtime = { id: "legacy-default" };
    const remote: Runtime = { id: "remote-dev" };
    const routes = registry({
      "legacy-default": legacy,
      "remote-dev": remote,
      waiting: null,
    });
    const logs: string[] = [];
    const legacyLogger = createLegacyRoutingLogger({
      log: (message) => logs.push(message),
    });

    const scoped = parseConnectionHttpRoute(
      "/api/connections/remote-dev/file/download",
      "GET",
    );
    const legacyRoute = parseConnectionHttpRoute("/api/file/download", "GET");
    if (scoped?.kind !== "connection" || legacyRoute?.kind !== "connection") {
      throw new Error("expected connection routes");
    }
    expect(
      resolveConnectionHttpRoute({
        route: scoped,
        requestedGeneration: 1,
        registry: routes,
        legacyLogger,
      }),
    ).toMatchObject({ connectionId: "remote-dev", runtime: remote });
    expect(
      resolveConnectionHttpRoute({
        route: legacyRoute,
        registry: routes,
        legacyLogger,
      }),
    ).toMatchObject({
      connectionId: "legacy-default",
      runtime: legacy,
      usedLegacyDefault: true,
    });
    resolveConnectionHttpRoute({
      route: legacyRoute,
      registry: routes,
      legacyLogger,
    });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("unscoped HTTP");
    expect(logs[1]).toContain("generation-unscoped HTTP");

    for (const [connectionId, status] of [
      ["missing", 404],
      ["waiting", 503],
    ] as const) {
      const route = parseConnectionHttpRoute(
        `/api/connections/${connectionId}/herdr-info`,
        "GET",
      );
      if (route?.kind !== "connection") throw new Error("expected route");
      try {
        resolveConnectionHttpRoute({ route, registry: routes });
        throw new Error("expected routing failure");
      } catch (error) {
        expect(error).toMatchObject({ status, connectionId });
      }
    }
  });

  test("rejects malformed and stale HTTP generations before dispatch", () => {
    const runtime: Runtime = { id: "remote" };
    const routes = registry({ "remote-dev": runtime });
    const route = parseConnectionHttpRoute(
      "/api/connections/remote-dev/herdr-info",
      "GET",
    );
    if (route?.kind !== "connection") throw new Error("expected route");
    expect(
      resolveConnectionHttpRoute({
        route,
        requestedGeneration: 1,
        registry: routes,
      }),
    ).toMatchObject({ runtime, generation: 1 });
    for (const requestedGeneration of ["1", -1, 1.5]) {
      expect(() =>
        resolveConnectionHttpRoute({
          route,
          requestedGeneration,
          registry: routes,
        }),
      ).toThrow("invalid connection_generation");
    }
    try {
      resolveConnectionHttpRoute({
        route,
        requestedGeneration: 2,
        registry: routes,
      });
      throw new Error("expected stale generation failure");
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        connectionId: "remote-dev",
        connectionGeneration: 2,
      });
    }
  });

  test("preserves JSON, binary, and streaming responses while adding identity", async () => {
    const json = withConnectionResponseHeader(
      Response.json({ ok: true }, { status: 201 }),
      "remote-dev",
      7,
    );
    expect(json.status).toBe(201);
    expect(json.headers.get("X-Herdr-Connection-Id")).toBe("remote-dev");
    expect(json.headers.get("X-Herdr-Connection-Generation")).toBe("7");
    expect(await json.json()).toEqual({ ok: true });

    const binary = withConnectionResponseHeader(
      new Response(new Uint8Array([0, 1, 2, 255]), {
        headers: { "content-type": "application/octet-stream" },
      }),
      "remote-dev",
    );
    expect(binary.headers.get("content-type")).toBe("application/octet-stream");
    expect(Array.from(new Uint8Array(await binary.arrayBuffer()))).toEqual([
      0, 1, 2, 255,
    ]);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("stream"));
        await Bun.sleep(1);
        controller.enqueue(new TextEncoder().encode("ed"));
        controller.close();
      },
    });
    const streamed = withConnectionResponseHeader(
      new Response(stream, {
        status: 206,
        statusText: "Partial Content",
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="session.jsonl"',
          "content-range": "bytes 0-7/8",
          "accept-ranges": "bytes",
          "cache-control": "private, no-store",
        },
      }),
      "remote-dev",
    );
    expect(streamed.status).toBe(206);
    expect(streamed.statusText).toBe("Partial Content");
    expect(streamed.headers.get("X-Herdr-Connection-Id")).toBe("remote-dev");
    expect(streamed.headers.get("content-disposition")).toContain(
      "session.jsonl",
    );
    expect(streamed.headers.get("content-range")).toBe("bytes 0-7/8");
    expect(streamed.headers.get("accept-ranges")).toBe("bytes");
    expect(streamed.headers.get("cache-control")).toBe("private, no-store");
    expect(await streamed.text()).toBe("streamed");
  });

  test("suppresses a delayed response after same-id runtime replacement", async () => {
    const oldRuntime: Runtime = { id: "old" };
    const replacement: Runtime = { id: "replacement" };
    const entries: Record<string, Runtime | null> = {
      "legacy-default": oldRuntime,
    };
    const route = parseConnectionHttpRoute("/api/herdr-info", "GET");
    if (route?.kind !== "connection") throw new Error("expected route");
    const resolved = resolveConnectionHttpRoute({
      route,
      registry: registry(entries),
    });
    expect(resolved.isCurrent()).toBe(true);

    entries["legacy-default"] = replacement;
    const response = publishConnectionHttpResponse(
      resolved,
      Response.json({ server_id: "old" }),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("X-Herdr-Connection-Id")).toBe(
      "legacy-default",
    );
    expect(response.headers.get("X-Herdr-Connection-Generation")).toBe("1");
    expect(await response.json()).toEqual({
      error: "connection changed during request",
    });
  });

  test("cancels a streaming response when its lease becomes stale", async () => {
    const secondChunk = deferred();
    const cancellations: unknown[] = [];
    let current = true;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
      },
      async pull(controller) {
        await secondChunk.promise;
        controller.enqueue(new TextEncoder().encode("retired"));
      },
      cancel(reason) {
        cancellations.push(reason);
      },
    });
    const response = publishConnectionHttpResponse(
      {
        connectionId: "legacy-default",
        generation: 7,
        isCurrent: () => current,
      },
      new Response(source),
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("expected guarded body");

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("first");
    current = false;
    secondChunk.resolve();
    await expect(reader.read()).rejects.toThrow(
      "connection changed during request",
    );
    expect(cancellations).toEqual(["connection changed during request"]);
  });

  test("keeps routing error statuses and tags syntactically valid ids", async () => {
    const unknown = connectionRoutingErrorResponse(
      new ConnectionRoutingError(
        "unknown connection: missing",
        404,
        "missing",
        5,
      ),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("X-Herdr-Connection-Id")).toBe("missing");
    expect(unknown.headers.get("X-Herdr-Connection-Generation")).toBe("5");
    expect(await unknown.json()).toEqual({
      error: "unknown connection: missing",
    });

    const malformed = connectionRoutingErrorResponse(
      new ConnectionRoutingError("invalid connection_id", 400),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.has("X-Herdr-Connection-Id")).toBe(false);
  });
});
