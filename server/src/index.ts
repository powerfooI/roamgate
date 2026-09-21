import type { ServerWebSocket } from "bun";
import { createWebPushService } from "./notifications/web-push";
import { rmSync } from "node:fs";
import packageJson from "../../package.json";
import type { SshTunnelConfig } from "./bridge/ssh-tunnel";
import {
  flushCoalescedMessages,
  sendWebSocketMessage,
  WebSocketCleanupTracker,
  WS_PER_MESSAGE_DEFLATE,
} from "./bridge/websocket-send";
import {
  browserUrlFor,
  getLanIPs,
  isAnyHost,
  loadServerConfig,
  openBrowser,
  withLoginToken,
} from "./config/server-config";
import {
  runServiceCommand,
  SERVICE_COMMAND_CONTINUE,
} from "./config/service-manager";
import { runHerdrCommand } from "./herdr/cli";
import {
  createHerdrSetupHandlers,
  herdrSetupGuardForProfile,
} from "./http/herdr-setup";
import { HerdrClient } from "./bridge/herdr-client";
import {
  connectionRoutingErrorResponse,
  type ParsedConnectionHttpRoute,
  parseConnectionHttpRoute,
  publishConnectionHttpResponse,
  rawRequestPathname,
  resolveConnectionHttpRoute,
} from "./connections/http-routing";
import {
  ConnectionManager,
  type ConnectionRuntimeContext,
  sanitizeConnectionError,
} from "./connections/manager";
import {
  ConnectionProfileService,
  connectionIdentityForProfile,
  loadConnectionProfileBootstrap,
  type SyntheticLocalProfile,
  testConnectionSockets,
} from "./connections/profile-service";
import {
  type ConnectionProfile,
  ConnectionProfileStore,
} from "./connections/profiles";
import { createSshProfileRuntimeConfig } from "./connections/ssh-profile-runtime";
import {
  ConnectionRoutingError,
  createConnectionReplyPublisher,
  createLegacyRoutingLogger,
  isBridgeGlobalMethod,
  serializeConnectionEnvelope,
  serializeHerdrEventEnvelope,
  validateConnectionGeneration,
  validateConnectionId,
} from "./connections/protocol";
import {
  type ConnectionRpcRequest,
  isConnectionRpcEnvelope,
  resolveRpcRoute,
} from "./connections/rpc-routing";
import {
  createLegacyConnectionRuntime,
  type LegacyConnectionRuntime,
} from "./connections/runtime";
import { createShutdownController } from "./connections/shutdown";
import { bindListenerBeforeConnectionStart } from "./connections/startup";
import { LEGACY_DEFAULT_CONNECTION_ID } from "./connections/types";
import { createAuthHandlers, unauthenticatedLoginRedirect } from "./http/auth";
import { serveStatic } from "./http/static-files";
import {
  createUpdateHandlers,
  UPDATE_HTTP_IDLE_TIMEOUT_SECONDS,
} from "./http/update";
import {
  configureServerLogger,
  createRecoveryReporter,
  type RecoveryReporter,
  serverLogger,
} from "./utils/logger";
import { runProcessWithCodeTimeout, shQuote } from "./utils/process-utils";
import { rpcLogLevel } from "./utils/rpc-logging";
import { syncWorktreeBase } from "./worktree/create";
import {
  removeWorktreeWithRecovery,
  WORKTREE_REMOVE_TIMEOUT_MS,
} from "./worktree/remove";

const APP_VERSION = packageJson.version;
const serviceCommandResult = runServiceCommand(process.argv.slice(2));
if (serviceCommandResult === SERVICE_COMMAND_CONTINUE) {
  process.argv.splice(2);
} else if (serviceCommandResult !== null) {
  process.exit(serviceCommandResult);
}
const herdrCommandResult = await runHerdrCommand(
  process.argv.slice(2),
  APP_VERSION,
);
if (herdrCommandResult !== null) {
  process.exit(herdrCommandResult);
}
const config = loadServerConfig(APP_VERSION);
configureServerLogger(config.logLevel);
const logger = serverLogger;
const webPush = createWebPushService({
  warn: (message) => logger.warn(message),
});
const downstreamConnectionConfig = {
  socketPath: config.socketPath,
  clientSocketPath: config.clientSocketPath,
  sshHost: config.sshHost,
  session: config.session,
  hasExplicitSocketPath: config.hasExplicitSocketPath,
  hasExplicitClientSocketPath: config.hasExplicitClientSocketPath,
};
const {
  isAuthed,
  sessionToken,
  handleTokenLogin,
  handleLogin,
  handleLogout,
  loginPage,
} = createAuthHandlers({
  authRequired: config.authRequired,
  password: config.password,
  urlLoginToken: config.generatedAuthToken,
  secureCookies: Boolean(config.tls),
});

type RpcRequest = ConnectionRpcRequest;

const { handleUpdateCheck, handleUpdateInstall } = createUpdateHandlers({
  appVersion: APP_VERSION,
  runProcessWithCodeTimeout,
  shQuote,
  scheduleProcessExit: scheduleManagedShutdown,
});
const clients = new Set<ServerWebSocket<unknown>>();
const clientIds = new WeakMap<ServerWebSocket<unknown>, number>();
const clientSessions = new WeakMap<ServerWebSocket<unknown>, string | null>();
interface WebSocketCleanupSnapshot {
  client: string;
  viewedTerminals: string[];
}
let nextClientId = 1;

const rpcOutcomes = new Map<string, { status: "error"; detail?: string }>();

