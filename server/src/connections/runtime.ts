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
import {
  antigravityHome,
  findAntigravitySessionForCwd,
} from "../agent/antigravity-session";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { sshCommandArgv } from "../bridge/ssh-command";
import {
  createTabAutoRenamer,
  isGenericTerminalTitle,
} from "./tab-auto-rename";
import { sanitizeConnectionError } from "./manager";
import { createEventSubscriptionLoop } from "./subscription-loop";
import { type ConnectionIdentity, LEGACY_DEFAULT_CONNECTION } from "./types";
import { unixOnlyHandlers } from "./unix-only";

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
  // These helper groups run Unix shell commands over SSH.
  const agentSessions = unixOnlyHandlers(
    remotePlatform,
    "Agent history",
    createAgentSessionHandlers({
      herdrCall: (...args) => herdr.call(...args),
      files: agentSessionFiles,
    }),
  );
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
  const files = unixOnlyHandlers(
    remotePlatform,
    "Workspace file and Git access",
    createFileHandlers({
      herdr,
      sshHost,
      runProcessWithCodeTimeout,
      shQuote,
      lastStepBaselines,
    }),
  );
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
  const worktreeHooks = unixOnlyHandlers(
    remotePlatform,
    "Worktree hook access",
    createWorktreeHookRunner({
      connectionId: identity.id,
      herdr,
      sshHost,
      runProcess,
      runProcessWithCode,
      shQuote,
    }),
  );
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
      try {
        await lastStepBaselines.completeWorkspace(workspaceId);
      } finally {
        // File refresh depends on step completion, not Git snapshot availability.
        if (!disposed) {
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
        }
      }
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

  async function readHermesSqliteTitle(
    sshHost?: string,
  ): Promise<string | null> {
    const pythonScript =
      "import sqlite3, os\n" +
      'db = os.path.expanduser("~/.hermes/state.db")\n' +
      "if os.path.exists(db):\n" +
      "    try:\n" +
      "        conn = sqlite3.connect(db)\n" +
      "        row = conn.execute(\"SELECT title FROM sessions WHERE title IS NOT NULL AND title != '' ORDER BY started_at DESC LIMIT 1\").fetchone()\n" +
      "        if row and row[0]:\n" +
      "            print(row[0].strip())\n" +
      "    except Exception:\n" +
      "        pass\n";
    if (sshHost) {
      try {
        const res = await runBinaryProcessWithTimeout(
          sshCommandArgv(sshHost, `python3 -c ${shQuote(pythonScript)}`),
          3000,
        );
        if (res.code === 0) {
          const out = res.stdout.toString("utf8").trim();
          return out.length > 0 ? out : null;
        }
      } catch {}
    } else {
      try {
        const dbPath = join(homedir(), ".hermes", "state.db");
        if (existsSync(dbPath)) {
          const { Database } = await import("bun:sqlite");
          const db = new Database(dbPath, { readonly: true });
          const row = db
            .query(
              "SELECT title FROM sessions WHERE title IS NOT NULL AND title != '' ORDER BY started_at DESC LIMIT 1",
            )
            .get() as { title?: string } | null;
          db.close();
          if (row?.title && typeof row.title === "string") {
            const trimmed = row.title.trim();
            return trimmed.length > 0 ? trimmed : null;
          }
        }
      } catch {}
    }
    return null;
  }

  async function readAntigravityTitle(
    cwd?: string,
    sshHost?: string,
  ): Promise<string | null> {
    if (sshHost) {
      const pythonScript =
        "import os, glob, re\n" +
        "home = os.path.expanduser('~/.gemini/antigravity-cli/annotations')\n" +
        "files = glob.glob(os.path.join(home, '*.pbtxt'))\n" +
        "if files:\n" +
        "    files.sort(key=os.path.getmtime, reverse=True)\n" +
        "    try:\n" +
        "        with open(files[0], 'r', encoding='utf-8') as f:\n" +
        '            m = re.search(r\'title:\\s*"([^"]+)"\', f.read())\n' +
        "            if m:\n" +
        "                print(m.group(1).strip())\n" +
        "    except Exception:\n" +
        "        pass\n";
      try {
        const res = await runBinaryProcessWithTimeout(
          sshCommandArgv(sshHost, `python3 -c ${shQuote(pythonScript)}`),
          3000,
        );
        if (res.code === 0) {
          const out = res.stdout.toString("utf8").trim();
          return out.length > 0 ? out : null;
        }
      } catch {}
    } else {
      try {
        if (cwd) {
          const desc = await findAntigravitySessionForCwd(cwd);
          if (desc?.session.sessionId) {
            const pbtxt = join(
              antigravityHome(),
              "annotations",
              `${desc.session.sessionId}.pbtxt`,
            );
            if (existsSync(pbtxt)) {
              const text = await Bun.file(pbtxt).text();
              const match = text.match(/title:\s*"([^"]+)"/);
              if (match?.[1]) {
                const trimmed = match[1].trim();
                if (trimmed) return trimmed;
              }
            }
          }
        }
      } catch {}
    }
    return null;
  }

  const tabAutoRenamer = createTabAutoRenamer({
    herdr,
    getAgentTitleForPane: async (paneId, candidatePane) => {
      // 1. Try reading summary title from agentSessions
      try {
        const summary = (await agentSessions.readSummary({
          pane_id: paneId,
        })) as {
          title?: string | null;
        };
        if (summary?.title && typeof summary.title === "string") {
          const trimmed = summary.title.trim();
          if (trimmed) return trimmed;
        }
      } catch {}

      // 2. If Hermes, check SQLite state.db
      if (candidatePane?.agent === "hermes") {
        try {
          const hermesTitle = await readHermesSqliteTitle(config.sshHost);
          if (hermesTitle) return hermesTitle;
        } catch {}
      }

      // 3. If Antigravity (agy), check annotations
      if (candidatePane?.agent === "agy") {
        try {
          const agyTitle = await readAntigravityTitle(
            candidatePane.cwd,
            config.sshHost,
          );
          if (agyTitle) return agyTitle;
        } catch {}
      }

      // 4. Fallback to pane / agent terminal_title_stripped or terminal_title
      try {
        let stripped = candidatePane?.terminal_title_stripped;
        let raw = candidatePane?.terminal_title;

        if (!stripped && !raw) {
          const agentInfo = (await herdr.call(
            "agent.get",
            { target: paneId },
            5000,
          )) as {
            agent?: {
              terminal_title_stripped?: string;
              terminal_title?: string;
            };
          } | null;
          stripped = agentInfo?.agent?.terminal_title_stripped;
          raw = agentInfo?.agent?.terminal_title;
        }

        if (typeof stripped === "string") {
          const trimmed = stripped.trim();
          if (trimmed && !isGenericTerminalTitle(trimmed)) {
            return trimmed;
          }
        }

        if (typeof raw === "string") {
          const cleaned = raw.replace(/^[\s✳*•]+/, "").trim();
          if (cleaned && !isGenericTerminalTitle(cleaned)) {
            return cleaned;
          }
        }
      } catch {}

      return null;
    },
    isEnabled: async () => {
      const settings = await readGuiSettings().catch(() => null);
      return settings?.auto_rename_agent_tabs !== false;
    },
    pollIntervalMs: 3000,
    log: (message) => logger.debug(message, { connection: identity.id }),
  });

  const onHerdrEvent = (event: unknown) => {
    taskEvents.handleHerdrEvent(event);
    lastStepTurns.handleHerdrEvent(event);
    agentStatusSubscriptions.handleHerdrEvent(event);
    tabAutoRenamer.handleHerdrEvent(event);
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
    tabAutoRenamer.dispose();
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
    tabAutoRenamer,
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
