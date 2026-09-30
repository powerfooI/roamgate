import {
  CONNECTION_CHANGED_DURING_REQUEST,
  ConnectionRoutingError,
  type LegacyRoutingLogger,
  type ReadyConnectionRegistry,
  resolveReadyConnection,
  validateConnectionGeneration,
  validateConnectionId,
} from "./protocol";

export type ConnectionHttpEndpoint =
  | "herdr-info"
  | "upload-image"
  | "terminal-upload"
  | "agent-session-download"
  | "agent-session-atif"
  | "file-download"
  | "file-upload"
  | "file-delete";

type EndpointDefinition = {
  endpoint: ConnectionHttpEndpoint;
  suffix: string;
  method: string;
  legacyPath: string;
};

const ENDPOINTS: EndpointDefinition[] = [
  {
    endpoint: "herdr-info",
    suffix: "/herdr-info",
    method: "GET",
    legacyPath: "/api/herdr-info",
  },
  {
    endpoint: "upload-image",
    suffix: "/upload-image",
    method: "POST",
    legacyPath: "/api/upload-image",
  },
  {
    endpoint: "terminal-upload",
    suffix: "/terminal-upload",
    method: "POST",
    legacyPath: "/api/terminal-upload",
  },
  {
    endpoint: "agent-session-download",
    suffix: "/agent-session/download",
    method: "GET",
    legacyPath: "/api/agent-session/download",
  },
  {
    endpoint: "agent-session-atif",
    suffix: "/agent-session/atif",
    method: "GET",
    legacyPath: "/api/agent-session/atif",
  },
  {
    endpoint: "file-download",
    suffix: "/file/download",
    method: "GET",
    legacyPath: "/api/file/download",
  },
  {
    endpoint: "file-upload",
    suffix: "/file/upload",
    method: "POST",
    legacyPath: "/api/file/upload",
  },
  {
    endpoint: "file-delete",
    suffix: "/file/delete",
    method: "POST",
    legacyPath: "/api/file/delete",
  },
];

export function rawRequestPathname(requestUrl: string): string {
  const schemeSeparator = requestUrl.indexOf("://");
  const pathStart =
    schemeSeparator >= 0
      ? requestUrl.indexOf("/", schemeSeparator + 3)
      : requestUrl.startsWith("/")
        ? 0
        : -1;
  if (pathStart < 0) return "/";
  const queryStart = requestUrl.indexOf("?", pathStart);
  const hashStart = requestUrl.indexOf("#", pathStart);
  const pathEnd = [queryStart, hashStart]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), requestUrl.length);
  return requestUrl.slice(pathStart, pathEnd);
}

export type ParsedConnectionHttpRoute =
  | {
      kind: "connection";
      endpoint: ConnectionHttpEndpoint;
      requestedConnectionId: string | undefined;
      legacy: boolean;
    }
  | {
      kind: "error";
      error: ConnectionRoutingError;
    };

export function parseConnectionHttpRoute(
  pathname: string,
  method: string,
): ParsedConnectionHttpRoute | null {
  const legacy = ENDPOINTS.find((entry) => entry.legacyPath === pathname);
  if (legacy) {
    if (method !== legacy.method) {
      return {
        kind: "error",
        error: new ConnectionRoutingError(
          `method not allowed for ${pathname}`,
          405,
        ),
      };
    }
    return {
      kind: "connection",
      endpoint: legacy.endpoint,
      requestedConnectionId: undefined,
      legacy: true,
    };
  }

  const prefix = "/api/connections/";
  if (!pathname.startsWith(prefix)) return null;
  const remainder = pathname.slice(prefix.length);
  const separator = remainder.indexOf("/");
  if (separator <= 0) {
    return {
      kind: "error",
      error: new ConnectionRoutingError("invalid connection route", 400),
    };
  }

  const encodedConnectionId = remainder.slice(0, separator);
  const suffix = remainder.slice(separator);
  let connectionId: string;
  try {
    connectionId = validateConnectionId(
      decodeURIComponent(encodedConnectionId),
    );
  } catch (error) {
    return {
      kind: "error",
      error:
        error instanceof ConnectionRoutingError
          ? error
          : new ConnectionRoutingError("invalid connection_id encoding", 400),
    };
  }

  const endpoint = ENDPOINTS.find((entry) => entry.suffix === suffix);
  if (!endpoint) {
    return {
      kind: "error",
      error: new ConnectionRoutingError(
        "unknown connection endpoint",
        404,
        connectionId,
      ),
    };
  }
  if (method !== endpoint.method) {
    return {
      kind: "error",
      error: new ConnectionRoutingError(
        "method not allowed for connection endpoint",
        405,
        connectionId,
      ),
    };
  }
  return {
    kind: "connection",
    endpoint: endpoint.endpoint,
    requestedConnectionId: connectionId,
    legacy: false,
  };
}