const IMPORTANT_RPC_METHODS = new Set([
  "bridge.pause_others",
  "agent_history.get",
  "agent_history.entry",
  "agent_session.get",
  "file.read",
  "git.diff_file",
  "git.file_action",
  "git.pull",
  "git.repo_action",
  "settings.update_repo",
  "settings.workspace_auto_sync.get",
  "settings.workspace_auto_sync.list",
  "settings.workspace_auto_sync.update",
  "settings.workspace_auto_sync.update_key",
  "settings.worktree_hooks.get",
  "worktree.create",
  "worktree.open",
  "worktree.remove",
]);
const SLOW_RPC_LOG_MS = 750;
const legacyRoutingLogger = createLegacyRoutingLogger({
  log: (message) =>
    logger.warn("deprecated request routing", { detail: message }),
});

function clientLabel(ws: ServerWebSocket<unknown>): string {
  const id = clientIds.get(ws);
  return id ? `c${id}` : "unknown";
}

function assignClientId(ws: ServerWebSocket<unknown>): string {
  clientIds.set(ws, nextClientId++);
  return clientLabel(ws);
}

function logDetail(value: string): string {
  return sanitizeConnectionError(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "?")
    .trim()
    .slice(0, 300);
}

function parseRpcMeta(raw: string): {
  id: string | null;
  method: string | null;
  connectionId: unknown;
  connectionGeneration: unknown;
} {
  try {
    const msg = JSON.parse(raw);
    return {
      id: typeof msg?.id === "string" ? msg.id : null,
      method: typeof msg?.method === "string" ? msg.method : null,
      connectionId: Object.hasOwn(msg ?? {}, "connection_id")
        ? msg.connection_id
        : undefined,
      connectionGeneration: Object.hasOwn(msg ?? {}, "connection_generation")
        ? msg.connection_generation
        : undefined,
    };
  } catch {
    return {
      id: null,
      method: null,
      connectionId: undefined,
      connectionGeneration: undefined,
    };
  }
}

function rpcOutcomeKey(ws: ServerWebSocket<unknown>, id: string) {
  return `${clientLabel(ws)}\0${id}`;
}

function markRpcError(
  ws: ServerWebSocket<unknown>,
  id: string | null | undefined,
  detail?: string,
) {
  if (!id) return;
  rpcOutcomes.set(rpcOutcomeKey(ws, id), { status: "error", detail });
}

function takeRpcOutcome(ws: ServerWebSocket<unknown>, id: string | null) {
  if (!id) return null;
  const key = rpcOutcomeKey(ws, id);
  const outcome = rpcOutcomes.get(key) ?? null;
  rpcOutcomes.delete(key);
  return outcome;
}

function shouldLogRpc(
  method: string | null,
  elapsedMs: number,
  failed: boolean,
) {
  if (!method) return failed;
  if (failed) return true;
  if (method === "bridge.ping" || method === "bridge.status") return false;
  if (method === "terminal.input" || method === "terminal.scroll") return false;
  if (method === "terminal.resize" && elapsedMs < SLOW_RPC_LOG_MS) return false;
  return IMPORTANT_RPC_METHODS.has(method) || elapsedMs >= SLOW_RPC_LOG_MS;
}

function logRpc(
  ws: ServerWebSocket<unknown>,
  method: string | null,
  startedAt: number,
  status: "ok" | "error",
  connectionId: string | null,
  detail?: string,
) {
  const elapsedMs = Date.now() - startedAt;
  const failed = status === "error";
  if (!shouldLogRpc(method, elapsedMs, failed)) return;
  const level = rpcLogLevel({ method, status, detail });
  logger[level]("rpc completed", {
    status,
    client: clientLabel(ws),
    method: method ? logDetail(method) : "unknown",
    connection: connectionId ? logDetail(connectionId) : undefined,
    duration_ms: elapsedMs,
    detail: detail ? logDetail(detail) : undefined,
  });
}

function summarizeHerdrEvent(event: any): string {
  const type = logDetail(String(event?.event ?? event?.type ?? "unknown"));
  const data = event?.data && typeof event.data === "object" ? event.data : {};
  const ids = ["workspace_id", "tab_id", "pane_id", "agent_id", "terminal_id"]
    .map((key) => {
      const value = data[key] ?? event?.[key];
      return typeof value === "string" && value
        ? `${key}=${logDetail(value)}`
        : "";
    })
    .filter(Boolean);
  return [`type=${type}`, ...ids].join(" ");
}

const connectionProfileStore = new ConnectionProfileStore();
const syntheticLegacyProfile: SyntheticLocalProfile = {
  id: LEGACY_DEFAULT_CONNECTION_ID,
  label: "Default",
  type: "local",
  control_socket_path: config.socketPath,
  client_socket_path: config.clientSocketPath,
  auto_connect: true,
};
const explicitLegacyOverride = Boolean(
  config.hasExplicitSocketPath ||
    config.hasExplicitClientSocketPath ||
    config.sshHost ||
    config.session,
);
let connectionBootstrap;
try {
  connectionBootstrap = loadConnectionProfileBootstrap({
    store: connectionProfileStore,
    legacyProfile: syntheticLegacyProfile,
    explicitLegacyOverride,
  });
} catch (error) {
  const registryLoadError = sanitizeConnectionError(error);
  logger.error("invalid connection registry preserved", {
    error: registryLoadError,
    profile_mutations: "disabled",
  });
  connectionBootstrap = {
    defaultConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
    explicitLegacyOverride,
    persistedRegistry: null,
    registryLoadError,
    registrations: [
      { profile: syntheticLegacyProfile, readOnly: true as const },
    ],
  };
}

const connectionFailureReporters = new Map<string, RecoveryReporter>();
const readyConnectionGenerations = new Map<string, number>();

function connectionFailureReporter(connectionId: string): RecoveryReporter {
  let reporter = connectionFailureReporters.get(connectionId);
  if (!reporter) {
    reporter = createRecoveryReporter({
      logger: logger.child("connections"),
      failureMessage: "connection degraded",
      recoveryMessage: "connection recovered",
    });
    connectionFailureReporters.set(connectionId, reporter);
  }
  return reporter;
}

