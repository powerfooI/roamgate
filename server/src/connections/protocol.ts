import { sanitizeConnectionError } from "./manager";
import type { ConnectionId } from "./types";

const CONNECTION_ID_MAX_LENGTH = 128;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type ReadyConnectionRegistry<Runtime> = {
  defaultId(): ConnectionId;
  has(connectionId: ConnectionId): boolean;
  readyRuntimeLease(connectionId: ConnectionId): {
    connectionId: ConnectionId;
    generation: number;
    runtime: Runtime;
    isCurrent(): boolean;
  } | null;
};

export type ResolvedConnection<Runtime> = {
  connectionId: ConnectionId;
  generation: number;
  runtime: Runtime;
  isCurrent(): boolean;
  usedLegacyDefault: boolean;
};

export class ConnectionRoutingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly connectionId?: ConnectionId,
    readonly connectionGeneration?: number,
  ) {
    super(message);
    this.name = "ConnectionRoutingError";
  }
}

export function validateConnectionId(value: unknown): ConnectionId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > CONNECTION_ID_MAX_LENGTH ||
    !CONNECTION_ID_PATTERN.test(value)
  ) {
    throw new ConnectionRoutingError("invalid connection_id", 400);
  }
  return value;
}

export function validateConnectionGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ConnectionRoutingError("invalid connection_generation", 400);
  }
  return value;
}

export function isBridgeGlobalMethod(method: string): boolean {
  return method.startsWith("bridge.") || method.startsWith("connections.");
}

export function resolveReadyConnection<Runtime>(
  registry: ReadyConnectionRegistry<Runtime>,
  requestedConnectionId: unknown,
  requestedGeneration?: unknown,
): ResolvedConnection<Runtime> {
  const usedLegacyDefault = requestedConnectionId === undefined;
  const connectionId = usedLegacyDefault
    ? validateConnectionId(registry.defaultId())
    : validateConnectionId(requestedConnectionId);

  let expectedGeneration: number | undefined;
  try {
    expectedGeneration =
      requestedGeneration === undefined
        ? undefined
        : validateConnectionGeneration(requestedGeneration);
  } catch (error) {
    if (error instanceof ConnectionRoutingError) {
      throw new ConnectionRoutingError(
        error.message,
        error.status,
        connectionId,
      );
    }
    throw error;
  }

  if (!registry.has(connectionId)) {
    throw new ConnectionRoutingError(
      `unknown connection: ${connectionId}`,
      404,
      connectionId,
      expectedGeneration,
    );
  }
  const lease = registry.readyRuntimeLease(connectionId);
  if (!lease) {
    throw new ConnectionRoutingError(
      `connection is not ready: ${connectionId}`,
      503,
      connectionId,
      expectedGeneration,
    );
  }
  if (
    expectedGeneration !== undefined &&
    lease.generation !== expectedGeneration
  ) {
    throw new ConnectionRoutingError(
      `connection generation changed: ${connectionId}`,
      409,
      connectionId,
      expectedGeneration,
    );
  }
  return { ...lease, usedLegacyDefault };
}

export const CONNECTION_CHANGED_DURING_REQUEST =
  "connection changed during request";

export function serializeConnectionEnvelope(
  connectionId: ConnectionId,
  message: Record<string, unknown>,
  connectionGeneration?: number,
): string {
  const validatedConnectionId = validateConnectionId(connectionId);
  if (Object.hasOwn(message, "connection_id")) {
    throw new Error(
      "connection envelope payload contains reserved connection_id",
    );
  }
  if (Object.hasOwn(message, "connection_generation")) {
    throw new Error(
      "connection envelope payload contains reserved connection_generation",
    );
  }
  return JSON.stringify({
    connection_id: validatedConnectionId,
    ...(connectionGeneration === undefined
      ? {}
      : {
          connection_generation:
            validateConnectionGeneration(connectionGeneration),
        }),
    ...message,
  });
}

export function createConnectionReplyPublisher(args: {
  connectionId: ConnectionId;
  generation: number;
  requestId: string;
  isCurrent(): boolean;
  send(payload: string, context: string): boolean;
  markError?(message: string): void;
}) {
  let staleReplySent = false;
  return {
    send(message: Record<string, unknown>, context: string): boolean {
      if (args.isCurrent()) {
        return args.send(
          serializeConnectionEnvelope(
            args.connectionId,
            message,
            args.generation,
          ),
          context,
        );
      }
      if (staleReplySent) return false;
      staleReplySent = true;
      args.markError?.(CONNECTION_CHANGED_DURING_REQUEST);
      return args.send(
        serializeConnectionEnvelope(
          args.connectionId,
          {
            id: args.requestId,
            error: { message: CONNECTION_CHANGED_DURING_REQUEST },
          },
          args.generation,
        ),
        `${context}-stale`,
      );
    },
  };
}

const HERDR_EVENT_RESERVED_FIELDS = [
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
] as const;

export function serializeHerdrEventEnvelope(
  connectionId: ConnectionId,
  event: unknown,
  connectionGeneration?: number,
): string {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    typeof (event as { event?: unknown }).event !== "string"
  ) {
    throw new Error("invalid Herdr event envelope");
  }
  for (const field of HERDR_EVENT_RESERVED_FIELDS) {
    if (Object.hasOwn(event, field)) {
      throw new Error(`Herdr event contains reserved ${field}`);
    }
  }
  return serializeConnectionEnvelope(
    connectionId,
    event as Record<string, unknown>,
    connectionGeneration,
  );
}

const SILENT_LEGACY_RPC_METHODS = new Set([
  "terminal.input",
  "terminal.resize",
  "terminal.relay_resize",
  "terminal.scroll",
]);

export function createLegacyRoutingLogger(args: {
  log: (message: string) => void;
}) {
  const rpcClients = new WeakSet<object>();
  const rpcGenerationClients = new WeakSet<object>();
  const httpEndpoints = new Set<string>();
  const httpGenerationEndpoints = new Set<string>();

  return {
    rpc(client: object, method: string, connectionId: ConnectionId): void {
      if (SILENT_LEGACY_RPC_METHODS.has(method) || rpcClients.has(client))
        return;
      rpcClients.add(client);
      const safeMethod = sanitizeConnectionError(method)
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
        .slice(0, 120);
      args.log(
        `[bridge] deprecated unscoped RPC client routed to default connection=${connectionId} method=${safeMethod}`,
      );
    },
    rpcGeneration(
      client: object,
      method: string,
      connectionId: ConnectionId,
    ): void {
      if (
        SILENT_LEGACY_RPC_METHODS.has(method) ||
        rpcGenerationClients.has(client)
      )
        return;
      rpcGenerationClients.add(client);
      const safeMethod = sanitizeConnectionError(method)
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
        .slice(0, 120);
      args.log(
        `[bridge] deprecated generation-unscoped RPC routed to current connection=${connectionId} method=${safeMethod}`,
      );
    },
    http(endpoint: string, connectionId: ConnectionId): void {
      if (httpEndpoints.has(endpoint)) return;
      httpEndpoints.add(endpoint);
      args.log(
        `[bridge] deprecated unscoped HTTP route routed to default connection=${connectionId} endpoint=${endpoint}`,
      );
    },
    httpGeneration(endpoint: string, connectionId: ConnectionId): void {
      if (httpGenerationEndpoints.has(endpoint)) return;
      httpGenerationEndpoints.add(endpoint);
      args.log(
        `[bridge] deprecated generation-unscoped HTTP routed to current connection=${connectionId} endpoint=${endpoint}`,
      );
    },
  };
}

export type LegacyRoutingLogger = ReturnType<typeof createLegacyRoutingLogger>;