export function resolveConnectionHttpRoute<Runtime>(args: {
  route: Extract<ParsedConnectionHttpRoute, { kind: "connection" }>;
  requestedGeneration?: unknown;
  registry: ReadyConnectionRegistry<Runtime>;
  legacyLogger?: LegacyRoutingLogger;
}) {
  if (args.route.legacy) {
    args.legacyLogger?.http(args.route.endpoint, args.registry.defaultId());
  }
  if (args.requestedGeneration === undefined) {
    args.legacyLogger?.httpGeneration(
      args.route.endpoint,
      args.route.requestedConnectionId ?? args.registry.defaultId(),
    );
  }
  const resolved = resolveReadyConnection(
    args.registry,
    args.route.requestedConnectionId,
    args.requestedGeneration,
  );
  return {
    ...resolved,
    endpoint: args.route.endpoint,
  };
}

export function withConnectionResponseHeader(
  response: Response,
  connectionId: string,
  connectionGeneration?: number,
): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Herdr-Connection-Id", validateConnectionId(connectionId));
  if (connectionGeneration !== undefined) {
    headers.set(
      "X-Herdr-Connection-Generation",
      String(validateConnectionGeneration(connectionGeneration)),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function publishConnectionHttpResponse(
  lease: { connectionId: string; generation: number; isCurrent(): boolean },
  response: Response,
): Response {
  if (!lease.isCurrent()) {
    void response.body?.cancel().catch(() => undefined);
    return withConnectionResponseHeader(
      Response.json(
        { error: CONNECTION_CHANGED_DURING_REQUEST },
        { status: 409 },
      ),
      lease.connectionId,
      lease.generation,
    );
  }

  const tagged = withConnectionResponseHeader(
    response,
    lease.connectionId,
    lease.generation,
  );
  if (!tagged.body) return tagged;
  const reader = tagged.body.getReader();
  let finished = false;
  const cancelSource = async (reason: unknown) => {
    if (finished) return;
    finished = true;
    await reader.cancel(reason).catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!lease.isCurrent()) {
        await cancelSource(CONNECTION_CHANGED_DURING_REQUEST);
        controller.error(new Error(CONNECTION_CHANGED_DURING_REQUEST));
        return;
      }
      try {
        const chunk = await reader.read();
        if (!lease.isCurrent()) {
          await cancelSource(CONNECTION_CHANGED_DURING_REQUEST);
          controller.error(new Error(CONNECTION_CHANGED_DURING_REQUEST));
        } else if (chunk.done) {
          finished = true;
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        finished = true;
        controller.error(error);
      }
    },
    async cancel(reason) {
      await cancelSource(reason);
    },
  });
  return new Response(body, {
    status: tagged.status,
    statusText: tagged.statusText,
    headers: tagged.headers,
  });
}

export function connectionRoutingErrorResponse(
  error: ConnectionRoutingError,
): Response {
  const response = Response.json(
    { error: error.message },
    { status: error.status },
  );
  return error.connectionId
    ? withConnectionResponseHeader(
        response,
        error.connectionId,
        error.connectionGeneration,
      )
    : response;
}
