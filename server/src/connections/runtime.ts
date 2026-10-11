import {
  createTaskEventTracker,
  type TaskEvent,
} from "../notifications/task-events";
import {
  createHerdrNotificationListener,
  taskEventFromSemanticNotification,
  type TaskNotificationSource,
} from "../notifications/herdr-notification-listener";
import {
  assertEndpointCreationSource,
  createEmptyWorkspaceCreator,
} from "../bridge/endpoint-creation";
import type { ServerWebSocket } from "bun";
import { createAgentSessionHandlers } from "../agent/agent-sessions";
import { createAgentSessionFileAccess } from "../agent/session-file-access";
import { HerdrClient } from "../bridge/herdr-client";
import {
  EndpointClient,
  type EndpointSnapshot,
} from "../bridge/endpoint-client";
import {
  assertSupportedHerdrProtocol,
  isTerminalHelloProtocol,
} from "../bridge/protocol-compat";
import { roamgateEnv } from "../config/environment";
import { createSettingsRpcHandler } from "../bridge/settings-rpc";
import {
  readGuiSettings,
  terminalSurfaceCodecsEnabled,
} from "../config/gui-settings";
import {
  createSshTunnelManager,
  type SshTunnelConfig,
  type SshTunnelError,
} from "../bridge/ssh-tunnel";
import { dropCoalescedMessage } from "../bridge/websocket-send";
import { createTerminalBridge } from "../bridge/terminal-bridge";
import { createHerdrInfoHandler } from "../http/herdr-info";
import { createImageUploadHandler } from "../http/image-upload";
import { createTerminalUploadHandler } from "../http/terminal-upload";
import {
  createRecoveryReporter,
  type Logger,
  silentLogger,
} from "../utils/logger";
import {
  runProcess,
  runProcessWithCode,
  runProcessWithCodeTimeout,
  shQuote,
} from "../utils/process-utils";
import { createWorkspaceAutoSync } from "../workspace/auto-sync";
import { createFileHandlers } from "../workspace/files";
import {
  createLastStepBaselineStore,
  type LastStepBaselineStore,
} from "../workspace/git-diff";
import { createLastStepTurnTracker } from "../workspace/last-step-turns";
import { runBinaryProcessWithTimeout } from "../workspace/process";
import { createStatusEnricher } from "../workspace/status";
import { createWorktreeHookRunner } from "../worktree/worktree-hooks";
import { createWorktreeParentStore } from "../worktree/parents";
import {
  createWorktreeRemovalCoordinator,
  createWorktreeRemovalRuntime,
} from "../worktree/remove";
import { createAgentStatusSubscriptionLoop } from "./agent-status-subscription";
import { sanitizeConnectionError } from "./manager";
import { createEventSubscriptionLoop } from "./subscription-loop";
import { type ConnectionIdentity, LEGACY_DEFAULT_CONNECTION } from "./types";

const DEFAULT_EVENTS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "workspace.focused",
  "workspace.moved",
  "workspace.reordered",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.focused",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
];

type SafeSend = (
  ws: ServerWebSocket<unknown>,
  payload: string,
  context?: string,
) => boolean;

type MarkRpcError = (
  ws: ServerWebSocket<unknown>,
  id: string | null | undefined,
  detail?: string,
) => void;