const connectionManager = new ConnectionManager<LegacyConnectionRuntime>(
  connectionBootstrap.defaultConnectionId,
  (status) => {
    const fields = {
      connection: status.id,
      state: status.state,
      generation: status.generation,
    };
    logger.debug("connection status", {
      ...fields,
      error: status.error?.message,
    });
    const reporter = connectionFailureReporter(status.id);
    if (
      (status.state === "error" || status.state === "reconnecting") &&
      status.error
    ) {
      reporter.failure(status.error.message, fields);
      return;
    }
    if (status.state !== "ready") return;
    if (reporter.recovered(fields)) {
      readyConnectionGenerations.set(status.id, status.generation);
    } else if (
      readyConnectionGenerations.get(status.id) !== status.generation
    ) {
      readyConnectionGenerations.set(status.id, status.generation);
      logger.info("connection ready", fields);
    }
  },
  logger.child("connections"),
);

const { handleHerdrStatus, handleHerdrSetup } = createHerdrSetupHandlers({
  ping: () => {
    const runtime = connectionManager.defaultReadyRuntime();
    return runtime
      ? runtime.herdr.ping()
      : new HerdrClient(config.socketPath).ping();
  },
  guard: () =>
    herdrSetupGuardForProfile(
      config,
      connectionProfiles
        .list()
        .find((profile) => profile.id === connectionManager.defaultId()),
    ),
});

function runtimeFactoryForProfile(
  profile: ConnectionProfile | SyntheticLocalProfile,
) {
  const identity = connectionIdentityForProfile(profile);
  return (context: ConnectionRuntimeContext) => {
    const profileConfig: SshTunnelConfig =
      profile.id === LEGACY_DEFAULT_CONNECTION_ID
        ? downstreamConnectionConfig
        : profile.type === "ssh"
          ? createSshProfileRuntimeConfig(profile)
          : {
              socketPath: profile.control_socket_path,
              clientSocketPath: profile.client_socket_path,
              sshHost: undefined,
              session: undefined,
              hasExplicitSocketPath: true,
              hasExplicitClientSocketPath: true,
              ownedRuntimeDirectory: undefined,
            };
    let runtime: LegacyConnectionRuntime;
    try {
      runtime = createLegacyConnectionRuntime({
        identity,
        connectionGeneration: context.generation,
        config: profileConfig,
        logger: logger.child("connection"),
        safeSend,
        clientLabel,
        markRpcError,
        onTaskEvent: (event) =>
          webPush.notify(
            {
              ...event,
              connectionId: identity.id,
              runtimeGeneration: context.generation,
            },
            context.isCurrent,
          ),
        onEvent: (event, eventIdentity) => {
          if (!context.isCurrent()) return;
          logger.debug("Herdr event", {
            connection: eventIdentity.id,
            detail: summarizeHerdrEvent(event),
          });
          try {
            const line = serializeHerdrEventEnvelope(
              eventIdentity.id,
              event,
              context.generation,
            );
            for (const ws of clients) safeSend(ws, line, "event");
          } catch (error) {
            logger.warn("dropped invalid Herdr event", {
              connection: eventIdentity.id,
              error: sanitizeConnectionError(error),
            });
          }
        },
        onTransportExit: profileConfig.sshHost
          ? (error) => {
              if (!context.isCurrent()) return;
              const reconnecting = connectionProfiles.willRetry(
                profile.id,
                error,
              );
              context.reportError(error, { reconnecting });
              connectionProfiles.runtimeFailed(profile.id, error);
            }
          : undefined,
      });
    } catch (error) {
      if (profileConfig.ownedRuntimeDirectory) {
        rmSync(profileConfig.ownedRuntimeDirectory, {
          recursive: true,
          force: true,
        });
      }
      throw error;
    }
    return {
      ...runtime,
      async startTransport() {
        await runtime.startTransport();
        await testConnectionSockets(
          profileConfig.socketPath,
          profileConfig.clientSocketPath,
        );
      },
    };
  };
}

const connectionProfiles = new ConnectionProfileService({
  manager: connectionManager,
  store: connectionProfileStore,
  bootstrap: connectionBootstrap,
  createRuntime: runtimeFactoryForProfile,
});

function notifyBrowserClientCount() {
  connectionManager.forEachCurrentRuntime((runtime) => {
    runtime.terminalBridge.browserClientCountChanged(clients.size);
  });
}

const webSocketCleanup = new WebSocketCleanupTracker<
  ServerWebSocket<unknown>,
  WebSocketCleanupSnapshot
>((ws) => {
  const viewedTerminals: string[] = [];
  connectionManager.forEachCurrentRuntime((runtime) => {
    viewedTerminals.push(...runtime.terminalBridge.viewedTerminals(ws));
    runtime.terminalBridge.cleanupWs(ws);
  });
  const snapshot = {
    client: clientLabel(ws),
    viewedTerminals,
  };
  clients.delete(ws);
  notifyBrowserClientCount();
  return snapshot;
});

function safeSend(
  ws: ServerWebSocket<unknown>,
  payload: string,
  context = "message",
  coalesceKey?: string,
): boolean {
  return sendWebSocketMessage(ws, payload, {
    cleanup: () => {
      webSocketCleanup.cleanup(ws);
    },
    coalesceKey,
    context,
    warn: (message) =>
      logger.warn("websocket send failed", {
        detail: message.replace(/^\[bridge\] /, ""),
      }),
  });
}

async function handleRpc(ws: ServerWebSocket<unknown>, raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    safeSend(
      ws,
      JSON.stringify({ error: { message: "bad json" } }),
      "bad-json",
    );
    return;
  }
  if (!isConnectionRpcEnvelope(parsed)) {
    safeSend(
      ws,
      JSON.stringify({ error: { message: "invalid request envelope" } }),
      "invalid-request-envelope",
    );
    return;
  }
  const req = parsed as RpcRequest;
  const { id, method, params } = req;
  let validationConnectionId: string | undefined;
  let connectionIdValidationFailed = false;
  if (Object.hasOwn(req, "connection_id")) {
    try {
      validationConnectionId = validateConnectionId(req.connection_id);
    } catch {
      connectionIdValidationFailed = true;
    }
  }
  let validationConnectionGeneration: number | undefined;
  let connectionGenerationValidationFailed = false;
  if (Object.hasOwn(req, "connection_generation")) {
    try {
      validationConnectionGeneration = validateConnectionGeneration(
        req.connection_generation,
      );
    } catch {
      connectionGenerationValidationFailed = true;
    }
  }
  if (typeof id !== "string" || !id || typeof method !== "string" || !method) {
    const message = connectionIdValidationFailed
      ? "invalid connection_id"
      : connectionGenerationValidationFailed
        ? "invalid connection_generation"
        : "missing id/method";
    markRpcError(ws, typeof id === "string" ? id : undefined, message);
    const responseId = typeof id === "string" ? id : undefined;
    const payload = validationConnectionId
      ? serializeConnectionEnvelope(
          validationConnectionId,
          {
            ...(responseId ? { id: responseId } : {}),
            error: { message },
          },
          validationConnectionGeneration,
        )
      : JSON.stringify({
          ...(responseId ? { id: responseId } : {}),
          error: { message },
        });
    safeSend(ws, payload, "invalid-request");
    return;
  }
  let route: ReturnType<typeof resolveRpcRoute<LegacyConnectionRuntime>>;
  try {
    route = resolveRpcRoute({
      request: req,
      registry: connectionManager,
      legacyClient: ws,
      legacyLogger: legacyRoutingLogger,
    });
  } catch (error) {
    const message = (error as Error).message;
    markRpcError(ws, id, message);
    const connectionId =
      error instanceof ConnectionRoutingError ? error.connectionId : undefined;
    const connectionGeneration =
      error instanceof ConnectionRoutingError
        ? error.connectionGeneration
        : undefined;
    const payload = connectionId
      ? serializeConnectionEnvelope(
          connectionId,
          {
            id,
            error: { message },
          },
          connectionGeneration,
        )
      : JSON.stringify({ id, error: { message } });
    safeSend(ws, payload, "connection-routing-error");
    return connectionId ?? null;
  }
  const connectionId = route.scope === "connection" ? route.connectionId : null;
  const requestIsCurrent = () => route.scope === "bridge" || route.isCurrent();
  const encode = (message: Record<string, unknown>) =>
    route.scope === "connection"
      ? serializeConnectionEnvelope(
          route.connectionId,
          message,
          route.generation,
        )
      : JSON.stringify(message);
  const replyPublisher =
    route.scope === "connection"
      ? createConnectionReplyPublisher({
          connectionId: route.connectionId,
          generation: route.generation,
          requestId: id,
          isCurrent: route.isCurrent,
          send: (payload, context) => safeSend(ws, payload, context),
          markError: (message) => markRpcError(ws, id, message),
        })
      : null;
  const sendReply = (
    message: Record<string, unknown>,
    context: string,
  ): boolean =>
    replyPublisher
      ? replyPublisher.send(message, context)
      : safeSend(ws, encode(message), context);
  const sendError = (context: string, error: unknown) => {
    const message = (error as Error).message;
    markRpcError(ws, id, message);
    sendReply({ id, error: { message } }, context);
  };
  if (method === "bridge.ping") {
    sendReply({ id, result: { ok: true } }, "bridge-ping");
    return;
  }
  if (method === "bridge.status") {
    sendReply(
      {
        id,
        result: {
          clients: clients.size,
          terminals:
            connectionManager
              .defaultReadyRuntime()
              ?.terminalBridge.statusTerminals() ?? [],
          default_connection_id: connectionManager.defaultId(),
          connections: connectionProfiles.list(),
        },
      },
      "bridge-status",
    );
    return;
  }
  if (method === "connections.list") {
    sendReply(
      {
        id,
        result: {
          default_connection_id: connectionManager.defaultId(),
          connections: connectionProfiles.list(),
        },
      },
      "connections-list",
    );
    return;
  }
  if (method.startsWith("connections.")) {
    try {
      let result: unknown;
      if (method === "connections.create") {
        result = await connectionProfiles.create(params?.profile ?? params);
      } else if (method === "connections.update") {
        result = await connectionProfiles.update(
          params?.id,
          params?.profile ?? params,
        );
      } else if (method === "connections.remove") {
        result = await connectionProfiles.remove(params?.id);
      } else if (method === "connections.set_default") {
        result = await connectionProfiles.setDefault(params?.id);
      } else if (method === "connections.connect") {
        result = await connectionProfiles.connect(params?.id);
      } else if (method === "connections.disconnect") {
        result = await connectionProfiles.disconnect(params?.id);
      } else if (method === "connections.test") {
        result = await connectionProfiles.test(params?.profile ?? params);
      } else {
        throw new Error(`unknown bridge-global method: ${method}`);
      }
      sendReply({ id, result }, "connections-mutation");
    } catch (error) {
      const message = sanitizeConnectionError(error);
      markRpcError(ws, id, message);
      sendReply({ id, error: { message } }, "connections-mutation-error");
    }
    return;
  }
  if (method === "bridge.pause_others") {
    const targets = Array.from(clients).filter((client) => client !== ws);
    let pausedClients = 0;
    for (const client of targets) {
      const ok = safeSend(
        client,
        JSON.stringify({
          control: {
            type: "pause_connection",
            reason:
              "Another Roamgate client paused this connection. Resume when you want this browser to sync again.",
          },
        }),
        "pause-other-client",
      );
      if (ok) pausedClients += 1;
    }
    sendReply(
      {
        id,
        result: {
          ok: true,
          paused_clients: pausedClients,
          clients: clients.size,
        },
      },
      "bridge-pause-others",
    );
    return;
  }

  if (route.scope === "bridge") {
    sendError(
      "unknown-bridge-method",
      new Error(`unknown bridge-global method: ${method}`),
    );
    return null;
  }
  const connection = route.runtime;
  const {
    sshHost,
    herdr,
    worktreeParents,
    handleSettingsRpc,
    worktreeRemovalCoordinator,
    worktreeRemovalRuntime,
    terminalBridge,
  } = connection;
  const {
    listWorkspaceFiles,
    resolveWorkspaceFiles,
    readWorkspaceFile,
    readGitDiffSummary,
    readGitDiffFile,
    runGitPull,
    runWorkspaceGitFileAction,
    runWorkspaceGitRepoAction,
    resolveWorkspaceGitRoot,
  } = connection.files;
  const { enrichWorkspacesWithGitStatus, invalidateGitStatus } =
    connection.status;
  const {
    runPaseoWorktreeHook,
    worktreeRemoveHookContext,
    runWorktreeRemovedHook,
    runWorktreeOpenedHook,
    sourceWorkspaceForWorktreeCreate,
    runWorktreeSetupHook,
  } = connection.worktreeHooks;
  const {
    readHistory: readAgentMessageHistory,
    readSummary: readAgentSessionSummary,
    readEntry: readAgentHistoryEntry,
  } = connection.agentSessions;

  if (
    (method === "tab.create" || method === "workspace.create") &&
    params &&
    Object.hasOwn(params, "browser_source")
  ) {
    try {
      const result = await terminalBridge.createFromTerminal(
        ws,
        method,
        params,
        requestIsCurrent,
      );
      sendReply({ id, result }, method);
    } catch (error) {
      sendError(`${method}-error`, error);
    }
    return;
  }

  if (method === "agent.list") {
    try {
      const result = await connection.agentSessions.listWithActivity(
        params ?? {},
      );
      sendReply({ id, result }, "agent-list");
    } catch (e) {
      sendError("agent-list-error", e);
    }
    return;
  }
  if (method === "agent_history.get") {
    try {
      const result = await readAgentMessageHistory(params ?? {});
      sendReply({ id, result }, "agent-history-get");
    } catch (e) {
      sendError("agent-history-get-error", e);
    }
    return;
  }
  if (method === "agent_history.entry") {
    try {
      const result = await readAgentHistoryEntry(params ?? {});
      sendReply({ id, result }, "agent-history-entry");
    } catch (e) {
      sendError("agent-history-entry-error", e);
    }
    return;
  }
  if (method === "agent_session.get") {
    try {
      const result = await readAgentSessionSummary(params ?? {});
      sendReply({ id, result }, "agent-session-get");
    } catch (e) {
      sendError("agent-session-get-error", e);
    }
    return;
  }
  if (method === "file.list") {
    try {
      const result = await listWorkspaceFiles(params ?? {});
      sendReply({ id, result }, "file-list");
    } catch (e) {
      sendError("file-list-error", e);
    }
    return;
  }
  if (method === "file.resolve") {
    try {
      const result = await resolveWorkspaceFiles(params ?? {});
      sendReply({ id, result }, "file-resolve");
    } catch (e) {
      sendError("file-resolve-error", e);
    }
    return;
  }
  if (method === "file.read") {
    try {
      const result = await readWorkspaceFile(params ?? {});
      sendReply({ id, result }, "file-read");
    } catch (e) {
      sendError("file-read-error", e);
    }
    return;
  }
  if (method === "git.diff_summary") {
    try {
      const result = await readGitDiffSummary(params ?? {});
      sendReply({ id, result }, "git-diff-summary");
    } catch (e) {
      sendError("git-diff-summary-error", e);
    }
    return;
  }
  if (method === "git.diff_file") {
    try {
      const result = await readGitDiffFile(params ?? {});
      sendReply({ id, result }, "git-diff-file");
    } catch (e) {
      sendError("git-diff-file-error", e);
    }
    return;
  }
  if (method === "git.pull") {
    try {
      const result = await runGitPull(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-pull");
    } catch (e) {
      sendError("git-pull-error", e);
    }
    return;
  }
  if (method === "git.file_action") {
    try {
      const result = await runWorkspaceGitFileAction(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-file-action");
    } catch (e) {
      sendError("git-file-action-error", e);
    }
    return;
  }
  if (method === "git.repo_action") {
    try {
      const result = await runWorkspaceGitRepoAction(params ?? {});
      invalidateGitStatus(result.root);
      sendReply({ id, result }, "git-repo-action");
    } catch (e) {
      sendError("git-repo-action-error", e);
    }
    return;
  }
  if (method.startsWith("terminal.")) {
    return terminalBridge.handleTerminalRpc(
      ws,
      id,
      method,
      params ?? {},
      requestIsCurrent,
    );
  }
  if (method.startsWith("settings.")) {
    return handleSettingsRpc(ws, id, method, params ?? {}, requestIsCurrent);
  }
  if (method === "worktree.create") {
    try {
      const sourceWorkspace = await sourceWorkspaceForWorktreeCreate(
        params ?? {},
      );
      const workspaceId = String(params?.workspace_id ?? "");
      const baseSync = await syncWorktreeBase({
        workspaceId,
        resolveGitRoot: async (id) =>
          resolveWorkspaceGitRoot({ workspace_id: id }),
        host: sshHost(),
        shQuote,
        runProcessWithCodeTimeout,
      });
      const result = await herdr.call(method, {
        ...(params ?? {}),
        base: baseSync.base,
      });
      // Herdr identifies the repository but not which of several workspaces
      // for that repository initiated creation. Keep that GUI relationship.
      await worktreeParents
        .rememberWorktreeParent(result, workspaceId, requestIsCurrent)
        .catch((error) => {
          if (!requestIsCurrent()) return;
          logger.warn("unable to persist worktree parent", {
            connection: connectionId,
            error: sanitizeConnectionError(error),
          });
        });
      const hookSourceWorkspace = sourceWorkspace
        ? {
            ...sourceWorkspace,
            cwd:
              sourceWorkspace?.worktree?.checkout_path ||
              sourceWorkspace?.cwd ||
              baseSync.root,
          }
        : { cwd: baseSync.root };
      const setupHook = await runWorktreeSetupHook(result, hookSourceWorkspace);
      sendReply(
        {
          id,
          result: {
            ...result,
            base_sync: baseSync,
            setup_hook: setupHook,
          },
        },
        "worktree-create",
      );
    } catch (e) {
      sendError("worktree-create-error", e);
    }
    return;
  }
  if (method === "worktree.open") {
    try {
      const workspaceId = String(params?.workspace_id ?? "");
      const sourceWorkspace = await sourceWorkspaceForWorktreeCreate(
        params ?? {},
      );
      const result = await herdr.call(method, params ?? {});
      await worktreeParents
        .rememberWorktreeParent(result, workspaceId, requestIsCurrent)
        .catch((error) => {
          if (!requestIsCurrent()) return;
          logger.warn("unable to persist opened worktree parent", {
            connection: connectionId,
            error: sanitizeConnectionError(error),
          });
        });
      const openedHook = await runWorktreeOpenedHook(result, sourceWorkspace);
      sendReply(
        {
          id,
          result: { ...result, opened_hook: openedHook },
        },
        "worktree-open",
      );
    } catch (e) {
      sendError("worktree-open-error", e);
    }
    return;
  }
  if (method === "worktree.remove") {
    try {
      const workspaceId = String(params?.workspace_id ?? "");
      const result = await worktreeRemovalCoordinator.run(
        workspaceId,
        async () => {
          const removeHookContext = await worktreeRemoveHookContext(
            params ?? {},
          );
          const checkoutState = removeHookContext
            ? await worktreeRemovalRuntime
                .inspectCheckout(removeHookContext.checkoutPath)
                .catch(() => "unknown" as const)
            : "unknown";
          const beforeRemoveHook =
            removeHookContext && checkoutState !== "missing"
              ? await runPaseoWorktreeHook({
                  hook: "teardown",
                  checkoutPath: removeHookContext.checkoutPath,
                  sourceCheckoutPath: removeHookContext.sourceCheckoutPath,
                  repoSettingsKey: removeHookContext.repoSettingsKey,
                })
              : ({
                  event: "worktree.before_remove",
                  status: "skipped",
                } as const);
          if (beforeRemoveHook.status === "failed") {
            markRpcError(
              ws,
              id,
              beforeRemoveHook.error || "before-remove hook failed",
            );
            return {
              ok: false,
              skipped_remove: true,
              before_remove_hook: beforeRemoveHook,
            };
          }

          const removal = await removeWorktreeWithRecovery({
            call: (name, callParams) =>
              herdr.call(name, callParams, WORKTREE_REMOVE_TIMEOUT_MS),
            params: params ?? {},
            checkoutPath: removeHookContext?.checkoutPath,
            runtime: worktreeRemovalRuntime,
          });
          if (removal.cleanup?.preserved_path) {
            logger.warn("preserved stale worktree files", {
              connection: connectionId,
              path: removal.cleanup.preserved_path,
            });
          }
          if (removeHookContext?.checkoutPath) {
            await worktreeParents
              .forgetWorktree(removeHookContext.checkoutPath, requestIsCurrent)
              .catch((error) => {
                if (!requestIsCurrent()) return;
                logger.warn("unable to remove worktree parent", {
                  connection: connectionId,
                  error: sanitizeConnectionError(error),
                });
              });
          }
          const removedHook = await runWorktreeRemovedHook(removeHookContext);
          return {
            ...removal.result,
            ...(removal.cleanup ? { cleanup: removal.cleanup } : {}),
            before_remove_hook: beforeRemoveHook,
            removed_hook: removedHook,
          };
        },
      );
      sendReply({ id, result }, "worktree-remove");
    } catch (e) {
      sendError("worktree-remove-error", e);
    }
    return;
  }
  try {
    const rawResult = await herdr.call(method, params ?? {});
    let result = rawResult;
    if (method === "workspace.list") {
      result = await worktreeParents.enrichWorkspaceList(result);
      result = await enrichWorkspacesWithGitStatus(result);
      result = {
        ...result,
        navigation_mode: await terminalBridge.navigationMode(),
        endpoint_availability: terminalBridge.endpointAvailability(),
      };
    }
    sendReply({ id, result }, method);
  } catch (e) {
    sendError(`${method}-error`, e);
  }
}

async function handleConnectionHttpRequest(
  route: ParsedConnectionHttpRoute,
  url: URL,
  req: Request,
): Promise<Response> {
  if (route.kind === "error") {
    return connectionRoutingErrorResponse(route.error);
  }

  let resolved: ReturnType<
    typeof resolveConnectionHttpRoute<LegacyConnectionRuntime>
  >;
  const generationText = url.searchParams.get("connection_generation");
  const requestedGeneration =
    generationText === null
      ? undefined
      : /^(0|[1-9]\d*)$/.test(generationText)
        ? Number(generationText)
        : generationText;
  try {
    resolved = resolveConnectionHttpRoute({
      route,
      requestedGeneration,
      registry: connectionManager,
      legacyLogger: legacyRoutingLogger,
    });
  } catch (error) {
    if (error instanceof ConnectionRoutingError) {
      return connectionRoutingErrorResponse(error);
    }
    return Response.json(
      { error: "connection routing failed" },
      { status: 500 },
    );
  }

  const { runtime: connection, endpoint } = resolved;
  try {
    let response: Response;
    if (endpoint === "herdr-info") {
      response = await connection.handleHerdrInfo();
    } else if (endpoint === "upload-image") {
      response = await connection.handleImageUpload(req);
    } else if (endpoint === "agent-session-download") {
      response = await connection.agentSessions.downloadFile({
        pane_id: url.searchParams.get("pane_id"),
        agent: url.searchParams.get("agent"),
      });
    } else if (endpoint === "agent-session-atif") {
      response = await connection.agentSessions.downloadAtif({
        pane_id: url.searchParams.get("pane_id"),
        agent: url.searchParams.get("agent"),
      });
    } else if (endpoint === "file-download") {
      try {
        response = await connection.files.downloadWorkspaceFile({
          workspace_id: url.searchParams.get("workspace_id"),
          path: url.searchParams.get("path"),
          scope: url.searchParams.get("scope"),
          inline: url.searchParams.get("inline") === "1",
        });
      } catch (error) {
        response = new Response((error as Error).message, { status: 400 });
      }
    } else if (endpoint === "file-upload") {
      try {
        const result = await connection.files.uploadWorkspaceFile(
          {
            workspace_id: url.searchParams.get("workspace_id"),
            directory: url.searchParams.get("directory"),
            filename: url.searchParams.get("filename"),
          },
          req,
        );
        response = Response.json(result);
      } catch (error) {
        response = Response.json(
          { error: (error as Error).message },
          { status: 400 },
        );
      }
    } else {
      try {
        const result = await connection.files.deleteWorkspaceFile({
          workspace_id: url.searchParams.get("workspace_id"),
          path: url.searchParams.get("path"),
        });
        response = Response.json(result);
      } catch (error) {
        response = Response.json(
          { error: (error as Error).message },
          { status: 400 },
        );
      }
    }
    return publishConnectionHttpResponse(resolved, response);
  } catch (error) {
    return publishConnectionHttpResponse(
      resolved,
      Response.json({ error: (error as Error).message }, { status: 500 }),
    );
  }
}

function main() {
  const server = bindListenerBeforeConnectionStart({
    bindListener: () =>
      Bun.serve<{ sessionToken: string | null }>({
        port: config.port,
        hostname: config.host,
        tls: config.tls,
        async fetch(req, server) {
          const requestPathname = rawRequestPathname(req.url);
          let url: URL;
          try {
            url = new URL(req.url);
          } catch {
            return new Response("invalid request URL", { status: 400 });
          }

          const tokenLoginResponse = handleTokenLogin(req);
          if (tokenLoginResponse) return tokenLoginResponse;

          if (url.pathname === "/health" || url.pathname === "/healthz") {
            return new Response("Ok", {
              status: 200,
              headers: { "content-type": "text/plain; charset=utf-8" },
            });
          }

          // Auth endpoints are always reachable.
          if (url.pathname === "/api/login" && req.method === "POST") {
            return handleLogin(req);
          }
          if (url.pathname === "/login") {
            return loginPage();
          }
          // The login page's logo and favicon must also work before login.
          if (url.pathname === "/roamgate-icon-192.png") {
            return serveStatic(req, config.publicDir);
          }
          if (url.pathname === "/api/logout") {
            const response = handleLogout(req);
            const token = sessionToken(req);
            if (response.ok && config.authRequired && token) {
              for (const client of clients) {
                if (clientSessions.get(client) !== token) continue;
                webSocketCleanup.cleanup(client);
                client.close(4001, "Logged out");
              }
            }
            return response;
          }

          // Everything else requires auth when bound to a non-localhost address.
          if (!isAuthed(req)) {
            const accept = req.headers.get("accept") ?? "";
            if (req.method === "GET" && accept.includes("text/html")) {
              return unauthenticatedLoginRedirect();
            }
            return new Response("unauthorized", { status: 401 });
          }

          if (url.pathname === "/ws") {
            if (
              server.upgrade(req, { data: { sessionToken: sessionToken(req) } })
            )
              return undefined;
            return new Response("websocket upgrade failed", { status: 400 });
          }
          if (url.pathname === "/api/notifications/push") {
            return webPush.handle(req);
          }
          if (url.pathname === "/api/health") {
            return Response.json({
              ok: true,
              version: APP_VERSION,
              socket: config.socketPath,
              auth_required: config.authRequired,
            });
          }
          if (url.pathname === "/api/update/check" && req.method === "GET") {
            server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
            return handleUpdateCheck(req);
          }
          if (url.pathname === "/api/update/install" && req.method === "POST") {
            // Binary download and verification can exceed Bun's default ten-second
            // request timeout. Keep the larger budget scoped to update requests.
            server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
            return handleUpdateInstall(req);
          }
          if (url.pathname === "/api/herdr/status" && req.method === "GET") {
            return handleHerdrStatus();
          }
          if (url.pathname === "/api/herdr/setup" && req.method === "POST") {
            // Herdr download plus service start shares the update budget.
            server.timeout(req, UPDATE_HTTP_IDLE_TIMEOUT_SECONDS);
            return handleHerdrSetup(req);
          }
          const connectionRoute = parseConnectionHttpRoute(
            requestPathname,
            req.method,
          );
          if (connectionRoute) {
            return handleConnectionHttpRequest(connectionRoute, url, req);
          }
          // Everything else: serve the built frontend (embedded or on-disk).
          return serveStatic(req, config.publicDir);
        },
        websocket: {
          perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
          open(ws) {
            clients.add(ws);
            clientSessions.set(ws, ws.data.sessionToken);
            const label = assignClientId(ws);
            logger.debug("client connected", {
              client: label,
              clients: clients.size,
            });
            notifyBrowserClientCount();
            safeSend(
              ws,
              JSON.stringify({
                hello: true,
                socket: config.socketPath,
                bridge_protocol_version: 2,
                default_connection_id: connectionManager.defaultId(),
                capabilities: {
                  connection_id: true,
                  connection_scoped_http: true,
                  connection_runtime_generation: true,
                },
              }),
              "hello",
            );
          },
          drain(ws) {
            // The viewer caught up: send the newest repaint we held back.
            flushCoalescedMessages(ws, {
              cleanup: () => {
                webSocketCleanup.cleanup(ws);
              },
              warn: (detail) =>
                logger.warn("websocket send failed", {
                  detail: detail.replace(/^\[bridge\] /, ""),
                }),
            });
          },
          message(ws, message) {
            if (!clients.has(ws)) return;
            const text =
              typeof message === "string" ? message : message.toString();
            const { id, method, connectionId, connectionGeneration } =
              parseRpcMeta(text);
            const startedAt = Date.now();
            let responseConnectionId: string | null = null;
            let logConnectionId: string | null = null;
            if (method && !isBridgeGlobalMethod(method)) {
              if (connectionId === undefined) {
                responseConnectionId = connectionManager.defaultId();
                logConnectionId = responseConnectionId;
              } else {
                try {
                  responseConnectionId = validateConnectionId(connectionId);
                  logConnectionId = responseConnectionId;
                } catch {
                  logConnectionId = "invalid";
                }
              }
            }
            handleRpc(ws, text)
              .then(() => {
                const outcome = takeRpcOutcome(ws, id);
                logRpc(
                  ws,
                  method,
                  startedAt,
                  outcome?.status ?? "ok",
                  logConnectionId,
                  outcome?.detail,
                );
              })
              .catch((e) => {
                logRpc(
                  ws,
                  method,
                  startedAt,
                  "error",
                  logConnectionId,
                  (e as Error).message,
                );
                const errorMessage: Record<string, unknown> = {
                  error: { message: (e as Error).message },
                };
                if (id) errorMessage.id = id;
                safeSend(
                  ws,
                  responseConnectionId
                    ? serializeConnectionEnvelope(
                        responseConnectionId,
                        errorMessage,
                        typeof connectionGeneration === "number"
                          ? connectionGeneration
                          : undefined,
                      )
                    : JSON.stringify(errorMessage),
                  "message-error",
                );
              });
          },
          close(ws) {
            const { client, viewedTerminals } = webSocketCleanup.complete(ws);
            logger.debug("client disconnected", {
              client,
              clients: clients.size,
              terminals: viewedTerminals.length
                ? viewedTerminals.join(",")
                : "none",
            });
          },
        },
      }),
    startConnection: async () => {
      await connectionProfiles.startConfigured();
      notifyBrowserClientCount();
      const runtime = connectionManager.defaultReadyRuntime();
      void runtime?.herdr
        .ping()
        .then((ping) =>
          logger.info("Herdr reachable", {
            connection: runtime.identity.id,
            version: ping.version,
            protocol: ping.protocol,
          }),
        )
        .catch((error) =>
          logger.warn("Herdr not reachable yet", {
            connection: runtime.identity.id,
            error: sanitizeConnectionError(error),
            action: "run `roamgate herdr setup`; RPCs retry per request",
          }),
        );
    },
    onConnectionError: (error) => {
      logger.warn("default connection startup failed", {
        error: sanitizeConnectionError(error),
      });
    },
  });
  const listeningPort = server.port ?? config.port;
  const publicBrowserUrl = browserUrlFor(
    config.host,
    listeningPort,
    Boolean(config.tls),
  );
  logger.info("listening", {
    url: publicBrowserUrl,
    websocket: "/ws",
    log_level: config.logLevel,
  });
  if (config.authRequired) {
    if (config.generatedAuthTokenPath) {
      logger.info("authentication required", {
        mode: "generated token",
        path: config.generatedAuthTokenPath,
      });
    } else {
      logger.info("authentication required", { mode: "password" });
    }
  }
  logger.debug("Herdr sockets configured", {
    control_socket: config.socketPath,
    client_socket: config.clientSocketPath,
    public_dir: config.publicDir,
  });
  logger.info("browser URL", { url: publicBrowserUrl });

  const browserUrl = withLoginToken(
    publicBrowserUrl,
    config.generatedAuthToken,
  );
  if (isAnyHost(config.host)) {
    const lanUrls = getLanIPs().map((ip) =>
      browserUrlFor(ip, listeningPort, Boolean(config.tls)),
    );
    if (lanUrls.length > 0) {
      for (const url of lanUrls) logger.info("LAN URL", { url });
    } else {
      logger.warn("no LAN IPv4 address detected");
    }
  }
  openBrowser(config, browserUrl);
}

let managerStopTask: Promise<void> | null = null;
function stopManagerOnce(): Promise<void> {
  webPush.stop();
  connectionProfiles.stopSupervision();
  managerStopTask ??= connectionManager.stopAll();
  return managerStopTask;
}

const shutdownController = createShutdownController({
  stop: stopManagerOnce,
  exit: (code) => process.exit(code),
  onStopError: (error) => {
    logger.error("connection shutdown failed", {
      error: sanitizeConnectionError(error),
    });
  },
});

function scheduleManagedShutdown(): void {
  const timer = setTimeout(() => {
    void shutdownController.request(0);
  }, 1_000);
  timer.unref();
}

process.on("exit", () => {
  void stopManagerOnce();
});
process.on("SIGINT", () => {
  void shutdownController.request(130);
});
process.on("SIGTERM", () => {
  void shutdownController.request(143);
});

try {
  main();
} catch (e) {
  logger.error("fatal startup error", { error: e });
  void shutdownController.request(1);
}