export function createLegacyConnectionRuntime(args: {
  identity?: ConnectionIdentity;
  connectionGeneration?: number;
  config: SshTunnelConfig;
  logger?: Logger;
  safeSend: SafeSend;
  broadcast?: (payload: string, context?: string) => void;
  clientLabel: (ws: ServerWebSocket<unknown>) => string;
  markRpcError: MarkRpcError;
  onEvent: (event: unknown, identity: ConnectionIdentity) => void;
  onTaskEvent?: (event: TaskEvent) => void;
  /** Defaults to `status`; the server entrypoint selects `herdr` by default. */
  taskNotificationSource?: TaskNotificationSource;
  onError?: (error: unknown, identity: ConnectionIdentity) => void;
  onTransportExit?: (error: SshTunnelError) => void;
  /** Test seam for deterministic shutdown coverage. */
  lastStepBaselines?: LastStepBaselineStore;
  resolveLastStepWorkspaceGitRoot?: (workspaceId: string) => Promise<string>;
  lastStepTransitionDebounceMs?: number;
}) {
  const { config } = args;
  const remotePlatform = config.remotePlatform;
  const logger = args.logger ?? silentLogger;
  const identity = { ...(args.identity ?? LEGACY_DEFAULT_CONNECTION) };
  const socketPath = config.socketPath;
  const clientSocketPath = config.clientSocketPath;
  const sshHost = () => config.sshHost;
  const herdr = new HerdrClient(socketPath);
  const agentSessionFiles = createAgentSessionFileAccess({
    sshHost: config.sshHost,
    runBinaryProcessWithTimeout,
    shQuote,
  });
  const agentSessions = createAgentSessionHandlers({
    herdrCall: (method, params) => herdr.call(method, params),
    files: agentSessionFiles,
  });
  const worktreeParents = createWorktreeParentStore({
    connectionId: identity.id,
    herdr,
    sshHost,
  });
  const { handleHerdrInfo } = createHerdrInfoHandler({
    ping: () => herdr.ping(),
  });
  const lastStepBaselines =
    args.lastStepBaselines ??
    createLastStepBaselineStore({
      host: sshHost(),
      runProcessWithCodeTimeout,
      shQuote,
    });
  const files = createFileHandlers({
    herdr,
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
    lastStepBaselines,
  });
  const status = createStatusEnricher({
    connectionId: identity.id,
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
  });
  const workspaceAutoSync = createWorkspaceAutoSync({
    connectionId: identity.id,
    logger: logger.child("auto-sync"),
    formatError: sanitizeConnectionError,
    herdr,
    sshHost,
    runProcessWithCodeTimeout,
    shQuote,
    invalidateGitStatus: status.invalidateGitStatus,
    resolveWorkspaceGitRoot: async (workspaceId) =>
      files.resolveWorkspaceGitRoot({ workspace_id: workspaceId }),
  });
  const worktreeHooks = createWorktreeHookRunner({
    connectionId: identity.id,
    herdr,
    sshHost,
    runProcess,
    runProcessWithCode,
    shQuote,
  });
  const worktreeRemovalCoordinator = createWorktreeRemovalCoordinator();
  const worktreeRemovalRuntime = createWorktreeRemovalRuntime({
    host: sshHost(),
    runProcessWithCodeTimeout,
    shQuote,
  });
  const handleImageUpload = createImageUploadHandler({ sshHost });
  const onUploadCleanupError = (error: unknown) =>
    logger.warn("terminal upload cleanup failed", {
      connection: identity.id,
      error: sanitizeConnectionError(error),
    });
  const handleTerminalUpload = createTerminalUploadHandler({
    sshHost,
    onCleanupError: onUploadCleanupError,
  });
  const sshTunnel = createSshTunnelManager({
    connectionId: identity.id,
    logger: logger.child("ssh"),
    formatError: sanitizeConnectionError,
    config,
    runProcess,
    onUnexpectedExit: args.onTransportExit,
  });
  const handleSettingsRpc = createSettingsRpcHandler({
    connectionId: identity.id,
    connectionGeneration: args.connectionGeneration,
    herdr,
    sshHost,
    readWorktreeHooks: worktreeHooks.readWorktreeHooks,
    resolveWorkspaceGitRoot: async (workspaceId) =>
      files.resolveWorkspaceGitRoot({ workspace_id: workspaceId }),
    workspaceAutoSyncIsRunning: workspaceAutoSync.isRunning,
    onWorkspaceAutoSyncSettingsChanged: workspaceAutoSync.settingsChanged,
    onTerminalTransportSettingsChanged: (enabled) => {
      if (disposed) return;
      terminalBridge.refreshSurfaceCodecs();
      args.onEvent(
        {
          event: "settings.terminal_transport.updated",
          data: { surface_codecs: enabled },
        },
        identity,
      );
    },
    safeSend: args.safeSend,
    markRpcError: args.markRpcError,
  });
  const terminalBridge = createTerminalBridge({
    connectionId: identity.id,
    broadcast: args.broadcast,
    logger: logger.child("terminal"),
    connectionGeneration: args.connectionGeneration,
    formatError: sanitizeConnectionError,
    clientSocketPath,
    surfaceCodecsEnabled: async () =>
      terminalSurfaceCodecsEnabled(await readGuiSettings(), identity.id),
    herdrProtocol: async () => {
      const protocol: unknown = (await herdr.ping()).protocol;
      assertSupportedHerdrProtocol(protocol);
      return protocol;
    },
    createEmptyWorkspace: createEmptyWorkspaceCreator(
      (method, params, timeoutMs) => herdr.call(method, params, timeoutMs),
    ),
    validateCreationSource: async (source) => {
      const result = await herdr.call(
        "pane.get",
        { pane_id: source.pane_id },
        5000,
      );
      assertEndpointCreationSource(source, result?.pane);
    },
    focusedWorkspaceId: async () => {
      const result = await herdr.call("workspace.list", {}, 5000);
      return (
        result?.workspaces?.find(
          (workspace: { focused?: boolean }) => workspace.focused,
        )?.workspace_id ?? null
      );
    },
    lookupPaneId: async (terminalId) => {
      try {
        const result = await herdr.call("pane.list", {}, 5000);
        const panes = (result as { panes?: unknown } | null)?.panes;
        if (!Array.isArray(panes)) return null;
        for (const pane of panes) {
          if (!pane || typeof pane !== "object" || Array.isArray(pane))
            continue;
          const record = pane as { pane_id?: unknown; terminal_id?: unknown };
          if (
            record.terminal_id === terminalId &&
            typeof record.pane_id === "string" &&
            record.pane_id.length > 0
          ) {
            return record.pane_id;
          }
        }
        return null;
      } catch {
        return null;
      }
    },
    safeSend: args.safeSend,
    dropCoalesced: dropCoalescedMessage,
    clientLabel: args.clientLabel,
    markRpcError: args.markRpcError,
    confirmRelayResize: async ({ cols, rows, paneId }) => {
      if (!paneId) return false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const result = await herdr.call("pane.layout", { pane_id: paneId });
          const area = result?.layout?.area;
          if (
            area &&
            Number(area.x) + Number(area.width) === cols &&
            Number(area.y) + Number(area.height) === rows
          ) {
            return true;
          }
        } catch {
          return false;
        }
        await Bun.sleep(50);
      }
      return false;
    },
  });

  const lastStepTurns = createLastStepTurnTracker({
    captureWorkspaceBaseline: async (workspaceId) => {
      if (remotePlatform === "windows") return;
      await lastStepBaselines.captureWorkspace(workspaceId, async () => {
        if (args.resolveLastStepWorkspaceGitRoot) {
          return args.resolveLastStepWorkspaceGitRoot(workspaceId);
        }
        const { root } = await files.resolveWorkspaceGitRoot({
          workspace_id: workspaceId,
        });
        return root;
      });
    },
    completeWorkspaceStep: async (workspaceId) => {
      const published = await lastStepBaselines.completeWorkspace(workspaceId);
      if (!published || disposed) return;
      args.onEvent(
        {
          event: "workspace.last_step_completed",
          data: {
            type: "workspace.last_step_completed",
            workspace_id: workspaceId,
          },
        },
        identity,
      );
    },
    onCaptureError: (error, workspaceId) =>
      logger.warn("last-step baseline failed", {
        connection: identity.id,
        workspace: workspaceId,
        error: sanitizeConnectionError(error),
      }),
    onCompleteError: (error, workspaceId) =>
      logger.warn("last-step completion failed", {
        connection: identity.id,
        workspace: workspaceId,
        error: sanitizeConnectionError(error),
      }),
    transitionDebounceMs: args.lastStepTransitionDebounceMs ?? 150,
  });
  const agentStatusRecovery = createRecoveryReporter({
    logger: logger.child("agent-status"),
    failureMessage: "agent status subscription failed",
    recoveryMessage: "agent status subscription recovered",
  });
  const taskNotificationSource = args.taskNotificationSource ?? "status";
  // Set when Herdr lacks endpoint support (< 0.9 or endpoints disabled); a
  // temporarily disconnected 0.9 server does not fall back, avoiding duplicates.
  let herdrNotificationsUnavailable = false;
  const relayTaskEvent = (event: TaskEvent) => {
    args.onTaskEvent?.(event);
    // Pages disable their own tracker when the bridge relays notifications.
    args.onEvent(
      {
        event: "roamgate.task_notification",
        data: {
          type: "roamgate.task_notification",
          kind: event.kind,
          agent: event.agent,
          title:
            event.title ??
            (event.kind === "blocked" ? "Agent needs input" : "Task completed"),
          body:
            event.body ??
            ([event.workspaceLabel?.trim(), event.tabLabel?.trim()]
              .filter(Boolean)
              .join(" \u00b7 ") ||
              null),
          workspace_id: event.workspaceId ?? null,
          tab_id: event.tabId ?? null,
          pane_id: event.paneId ?? null,
        },
      },
      identity,
    );
  };
  const pendingTaskEvents = new Map<string, TaskEvent>();
  const taskEvents = createTaskEventTracker(async (event) => {
    // Status events publish in status mode, or as the legacy-Herdr fallback.
    const publishes =
      taskNotificationSource === "status"
        ? Boolean(args.onTaskEvent)
        : herdrNotificationsUnavailable;
    const paneId = event.paneId;
    if (!publishes || disposed || !paneId) return;
    pendingTaskEvents.set(paneId, event);
    // Resolve labels on demand so push works without a browser and after renames.
    const [workspaceResult, tabResult] = await Promise.all([
      herdr
        .call("workspace.get", { workspace_id: event.workspaceId }, 5000)
        .catch(() => null),
      herdr
        .call("tab.list", { workspace_id: event.workspaceId }, 5000)
        .catch(() => null),
    ]);
    // An older lookup must not publish over a newer notification for this pane.
    if (disposed || pendingTaskEvents.get(paneId) !== event) return;
    pendingTaskEvents.delete(paneId);
    const workspaceLabel = workspaceResult?.workspace?.label;
    const tab = Array.isArray(tabResult?.tabs)
      ? tabResult.tabs.find(
          (tab: { tab_id?: unknown; workspace_id?: unknown } | null) =>
            tab?.tab_id === event.tabId &&
            tab?.workspace_id === event.workspaceId,
        )
      : undefined;
    const labeled: TaskEvent = {
      ...event,
      workspaceLabel:
        typeof workspaceLabel === "string" ? workspaceLabel : undefined,
      tabLabel: typeof tab?.label === "string" ? tab.label : undefined,
    };
    if (taskNotificationSource === "status") args.onTaskEvent?.(labeled);
    else if (herdrNotificationsUnavailable) relayTaskEvent(labeled);
  });
  const herdrNotificationRecovery = createRecoveryReporter({
    logger: logger.child("notifications"),
    failureMessage: "Herdr notification shell failed",
    recoveryMessage: "Herdr notification shell recovered",
  });
  const herdrNotifications =
    taskNotificationSource === "herdr"
      ? createHerdrNotificationListener({
          clientSocketPath,
          // Same gate as endpoint terminal sessions (see navigationMode).
          isAvailable: async () =>
            roamgateEnv("DISABLE_ENDPOINT") !== "1" &&
            isTerminalHelloProtocol((await herdr.ping()).protocol),
          onUnavailable: () => {
            if (!herdrNotificationsUnavailable)
              logger.info(
                "Herdr notifications need Herdr >= 0.9; using agent status",
                { connection: identity.id },
              );
            herdrNotificationsUnavailable = true;
          },
          onConnected: () => {
            herdrNotificationsUnavailable = false;
            if (
              !herdrNotificationRecovery.recovered({ connection: identity.id })
            ) {
              logger.info("listening for Herdr notifications", {
                connection: identity.id,
              });
            }
          },
          onError: (error) =>
            herdrNotificationRecovery.failure(sanitizeConnectionError(error), {
              connection: identity.id,
            }),
          onNotification: (notification) => {
            if (disposed) return;
            const event = taskEventFromSemanticNotification(notification);
            logger.debug("Herdr notification", {
              connection: identity.id,
              kind: notification.kind,
              forwarded: event !== null,
            });
            if (event) relayTaskEvent(event);
          },
        })
      : null;
  let taskListRevision = 0;
  const agentStatusSubscriptions = createAgentStatusSubscriptionLoop({
    herdr,
    connectionId: identity.id,
    onSubscribeError: (error) =>
      agentStatusRecovery.failure(sanitizeConnectionError(error), {
        connection: identity.id,
      }),
    onListError: (error) =>
      agentStatusRecovery.failure(sanitizeConnectionError(error), {
        connection: identity.id,
        operation: "pane list",
      }),
    onPaneListStart: () => {
      taskListRevision = taskEvents.beginPaneList();
      return lastStepTurns.beginPaneList();
    },
    onPaneList: (result, revision) => {
      taskEvents.reconcilePaneList(result, taskListRevision);
      lastStepTurns.reconcilePaneList(result, revision);
    },
    log: (message) => {
      agentStatusRecovery.recovered({ connection: identity.id });
      logger.debug(message, { connection: identity.id });
    },
  });

  const onHerdrEvent = (event: unknown) => {
    taskEvents.handleHerdrEvent(event);
    lastStepTurns.handleHerdrEvent(event);
    agentStatusSubscriptions.handleHerdrEvent(event);
    if ((event as { event?: string })?.event === "workspace.focused")
      terminalBridge.refreshPopupObserverFocus();
    args.onEvent(event, identity);
  };
  const onHerdrError = (error: unknown) => args.onError?.(error, identity);
  herdr.on("event", onHerdrEvent);
  herdr.on("error", onHerdrError);

  const eventSubscriptionRecovery = createRecoveryReporter({
    logger: logger.child("events"),
    failureMessage: "event subscription failed",
    recoveryMessage: "event subscription recovered",
  });
  const subscriptionLoop = createEventSubscriptionLoop({
    subscribe: () => herdr.subscribe(DEFAULT_EVENTS),
    onReady: () => {
      // Browser snapshots may start before the subscription ACK. Reconcile
      // after every ACK (including reconnect) to close that missed-event gap.
      // The browser's generic refresh path queues another snapshot if busy.
      args.onEvent({ event: "session.resync_required", data: {} }, identity);
      if (!eventSubscriptionRecovery.recovered({ connection: identity.id })) {
        logger.info("subscribed to Herdr events", { connection: identity.id });
      }
    },
    onSubscribeError: (error) =>
      eventSubscriptionRecovery.failure(sanitizeConnectionError(error), {
        connection: identity.id,
        retry_ms: 2_000,
      }),
    onSubscriptionClosed: () =>
      eventSubscriptionRecovery.failure("subscription closed", {
        connection: identity.id,
        retry_ms: 2_000,
      }),
  });

  let transportStart: Promise<void> | null = null;
  let transportStarted = false;
  let backgroundStarted = false;
  let disposed = false;
  let stopTask: Promise<void> | null = null;

  async function recoveryIdentity(
    signal?: AbortSignal,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    if (disposed) throw new Error("connection runtime is disposed");
    if (roamgateEnv("DISABLE_ENDPOINT") === "1") return null;
    const ping = await herdr.call("ping", {}, 5_000);
    signal?.throwIfAborted();
    if (disposed) throw new Error("connection runtime is disposed");
    if (!isTerminalHelloProtocol(ping.protocol)) return null;
    // A passive handshake reads the existing server boot identity without a
    // terminal attachment or another long-lived background connection.
    const client = new EndpointClient(clientSocketPath, false, "notifications");
    let bootId: string | null = null;
    client.on("snapshot", (snapshot: EndpointSnapshot) => {
      bootId = snapshot.bootId || null;
    });
    client.on("error", () => {});
    const abort = () => client.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await client.connect(80, 24);
      signal?.throwIfAborted();
      if (disposed) throw new Error("connection runtime is disposed");
      return bootId;
    } finally {
      signal?.removeEventListener("abort", abort);
      client.close();
    }
  }

  async function startTransport() {
    if (disposed) throw new Error("connection runtime is disposed");
    if (transportStarted) return;
    if (transportStart) return transportStart;
    transportStart = sshTunnel
      .startAutoSshTunnel()
      .then(() => {
        if (!disposed) transportStarted = true;
      })
      .finally(() => {
        transportStart = null;
      });
    return transportStart;
  }

  function startBackground() {
    if (disposed) throw new Error("connection runtime is disposed");
    if (backgroundStarted) return;
    backgroundStarted = true;
    if (remotePlatform !== "windows") {
      void handleTerminalUpload.startCleanup().catch(onUploadCleanupError);
      workspaceAutoSync.start();
    }
    subscriptionLoop.start();
    agentStatusSubscriptions.start();
    herdrNotifications?.start();
  }

  function stop() {
    if (stopTask) return stopTask;
    if (disposed) return Promise.resolve();
    disposed = true;
    backgroundStarted = false;
    handleTerminalUpload.stopCleanup();
    herdr.off("event", onHerdrEvent);
    herdr.off("error", onHerdrError);
    taskEvents.stop();
    pendingTaskEvents.clear();
    herdrNotifications?.stop();
    const autoSyncStop = workspaceAutoSync.stop();
    terminalBridge.dispose();
    const subscriptionStop = subscriptionLoop.stop();
    const agentStatusStop = agentStatusSubscriptions.stop();
    const lastStepStop = lastStepTurns
      .stop()
      .then(() => lastStepBaselines.dispose());
    const transportCleanup = sshTunnel.cleanupAutoSshTunnel();
    const transportStop =
      transportStart?.catch(() => undefined) ?? Promise.resolve();
    stopTask = Promise.all([
      autoSyncStop,
      subscriptionStop,
      agentStatusStop,
      lastStepStop,
      transportCleanup,
      transportStop,
    ]).then(() => undefined);
    return stopTask;
  }

  return {
    identity,
    socketPath,
    clientSocketPath,
    remotePlatform,
    sshHost,
    herdr,
    worktreeParents,
    handleHerdrInfo,
    handleImageUpload,
    handleTerminalUpload,
    handleSettingsRpc,
    files,
    status,
    workspaceAutoSync,
    worktreeHooks,
    worktreeRemovalCoordinator,
    worktreeRemovalRuntime,
    terminalBridge,
    agentSessions,
    recoveryIdentity,
    taskNotificationSource,
    startTransport,
    startBackground,
    stop,
  };
}

export type LegacyConnectionRuntime = ReturnType<
  typeof createLegacyConnectionRuntime
>;
