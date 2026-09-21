import { roamgateLocalStorage, roamgateSessionStorage } from "./browserStorage";
import { syncTaskPush, type TaskNotificationPreferences } from "./taskPush";
import {
  isTaskNotificationTarget,
  prepareTaskNotifications,
  showTaskNotification,
  type TaskNotificationTarget,
} from "./taskNotifications";
export {
  bindTaskNotificationActivation,
  isTaskNotificationTarget,
  TASK_NOTIFICATION_ACTIVATE_EVENT,
  type TaskNotificationTarget,
} from "./taskNotifications";
import { withAgentActivity } from "./agentOrder";
import {
  type EndpointAvailability,
  parseEndpointAdvertisement,
  parseEndpointAvailability,
  endpointMethodReason,
} from "./endpointAvailability";
import {
  type BrowserNavigation,
  emptyBrowserNavigation,
  selectBrowserTarget,
  projectBrowserNavigation,
  projectBrowserLayout,
  browserPaneInDirection,
} from "./browserNavigation";
import { useRef, useSyncExternalStore } from "react";
import {
  bridge,
  type ConnectionClient,
  type ConnectionStatus,
  type ConnectionSummary,
  type HerdrEventMsg,
  type PopupStatePush,
  parseConnectionSummary,
} from "./api";
import {
  LEGACY_DEFAULT_CONNECTION_ID,
  migrateLegacyConnectionStorage,
} from "./connectionStorage";
import { disposeTerminalConnection } from "./terminalConnection";
import { isReconnectRetryableError } from "./reconnectRetry";
import { publishLastStepCompletion } from "./lastStepCompletionStore";
import {
  clearTerminalRelayViewports,
  forgetTerminalRelayViewportsExcept,
  terminalRelayViewportForTab,
} from "./terminalResize";
import {
  clearTabLayouts,
  forgetTabLayoutsExcept,
  provisionalTabLayout,
  rememberTabLayout,
  tabLayoutFor,
} from "./tabLayout";
import type { GitDiffEntry, Pane, PaneLayout, Tab, Workspace } from "./types";
import {
  gitFileActionLabel,
  gitFileActionSuccessMessage,
  gitRepoActionSuccessMessage,
  type GitFileAction,
  type GitRepoAction,
  type GitWorkingCounts,
} from "./gitActions";

export interface ServerSessionState {
  /** ConnectionManager generation that owns every server resource below. */
  serverRuntimeGeneration: number | null;
  navigationMode: "browser-local" | "shared";
  endpointAvailability: EndpointAvailability;
  browserNavigation: BrowserNavigation;
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
  layout: PaneLayout | null;
  selectedPaneId: string | null;
  recentPaneIds: string[];
  /** A plugin's session-modal floating pane (e.g. Herdr Float), if open. */
  popup: PopupInfo | null;
  error: string | null;
  pendingFocusWorkspaceId: string | null;
  pendingFocusWorkspaceSeq: number;
  pendingFocusWorkspaceSettledAt: number | null;
  terminalAttachEpoch: number;
  lastRefresh: number;
}

export type PopupInfo = NonNullable<PopupStatePush["popup"]>;

export interface State extends ServerSessionState {
  status: ConnectionStatus;
  connectionPaused: boolean;
  bridgeStatus: BridgeStatus | null;
  connections: ConnectionSummary[];
  defaultConnectionId: string;
  activeConnectionId: string;
  connectionGeneration: number;
  sessionsByConnectionId: Record<string, ServerSessionState>;
  notice: Notice | null;
  taskNotificationsEnabled: boolean;
  taskNotificationPreferences: TaskNotificationPreferences;
  taskNotificationTransport: "local" | "push";
  taskNotificationBusy: boolean;
  taskNotificationPermission: NotificationPermission | "unsupported";
  automaticUpdateChecksEnabled: boolean;
  updateInfo: UpdateInfo | null;
  updateInstalling: boolean;
  pendingRestartVersion: string | null;
  dismissedUpdateVersion: string | null;
}

export interface Notice {
  kind: "info" | "success" | "error";
  message: string;
  detail?: string;
  detailMode?: "text" | "output";
  detailTitle?: string;
  loading?: boolean;
  autoDismissMs?: number;
  actionLabel?: string;
  actionConnectionId?: string;
  actionRuntimeGeneration?: number;
  actionWorkspaceId?: string;
  actionPaneId?: string;
  actionClipboardText?: string;
  id?: number;
}

export interface UpdateInfo {
  current_version: string;
  latest_version?: string;
  update_available: boolean;
  can_auto_update: boolean;
  reason?: string;
  platform: string;
  source_url?: string;
  metadata_url?: string;
}

export interface BridgeStatus {
  clients: number;
  terminals: Array<{
    terminal_id: string;
    viewers: number;
  }>;
}

type WorktreeHookEvent =
  | "worktree.created"
  | "worktree.opened"
  | "worktree.before_remove"
  | "worktree.removed";

type WorktreeHookRunResult = {
  event: WorktreeHookEvent;
  status: "skipped" | "succeeded" | "failed";
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
};

type WorktreeRemovalCleanup = {
  terminated_processes?: number;
  recovered_stale_checkout?: boolean;
  preserved_path?: string;
  warning?: string;
};

const TASK_NOTIFICATIONS_KEY = "taskNotificationsEnabled";
const TASK_NOTIFICATION_PREFERENCES_KEY = "taskNotificationPreferences";
const AUTOMATIC_UPDATE_CHECKS_KEY = "automaticUpdateChecksEnabled";
const PENDING_UPDATE_RELOAD_KEY = "pendingUpdateReloadVersion";
export const DEFAULT_NOTICE_AUTO_DISMISS_MS = 15 * 1000;
const TASK_COMPLETED_TOAST_DISMISS_MS = DEFAULT_NOTICE_AUTO_DISMISS_MS;
const UPDATE_RESTART_VERIFY_TIMEOUT_MS = 90 * 1000;
const UPDATE_RESTART_VERIFY_INTERVAL_MS = 750;
const RECENT_PANE_LIMIT = 12;

export interface StoreConnectionLease {
  connectionId: string;
  generation: number;
  client: ConnectionClient;
}

export function emptyServerSessionState(
  serverRuntimeGeneration: number | null = null,
): ServerSessionState {
  return {
    serverRuntimeGeneration,
    navigationMode: "shared",
    endpointAvailability: {},
    browserNavigation: emptyBrowserNavigation(),
    workspaces: [],
    tabs: [],
    panes: [],
    layout: null,
    selectedPaneId: null,
    recentPaneIds: [],
    popup: null,
    error: null,
    pendingFocusWorkspaceId: null,
    pendingFocusWorkspaceSeq: 0,
    pendingFocusWorkspaceSettledAt: null,
    terminalAttachEpoch: 0,
    lastRefresh: 0,
  };
}

export const WORKTREE_REMOVED_EVENT = "roamgate:worktree-removed";

export interface WorktreeRemovedTarget {
  connectionId: string;
  generation: number;
  workspace: Workspace;
}

export function noticeAutoDismissDelay(notice: Notice): number | null {
  if (notice.loading) return null;
  return notice.autoDismissMs ?? DEFAULT_NOTICE_AUTO_DISMISS_MS;
}

function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

function storedTaskNotificationPreferences(): TaskNotificationPreferences {
  try {
    const stored = JSON.parse(
      roamgateLocalStorage.getItem(TASK_NOTIFICATION_PREFERENCES_KEY) ?? "{}",
    );
    return {
      completed: stored.completed !== false,
      blocked: stored.blocked !== false,
    };
  } catch {
    return { completed: true, blocked: true };
  }
}

function storedTaskNotificationsEnabled() {
  return (
    notificationPermission() === "granted" &&
    typeof localStorage !== "undefined" &&
    roamgateLocalStorage.getItem(TASK_NOTIFICATIONS_KEY) === "true"
  );
}

export function automaticUpdateChecksEnabledFromStorage(
  storage: Pick<Storage, "getItem"> | undefined,
): boolean {
  try {
    return storage?.getItem(AUTOMATIC_UPDATE_CHECKS_KEY) !== "false";
  } catch {
    return true;
  }
}

function storedAutomaticUpdateChecksEnabled(): boolean {
  return automaticUpdateChecksEnabledFromStorage(
    typeof localStorage === "undefined" ? undefined : roamgateLocalStorage,
  );
}

function storedPendingRestartVersion(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    return roamgateSessionStorage.getItem(PENDING_UPDATE_RELOAD_KEY);
  } catch {
    return null;
  }
}

function storePendingRestartVersion(version: string | null) {
  if (typeof sessionStorage === "undefined") return;
  try {
    if (version) {
      roamgateSessionStorage.setItem(PENDING_UPDATE_RELOAD_KEY, version);
    } else {
      roamgateSessionStorage.removeItem(PENDING_UPDATE_RELOAD_KEY);
    }
  } catch {
    // Storage may be unavailable in private or restricted browser contexts.
  }
}

export function healthMatchesUpdateVersion(
  health: unknown,
  expectedVersion: string,
): boolean {
  return (
    typeof health === "object" &&
    health !== null &&
    "version" in health &&
    (health as { version?: unknown }).version === expectedVersion
  );
}

const initialSession = emptyServerSessionState();
const initial: State = {
  status: "disconnected",
  connectionPaused:
    typeof localStorage !== "undefined" &&
    roamgateLocalStorage.getItem("connectionPaused") === "true",
  bridgeStatus: null,
  connections: [],
  defaultConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
  activeConnectionId: LEGACY_DEFAULT_CONNECTION_ID,
  connectionGeneration: 0,
  sessionsByConnectionId: {
    [LEGACY_DEFAULT_CONNECTION_ID]: initialSession,
  },
  ...initialSession,
  notice: null,
  taskNotificationsEnabled: storedTaskNotificationsEnabled(),
  taskNotificationPreferences: storedTaskNotificationPreferences(),
  taskNotificationTransport:
    roamgateLocalStorage.getItem("taskNotificationTransport") === "push"
      ? "push"
      : "local",
  taskNotificationBusy: false,
  taskNotificationPermission: notificationPermission(),
  automaticUpdateChecksEnabled: storedAutomaticUpdateChecksEnabled(),
  updateInfo: null,
  updateInstalling: false,
  pendingRestartVersion: storedPendingRestartVersion(),
  dismissedUpdateVersion: null,
};

const SERVER_SESSION_KEYS: Array<keyof ServerSessionState> = [
  "serverRuntimeGeneration",
  "navigationMode",
  "endpointAvailability",
  "browserNavigation",
  "workspaces",
  "tabs",
  "panes",
  "layout",
  "selectedPaneId",
  "recentPaneIds",
  "error",
  "pendingFocusWorkspaceId",
  "pendingFocusWorkspaceSeq",
  "pendingFocusWorkspaceSettledAt",
  "terminalAttachEpoch",
  "lastRefresh",
];

function serverSessionFromState(snapshot: State): ServerSessionState {
  return {
    serverRuntimeGeneration: snapshot.serverRuntimeGeneration,
    navigationMode: snapshot.navigationMode,
    endpointAvailability: snapshot.endpointAvailability,
    browserNavigation: snapshot.browserNavigation,
    workspaces: snapshot.workspaces,
    tabs: snapshot.tabs,
    panes: snapshot.panes,
    layout: snapshot.layout,
    selectedPaneId: snapshot.selectedPaneId,
    recentPaneIds: snapshot.recentPaneIds,
    popup: snapshot.popup,
    error: snapshot.error,
    pendingFocusWorkspaceId: snapshot.pendingFocusWorkspaceId,
    pendingFocusWorkspaceSeq: snapshot.pendingFocusWorkspaceSeq,
    pendingFocusWorkspaceSettledAt: snapshot.pendingFocusWorkspaceSettledAt,
    terminalAttachEpoch: snapshot.terminalAttachEpoch,
    lastRefresh: snapshot.lastRefresh,
  };
}

/** Pure state transition used by the store and deterministic partition tests. */
export function activateConnectionState(
  snapshot: State,
  connectionId: string,
  generation: number,
): State {
  if (connectionId === snapshot.activeConnectionId) {
    return { ...snapshot, connectionGeneration: generation };
  }
  const outgoingIsCataloged = snapshot.connections.some(
    (connection) => connection.id === snapshot.activeConnectionId,
  );
  const oldSession = {
    ...serverSessionFromState(snapshot),
    terminalAttachEpoch: snapshot.terminalAttachEpoch + 1,
  };
  const runtimeGeneration =
    snapshot.connections.find((connection) => connection.id === connectionId)
      ?.generation ?? null;
  const cached = snapshot.sessionsByConnectionId[connectionId];
  const restored =
    cached?.serverRuntimeGeneration === runtimeGeneration &&
    runtimeGeneration !== null
      ? cached
      : emptyServerSessionState(runtimeGeneration);
  const newSession = {
    ...restored,
    endpointAvailability: {},
    // A restored pending focus outlived its action, so treat it as settled:
    // the next fresh observation decides whether it still applies. Reuse the
    // snapshot timestamp as a stable non-null token; wall-clock time is unused.
    pendingFocusWorkspaceSettledAt: restored.pendingFocusWorkspaceId
      ? (restored.pendingFocusWorkspaceSettledAt ?? restored.lastRefresh)
      : restored.pendingFocusWorkspaceSettledAt,
    terminalAttachEpoch: restored.terminalAttachEpoch + 1,
  };
  return {
    ...snapshot,
    ...newSession,
    activeConnectionId: connectionId,
    connectionGeneration: generation,
    sessionsByConnectionId: {
      ...snapshot.sessionsByConnectionId,
      ...(outgoingIsCataloged
        ? { [snapshot.activeConnectionId]: oldSession }
        : {}),
      [connectionId]: newSession,
    },
    notice: null,
  };
}

export interface CatalogSessionReconciliation {
  sessionsByConnectionId: Record<string, ServerSessionState>;
  activeSession: ServerSessionState | null;
  invalidatedConnectionIds: string[];
  activeRuntimeChanged: boolean;
}

/**
 * Bind cached server resources to ConnectionManager generations. This is the
 * production catalog transition and a pure deterministic regression seam.
 */
export function reconcileConnectionCatalogSessions(
  snapshot: State,
  connections: ConnectionSummary[],
): CatalogSessionReconciliation {
  const previousById = new Map(
    snapshot.connections.map((connection) => [connection.id, connection]),
  );
  const sessionsByConnectionId: Record<string, ServerSessionState> = {};
  const invalidatedConnectionIds: string[] = [];
  let activeSession: ServerSessionState | null = null;
  let activeRuntimeChanged = false;

  for (const connection of connections) {
    const cached =
      connection.id === snapshot.activeConnectionId
        ? serverSessionFromState(snapshot)
        : snapshot.sessionsByConnectionId[connection.id];
    const previous = previousById.get(connection.id);
    const initialActiveTag =
      snapshot.connections.length === 0 &&
      connection.id === snapshot.activeConnectionId &&
      !!cached &&
      (cached.serverRuntimeGeneration === null ||
        cached.serverRuntimeGeneration === connection.generation);
    const catalogGenerationChanged =
      previous !== undefined && previous.generation !== connection.generation;
    const cachedGenerationMismatch =
      !!cached &&
      cached.serverRuntimeGeneration !== null &&
      cached.serverRuntimeGeneration !== connection.generation;
    const newCatalogEntry = previous === undefined && !initialActiveTag;
    const invalidated =
      !cached ||
      catalogGenerationChanged ||
      cachedGenerationMismatch ||
      newCatalogEntry;
    const nextSession = invalidated
      ? {
          ...emptyServerSessionState(connection.generation),
          terminalAttachEpoch: (cached?.terminalAttachEpoch ?? 0) + 1,
        }
      : {
          ...cached,
          serverRuntimeGeneration: connection.generation,
        };
    sessionsByConnectionId[connection.id] = nextSession;
    if (invalidated) invalidatedConnectionIds.push(connection.id);
    if (connection.id === snapshot.activeConnectionId) {
      activeSession = nextSession;
      activeRuntimeChanged = invalidated && !initialActiveTag;
    }
  }

  return {
    sessionsByConnectionId,
    activeSession,
    invalidatedConnectionIds,
    activeRuntimeChanged,
  };
}

let state = initial;
const listeners = new Set<() => void>();
let noticeSeq = 0;
let updateReloadVerification: {
  version: string;
  promise: Promise<void>;
} | null = null;
function emit() {
  listeners.forEach((l) => l());
}

export function nextRecentPaneIds(
  selectedPaneId: string | null | undefined,
  recentPaneIds: string[],
  panes: Array<Pick<Pane, "pane_id">>,
) {
  const livePaneIds = new Set(panes.map((pane) => pane.pane_id));
  const pruned = recentPaneIds.filter((paneId) => livePaneIds.has(paneId));
  if (!selectedPaneId || !livePaneIds.has(selectedPaneId)) {
    return pruned.slice(0, RECENT_PANE_LIMIT);
  }
  return [
    selectedPaneId,
    ...pruned.filter((paneId) => paneId !== selectedPaneId),
  ].slice(0, RECENT_PANE_LIMIT);
}

function set(patch: Partial<State>) {
  if (patch.notice) {
    patch = { ...patch, notice: { ...patch.notice, id: ++noticeSeq } };
  }
  if (
    patch.selectedPaneId !== undefined ||
    patch.panes !== undefined ||
    patch.layout !== undefined
  ) {
    const selectedForHistory =
      patch.selectedPaneId !== undefined
        ? patch.selectedPaneId
        : state.selectedPaneId;
    const layoutForHistory =
      patch.layout !== undefined ? patch.layout : state.layout;
    patch = {
      ...patch,
      recentPaneIds: nextRecentPaneIds(
        selectedForHistory ?? layoutForHistory?.focused_pane_id,
        patch.recentPaneIds ?? state.recentPaneIds,
        patch.panes ?? state.panes,
      ),
    };
  }
  const sessionPatch: Partial<ServerSessionState> = {};
  let hasSessionPatch = false;
  for (const key of SERVER_SESSION_KEYS) {
    if (!(key in patch)) continue;
    hasSessionPatch = true;
    Object.assign(sessionPatch, { [key]: patch[key] });
  }
  if (hasSessionPatch) {
    const updatedSession = {
      ...(state.sessionsByConnectionId[state.activeConnectionId] ??
        serverSessionFromState(state)),
      ...sessionPatch,
    };
    patch = {
      ...patch,
      sessionsByConnectionId: {
        ...state.sessionsByConnectionId,
        ...patch.sessionsByConnectionId,
        [state.activeConnectionId]: updatedSession,
      },
    };
  }
  state = { ...state, ...patch };
  emit();
}

function captureConnectionLease(): StoreConnectionLease {
  const runtimeGeneration = catalogReadyForConnection
    ? (state.connections.find(
        (connection) => connection.id === state.activeConnectionId,
      )?.generation ?? null)
    : null;
  return {
    connectionId: state.activeConnectionId,
    generation: state.connectionGeneration,
    client: bridge.connection(state.activeConnectionId, runtimeGeneration),
  };
}

export function isStoreConnectionLeaseCurrent(
  snapshot: Pick<State, "activeConnectionId" | "connectionGeneration">,
  lease: Pick<StoreConnectionLease, "connectionId" | "generation">,
): boolean {
  return (
    snapshot.activeConnectionId === lease.connectionId &&
    snapshot.connectionGeneration === lease.generation
  );
}

function leaseIsCurrent(lease: StoreConnectionLease): boolean {
  return (
    isStoreConnectionLeaseCurrent(state, lease) && lease.client.isCurrent()
  );
}

function setForConnection(
  lease: StoreConnectionLease,
  patch: Partial<State>,
): boolean {
  if (!leaseIsCurrent(lease)) return false;
  set(patch);
  return true;
}

export function connectionEventIsActive(
  snapshot: Pick<State, "activeConnectionId" | "connections">,
  connectionId: string,
  connectionGeneration?: number,
  requireGeneration = bridge.hello?.capabilities
    ?.connection_runtime_generation === true,
): boolean {
  if (snapshot.activeConnectionId !== connectionId) return false;
  const expected = snapshot.connections.find(
    (connection) => connection.id === connectionId,
  )?.generation;
  if (!requireGeneration) return true;
  return expected !== undefined && expected === connectionGeneration;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function redirectToLogin() {
  const loginUrl = new URL("/login", window.location.origin);
  window.location.replace(loginUrl.href);
}

/**
 * Keep the old frontend alive until the supervisor starts the updated process
 * and it serves the expected version. The session marker survives a manual
 * reload during the restart window and is cleared before the automatic reload.
 */
function reloadWhenUpdatedServerIsReady(
  expectedVersion: string,
): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (updateReloadVerification?.version === expectedVersion) {
    return updateReloadVerification.promise;
  }

  const promise = (async () => {
    const deadline = Date.now() + UPDATE_RESTART_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`/api/health?t=${Date.now()}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status === 401) {
          storePendingRestartVersion(null);
          set({ pendingRestartVersion: null });
          redirectToLogin();
          return;
        }
        if (response.ok) {
          const health = await response.json().catch(() => null);
          if (healthMatchesUpdateVersion(health, expectedVersion)) {
            storePendingRestartVersion(null);
            set({
              pendingRestartVersion: null,
              notice: {
                kind: "success",
                message: `Roamgate ${expectedVersion} is running`,
                detail:
                  "Reloading the application to use the updated frontend.",
                loading: true,
              },
            });
            window.location.reload();
            return;
          }
        }
      } catch {
        // The bridge is expected to be briefly unavailable during replacement.
      }
      await wait(UPDATE_RESTART_VERIFY_INTERVAL_MS);
    }

    storePendingRestartVersion(null);
    set({
      pendingRestartVersion: null,
      notice: {
        kind: "error",
        message: "Updated server did not become ready",
        detail: `Could not verify Roamgate ${expectedVersion}. Reload the page after checking the server process.`,
      },
    });
  })().finally(() => {
    if (updateReloadVerification?.promise === promise) {
      updateReloadVerification = null;
    }
  });
  updateReloadVerification = { version: expectedVersion, promise };
  return promise;
}

export function terminalNavigationLoading(s: State): boolean {
  return (
    s.status === "connected" &&
    !s.connectionPaused &&
    !s.error &&
    (!!s.pendingFocusWorkspaceId ||
      (!s.layout && s.panes.some((pane) => pane.pane_id === s.selectedPaneId)))
  );
}

function pickActiveTabId(s: State): string | undefined {
  const focusedWs = s.workspaces.find((w) => w.focused);
  if (focusedWs?.active_tab_id) return focusedWs.active_tab_id;
  const focusedTab = s.tabs.find((t) => t.focused);
  return focusedTab?.tab_id ?? s.tabs[0]?.tab_id;
}

interface NumberedTabRename {
  tabId: string;
  label: string;
}

/** Builds a stable GUI label from Herdr's authoritative created-tab number. */
export function numberedCreatedTabRename(
  result: unknown,
): NumberedTabRename | null {
  if (!result || typeof result !== "object") return null;
  const response = result as { type?: unknown; tab?: unknown };
  if (response.type !== "tab_created" || !response.tab) return null;
  if (typeof response.tab !== "object") return null;

  const { tab_id: tabId, number } = response.tab as {
    tab_id?: unknown;
    number?: unknown;
  };
  if (
    typeof tabId !== "string" ||
    !tabId ||
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number < 1
  ) {
    return null;
  }
  return { tabId, label: `Tab ${number}` };
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const refreshingConnectionKeys = new Set<string>();
const queuedConnectionKeys = new Set<string>();
let initialized = false;
let catalogRequestSeq = 0;
let appliedCatalogRequestSeq = 0;
let catalogReadyForConnection = false;
let terminalReattachPending = false;
let connectionRecoveryIntent: "resume" | "reconnect" | null = null;
let focusActionChain: Promise<unknown> = Promise.resolve();
type PaneStatusTracker = {
  ready: boolean;
  byId: Map<string, string>;
};

export class TaskCompletionTracker {
  private readonly byConnection = new Map<string, PaneStatusTracker>();

  clear(): void {
    this.byConnection.clear();
  }

  reset(connectionId: string): void {
    this.byConnection.delete(connectionId);
  }

  update(connectionId: string, panes: Pane[]): Pane[] {
    const tracker = this.byConnection.get(connectionId) ?? {
      ready: false,
      byId: new Map<string, string>(),
    };
    this.byConnection.set(connectionId, tracker);
    const livePaneIds = new Set<string>();
    const completed: Pane[] = [];
    for (const pane of panes) {
      livePaneIds.add(pane.pane_id);
      const nextStatus = pane.agent_status;
      const previousStatus = tracker.byId.get(pane.pane_id);
      if (
        tracker.ready &&
        previousStatus === "working" &&
        (nextStatus === "done" ||
          nextStatus === "idle" ||
          nextStatus === "blocked")
      ) {
        completed.push(pane);
      }
      tracker.byId.set(pane.pane_id, nextStatus);
    }
    for (const paneId of tracker.byId.keys()) {
      if (!livePaneIds.has(paneId)) tracker.byId.delete(paneId);
    }
    tracker.ready = true;
    return completed;
  }
}

const taskCompletionTracker = new TaskCompletionTracker();

function taskNotificationBody(
  pane: Pane,
  workspaces: Workspace[],
  tabs: Tab[],
) {
  const workspace = workspaces.find(
    (w) => w.workspace_id === pane.workspace_id,
  );
  const tab = tabs.find((t) => t.tab_id === pane.tab_id);
  const parts = [
    pane.agent ?? "Agent",
    workspace?.label ? `workspace ${workspace.label}` : null,
    tab?.label ? `tab ${tab.label}` : null,
  ].filter((part): part is string => !!part);
  return parts.join(" · ");
}

let taskNotificationPreferenceVersion = 0;

function reportTaskNotificationFailure(error: unknown, version: number) {
  if (version !== taskNotificationPreferenceVersion) return;
  taskNotificationPreferenceVersion++;
  set({
    taskNotificationsEnabled: false,
    taskNotificationBusy: false,
    taskNotificationPermission: notificationPermission(),
    notice: {
      kind: "error",
      message: "Task notifications are unavailable",
      detail: error instanceof Error ? error.message : String(error),
    },
  });
  try {
    roamgateLocalStorage.setItem(TASK_NOTIFICATIONS_KEY, "false");
  } catch {
    // The runtime preference still reflects the failed notification transport.
  }
}

function maybeShowBrowserTaskNotification(
  title: string,
  body: string,
  tag: string,
  target: TaskNotificationTarget,
) {
  if (
    !state.taskNotificationsEnabled ||
    state.taskNotificationBusy ||
    state.taskNotificationTransport === "push"
  )
    return;
  const version = taskNotificationPreferenceVersion;
  if (notificationPermission() !== "granted") {
    reportTaskNotificationFailure(
      new Error(
        "Enable notifications for this site in the browser settings, then try again.",
      ),
      version,
    );
    return;
  }
  void showTaskNotification(
    title,
    { body, tag },
    target,
    () =>
      state.taskNotificationsEnabled &&
      version === taskNotificationPreferenceVersion &&
      taskNotificationTargetIsCurrent(state, target),
  ).catch((error) => reportTaskNotificationFailure(error, version));
}

export function taskNotificationTarget(
  connectionId: string,
  runtimeGeneration: number,
  pane: Pick<Pane, "workspace_id" | "pane_id">,
): TaskNotificationTarget {
  return {
    connectionId,
    runtimeGeneration,
    workspaceId: pane.workspace_id,
    paneId: pane.pane_id,
  };
}

export function taskNotificationTargetIsCurrent(
  snapshot: Pick<State, "connections">,
  target: Pick<TaskNotificationTarget, "connectionId" | "runtimeGeneration">,
): boolean {
  return snapshot.connections.some(
    (connection) =>
      connection.id === target.connectionId &&
      connection.generation === target.runtimeGeneration,
  );
}

export function taskNotificationTag(target: TaskNotificationTarget): string {
  return JSON.stringify([
    "roamgate-task",
    target.connectionId,
    target.runtimeGeneration,
    target.paneId,
  ]);
}

export function taskNotificationTargetFromNotice(
  notice: Pick<
    Notice,
    | "actionConnectionId"
    | "actionRuntimeGeneration"
    | "actionWorkspaceId"
    | "actionPaneId"
  >,
): TaskNotificationTarget | null {
  const target = {
    connectionId: notice.actionConnectionId,
    runtimeGeneration: notice.actionRuntimeGeneration,
    workspaceId: notice.actionWorkspaceId,
    paneId: notice.actionPaneId,
  };
  return isTaskNotificationTarget(target) ? target : null;
}

function notifyTaskCompleted(pane: Pane, workspaces: Workspace[], tabs: Tab[]) {
  const blocked = pane.agent_status === "blocked";
  if (
    !state.taskNotificationsEnabled ||
    !state.taskNotificationPreferences[blocked ? "blocked" : "completed"]
  )
    return;
  const runtimeGeneration = state.serverRuntimeGeneration;
  if (runtimeGeneration === null) return;
  const body = taskNotificationBody(pane, workspaces, tabs);
  const title = blocked
    ? "Roamgate agent needs input"
    : "Roamgate task completed";
  const target = taskNotificationTarget(
    state.activeConnectionId,
    runtimeGeneration,
    pane,
  );
  set({
    notice: {
      kind: blocked ? "info" : "success",
      message: blocked ? "Agent needs input" : "Task completed",
      detail: body,
      actionLabel: pane.agent ? "Open agent" : "Open workspace",
      actionConnectionId: state.activeConnectionId,
      actionRuntimeGeneration: runtimeGeneration,
      actionWorkspaceId: pane.workspace_id,
      actionPaneId: pane.pane_id,
      autoDismissMs: TASK_COMPLETED_TOAST_DISMISS_MS,
    },
  });
  maybeShowBrowserTaskNotification(
    title,
    body,
    taskNotificationTag(target),
    target,
  );
}

function activePaneIdForTaskNotifications(snapshot: State) {
  const layoutPaneIds = new Set(
    snapshot.layout?.panes.map((pane) => pane.pane_id) ?? [],
  );
  if (snapshot.selectedPaneId && layoutPaneIds.has(snapshot.selectedPaneId)) {
    return snapshot.selectedPaneId;
  }
  return (
    snapshot.layout?.focused_pane_id ??
    snapshot.panes.find((pane) => pane.focused)?.pane_id ??
    null
  );
}

function trackTaskCompletions(connectionId: string, panes: Pane[]) {
  return taskCompletionTracker.update(connectionId, panes);
}

function notifyCompletedTasks(
  lease: StoreConnectionLease,
  completed: Pane[],
  workspaces: Workspace[],
  tabs: Tab[],
) {
  if (!leaseIsCurrent(lease)) return;
  const activePaneId = activePaneIdForTaskNotifications(state);
  for (const pane of completed) {
    if (!leaseIsCurrent(lease)) return;
    if (pane.pane_id === activePaneId) continue;
    notifyTaskCompleted(pane, workspaces, tabs);
  }
}

function enqueueFocusAction<T>(fn: () => Promise<T>): Promise<T> {
  const task = focusActionChain.then(fn, fn);
  focusActionChain = task.catch(() => undefined);
  return task;
}

/**
 * Structural equality for JSON-shaped values. Fails open (reports unequal)
 * when a value cannot be serialized, so callers fall back to publishing.
 */
function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function serverSessionEqual(
  a: ServerSessionState,
  b: ServerSessionState,
): boolean {
  for (const key of SERVER_SESSION_KEYS) {
    if (a[key] === b[key]) continue;
    if (!jsonDeepEqual(a[key], b[key])) return false;
  }
  return true;
}

const REFRESH_SLICE_KEYS = [
  "workspaces",
  "tabs",
  "panes",
  "layout",
  "browserNavigation",
  "endpointAvailability",
] as const;
const REFRESH_SCALAR_KEYS = [
  "navigationMode",
  "error",
  "pendingFocusWorkspaceId",
  "pendingFocusWorkspaceSettledAt",
  "selectedPaneId",
] as const;

/**
 * Reuse the previous reference for every refresh slice whose content is
 * unchanged so memoized consumers stay valid, and return null when nothing
 * changed at all so the caller can skip broadcasting a no-op state. Scalars
 * are only adopted when their value actually moved.
 */
export function stabilizeRefreshPatch(
  snapshot: State,
  next: Partial<State>,
): Partial<State> | null {
  const patch: Partial<State> = {};
  let changed = false;
  const adoptSlice = <K extends (typeof REFRESH_SLICE_KEYS)[number]>(
    key: K,
  ) => {
    if (!(key in next)) return;
    const incoming = next[key] as State[K];
    const current = snapshot[key];
    if (incoming === current || jsonDeepEqual(incoming, current)) {
      patch[key] = current;
    } else {
      patch[key] = incoming;
      changed = true;
    }
  };
  for (const key of REFRESH_SLICE_KEYS) adoptSlice(key);
  const adoptScalar = <K extends (typeof REFRESH_SCALAR_KEYS)[number]>(
    key: K,
  ) => {
    if (!(key in next)) return;
    if (next[key] === snapshot[key]) return;
    patch[key] = next[key] as State[K];
    changed = true;
  };
  for (const key of REFRESH_SCALAR_KEYS) adoptScalar(key);
  if (!changed) return null;
  patch.lastRefresh = next.lastRefresh ?? Date.now();
  return patch;
}

let nextPendingFocusWorkspaceSeq = 1;

/**
 * Marks a workspace focus as in flight and returns the sequence token that
 * identifies this attempt. The pending flag suppresses focus-follower
 * effects until a fresh refresh observes the workspace focused (or the focus
 * is declared lost after the action settled).
 */
function stampPendingFocusWorkspace(workspaceId: string): number {
  const seq = nextPendingFocusWorkspaceSeq++;
  set({
    pendingFocusWorkspaceId: workspaceId,
    pendingFocusWorkspaceSeq: seq,
    pendingFocusWorkspaceSettledAt: null,
  });
  return seq;
}

/** Clears an in-flight focus marker identified by its sequence token. */
function clearPendingFocusWorkspace(seq: number): void {
  if (state.pendingFocusWorkspaceSeq !== seq) return;
  set({
    pendingFocusWorkspaceId: null,
    pendingFocusWorkspaceSettledAt: null,
  });
}

/** Records that the action behind an in-flight focus has completed. */
function settlePendingFocusWorkspace(seq: number): void {
  if (
    !state.pendingFocusWorkspaceId ||
    state.pendingFocusWorkspaceSeq !== seq ||
    state.pendingFocusWorkspaceSettledAt !== null
  ) {
    return;
  }
  set({ pendingFocusWorkspaceSettledAt: Date.now() });
}

async function refreshNow(lease = captureConnectionLease()) {
  if (
    state.connectionPaused ||
    state.status !== "connected" ||
    !leaseIsCurrent(lease)
  ) {
    return;
  }
  const refreshKey = `${lease.connectionId}:${lease.generation}`;
  if (refreshingConnectionKeys.has(refreshKey)) {
    queuedConnectionKeys.add(refreshKey);
    return;
  }
  refreshingConnectionKeys.add(refreshKey);
  // Snapshot the pending-focus marker when the fetch actually starts. Only a
  // refresh that began after the focus action settled may declare the focus
  // lost, and only while the marker still belongs to that same attempt.
  const navigationAtEntry = state.browserNavigation;
  const endpointAvailabilityAtEntry = state.endpointAvailability;
  const pendingFocusAtEntry = {
    seq: state.pendingFocusWorkspaceSeq,
    settledAt: state.pendingFocusWorkspaceSettledAt,
  };
  try {
    const [wsRes, tabRes, paneRes, agentRes] = await Promise.all([
      lease.client.call("workspace.list"),
      lease.client.call("tab.list"),
      lease.client.call("pane.list"),
      // Older servers may omit agent metadata; ordinary navigation still works.
      lease.client.call("agent.list").catch(() => null),
    ]);
    if (!leaseIsCurrent(lease)) return;
    const workspaces: Workspace[] = wsRes?.workspaces ?? [];
    const tabs: Tab[] = tabRes?.tabs ?? [];
    const panes = withAgentActivity(paneRes?.panes ?? [], agentRes);
    const liveTabIds = new Set(tabs.map((tab) => tab.tab_id));
    forgetTerminalRelayViewportsExcept(
      lease.connectionId,
      lease.generation,
      liveTabIds,
    );
    forgetTabLayoutsExcept(lease.connectionId, lease.generation, liveTabIds);
    const completedPanes = trackTaskCompletions(lease.connectionId, panes);

    const navigationMode =
      wsRes?.navigation_mode === "browser-local" ? "browser-local" : "shared";
    const next: Partial<State> = {
      navigationMode,
      endpointAvailability: parseEndpointAvailability(
        wsRes?.endpoint_availability,
      ),
      workspaces,
      tabs,
      panes,
      error: null,
      lastRefresh: Date.now(),
    };
    if (navigationMode === "browser-local") {
      Object.assign(
        next,
        projectBrowserNavigation(
          state.browserNavigation,
          workspaces,
          tabs,
          panes,
        ),
      );
    }
    const pendingFocusAtObservation = {
      seq: state.pendingFocusWorkspaceSeq,
      settledAt: state.pendingFocusWorkspaceSettledAt,
    };
    if (
      state.pendingFocusWorkspaceId &&
      workspaces.some(
        (w) => w.workspace_id === state.pendingFocusWorkspaceId && w.focused,
      )
    ) {
      next.pendingFocusWorkspaceId = null;
      next.pendingFocusWorkspaceSettledAt = null;
    } else if (
      state.pendingFocusWorkspaceId &&
      state.pendingFocusWorkspaceSeq === pendingFocusAtEntry.seq &&
      pendingFocusAtEntry.settledAt !== null &&
      state.pendingFocusWorkspaceSettledAt === pendingFocusAtEntry.settledAt
    ) {
      // The focus action settled before this refresh started, yet a fresh
      // observation still does not show the workspace focused: the focus was
      // pre-empted or the workspace vanished, so release follower effects.
      next.pendingFocusWorkspaceId = null;
      next.pendingFocusWorkspaceSettledAt = null;
    }

    // Keep selection valid globally. Layout-scoped validation runs after the
    // active tab layout is fetched below, because a pane can exist while no
    // longer belonging to the visible terminal.
    if (
      navigationMode === "shared" &&
      state.selectedPaneId &&
      !panes.some((p) => p.pane_id === state.selectedPaneId)
    ) {
      next.selectedPaneId = null;
    }

    // Fetch layout for the active tab (needs a pane_id in that tab).
    const merged = { ...state, ...next } as State;
    const activeTabId = pickActiveTabId(merged);
    const aPane =
      panes.find((p) => p.tab_id === activeTabId && p.focused) ??
      panes.find((p) => p.tab_id === activeTabId);
    if (aPane) {
      try {
        const lr = await lease.client.call("pane.layout", {
          pane_id: aPane.pane_id,
        });
        if (!leaseIsCurrent(lease)) return;
        const observedLayout = (lr?.layout ?? null) as PaneLayout | null;
        // Panes can move or close between pane.list and pane.layout. Never
        // substitute shared layout focus for a missing browser-selected pane.
        const staleLayout =
          navigationMode === "browser-local" &&
          observedLayout &&
          (observedLayout.tab_id !== activeTabId ||
            observedLayout.workspace_id !== aPane.workspace_id ||
            (next.selectedPaneId &&
              !observedLayout.panes.some(
                (pane) => pane.pane_id === next.selectedPaneId,
              )));
        const layout = staleLayout ? null : observedLayout;
        if (staleLayout) queuedConnectionKeys.add(refreshKey);
        rememberTabLayout(lease.connectionId, lease.generation, layout);
        next.layout =
          navigationMode === "browser-local"
            ? projectBrowserLayout(layout, next.selectedPaneId ?? null)
            : layout;
        if (
          navigationMode === "shared" &&
          layout &&
          state.selectedPaneId &&
          !layout.panes.some((p) => p.pane_id === state.selectedPaneId)
        ) {
          next.selectedPaneId = null;
        }
      } catch (error) {
        next.layout = null;
        next.error = error instanceof Error ? error.message : String(error);
      }
    } else {
      next.layout = null;
    }

    // Never publish a layout fetched for an older browser navigation target.
    if (navigationAtEntry !== state.browserNavigation) {
      queuedConnectionKeys.add(refreshKey);
      return;
    }

    // Layout fetching can overlap another focus attempt or its settlement.
    // Drop only a stale marker clear, preserving the useful snapshot data.
    if (
      next.pendingFocusWorkspaceId === null &&
      (state.pendingFocusWorkspaceSeq !== pendingFocusAtObservation.seq ||
        state.pendingFocusWorkspaceSettledAt !==
          pendingFocusAtObservation.settledAt)
    ) {
      delete next.pendingFocusWorkspaceId;
      delete next.pendingFocusWorkspaceSettledAt;
    }
    // Close/reattach can replace advertisements while either RPC is pending.
    // Keep that newer slice without discarding useful topology/layout updates.
    if (endpointAvailabilityAtEntry !== state.endpointAvailability) {
      delete next.endpointAvailability;
      queuedConnectionKeys.add(refreshKey);
    }
    const patch = stabilizeRefreshPatch(state, next);
    if (patch) {
      if (!setForConnection(lease, patch)) return;
    } else if (!leaseIsCurrent(lease)) {
      return;
    }
    notifyCompletedTasks(lease, completedPanes, workspaces, tabs);
  } catch (error) {
    setForConnection(lease, { error: (error as Error).message });
  } finally {
    refreshingConnectionKeys.delete(refreshKey);
    if (queuedConnectionKeys.delete(refreshKey) && leaseIsCurrent(lease)) {
      void refreshNow(lease);
    }
  }
}

function scheduleRefresh(lease = captureConnectionLease()) {
  if (state.connectionPaused || !leaseIsCurrent(lease)) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    if (leaseIsCurrent(lease)) void refreshNow(lease);
  }, 80);
}

async function refreshBridgeStatus() {
  if (state.connectionPaused || state.status !== "connected") return;
  const requestSeq = ++catalogRequestSeq;
  try {
    const r = await bridge.call("bridge.status");
    if (state.connectionPaused || state.status !== "connected") return;
    applyConnectionCatalog(r, requestSeq);
    if (rearmTerminalAttachmentsAfterCatalog(catalogReadyForConnection)) {
      scheduleRefresh();
    }
    const nextBridgeStatus: BridgeStatus = {
      clients: Number(r?.clients ?? 0),
      terminals: Array.isArray(r?.terminals) ? r.terminals : [],
    };
    if (!jsonDeepEqual(state.bridgeStatus, nextBridgeStatus)) {
      set({ bridgeStatus: nextBridgeStatus });
    }
  } catch {
    // Keep the last good count; status polling should never interrupt the UI.
  }
}

let metadataTimer: ReturnType<typeof setInterval> | null = null;
let updateTimer: ReturnType<typeof setInterval> | null = null;

// Push events and post-action refreshes carry live updates; the metadata poll
// is only a backstop, so it can run slowly and skip ticks while hidden.
const METADATA_POLL_MS = 5000;

function startMetadataPolling() {
  if (metadataTimer) return;
  metadataTimer = setInterval(() => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    if (state.status === "connected") {
      if (catalogReadyForConnection) scheduleRefresh();
      void refreshBridgeStatus();
    }
  }, METADATA_POLL_MS);
}

async function checkForUpdate(showErrors = false) {
  if (!showErrors && !state.automaticUpdateChecksEnabled) return;
  if (state.connectionPaused) {
    if (showErrors) {
      set({
        notice: {
          kind: "info",
          message: "Connection is paused",
          detail: "Resume the connection before checking for updates.",
        },
      });
    }
    return;
  }
  try {
    const r = await fetch("/api/update/check", {
      credentials: "same-origin",
      headers: { "x-roamgate-update": "1" },
    });
    if (!r.ok) {
      if (showErrors) {
        const body = await r.json().catch(() => null);
        set({
          notice: {
            kind: "error",
            message: "Update check failed",
            detail: body?.error ?? r.statusText,
          },
        });
      }
      return;
    }
    const info = (await r.json()) as UpdateInfo;
    if (!showErrors && !state.automaticUpdateChecksEnabled) return;
    if (
      info.update_available &&
      info.latest_version &&
      (showErrors || state.dismissedUpdateVersion !== info.latest_version)
    ) {
      set({ updateInfo: info });
    } else if (!info.update_available) {
      set({
        updateInfo: null,
        notice: showErrors
          ? {
              kind: "success",
              message: "Roamgate is up to date",
              detail: info.latest_version
                ? `Current version: ${info.current_version}`
                : undefined,
            }
          : state.notice,
      });
    }
  } catch (e) {
    if (showErrors) {
      set({
        notice: {
          kind: "error",
          message: "Update check failed",
          detail: (e as Error).message,
        },
      });
    }
  }
}

function startUpdatePolling(): Promise<void> {
  if (updateTimer || !state.automaticUpdateChecksEnabled) {
    return Promise.resolve();
  }
  const initialCheck = checkForUpdate(false);
  updateTimer = setInterval(
    () => {
      void checkForUpdate(false);
    },
    30 * 60 * 1000,
  );
  return initialCheck;
}

function stopPolling() {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (metadataTimer) {
    clearInterval(metadataTimer);
    metadataTimer = null;
  }
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  queuedConnectionKeys.clear();
}

function startPolling() {
  startMetadataPolling();
  startUpdatePolling();
}

function selectConnectionNow(connectionId: string, refresh = true): boolean {
  if (!connectionId || connectionId === state.activeConnectionId) return false;
  if (
    state.connections.length > 0 &&
    !state.connections.some((connection) => connection.id === connectionId)
  ) {
    return false;
  }
  if (
    state.activeConnectionId === LEGACY_DEFAULT_CONNECTION_ID &&
    typeof localStorage !== "undefined"
  ) {
    migrateLegacyConnectionStorage(roamgateLocalStorage, connectionId);
  }
  stopPolling();
  disposeTerminalConnection(
    {
      connectionId: state.activeConnectionId,
      generation: state.connectionGeneration,
    },
    true,
  );
  clearTerminalRelayViewports();
  clearTabLayouts();
  focusActionChain = Promise.resolve();
  const generation = bridge.setActiveConnection(connectionId);
  state = activateConnectionState(state, connectionId, generation);
  emit();
  if (
    refresh &&
    initialized &&
    !state.connectionPaused &&
    state.status === "connected"
  ) {
    startPolling();
    void refreshNow(captureConnectionLease());
    // Popup state is tracked per connection on the bridge, so a switch needs
    // its own query: otherwise only the connection that was active when the
    // socket came up ever reports one.
    void store.watchPopup();
  }
  return true;
}

function resetActiveConnectionLease(
  connections: ConnectionSummary[],
  defaultConnectionId: string,
  reconciliation: CatalogSessionReconciliation,
) {
  stopPolling();
  disposeTerminalConnection(
    {
      connectionId: state.activeConnectionId,
      generation: state.connectionGeneration,
    },
    false,
  );
  clearTerminalRelayViewports();
  clearTabLayouts();
  focusActionChain = Promise.resolve();
  taskCompletionTracker.reset(state.activeConnectionId);
  const generation = bridge.advanceActiveConnectionGeneration();
  const runtimeGeneration =
    connections.find((connection) => connection.id === state.activeConnectionId)
      ?.generation ?? null;
  const activeSession =
    reconciliation.activeSession ?? emptyServerSessionState(runtimeGeneration);
  state = {
    ...state,
    ...activeSession,
    connections,
    defaultConnectionId,
    connectionGeneration: generation,
    sessionsByConnectionId: {
      ...reconciliation.sessionsByConnectionId,
      [state.activeConnectionId]: activeSession,
    },
    notice: null,
  };
  emit();
  if (initialized && !state.connectionPaused && state.status === "connected") {
    startPolling();
    void refreshNow(captureConnectionLease());
  }
}

export function mergeConnectionCatalog(
  previous: ConnectionSummary[],
  values: unknown[],
): ConnectionSummary[] {
  return values
    .map(parseConnectionSummary)
    .filter(
      (connection): connection is ConnectionSummary => connection !== null,
    )
    .map((connection) => {
      const prior = previous.find((item) => item.id === connection.id);
      if (!prior) return connection;
      if (
        connection.type !== undefined &&
        prior.type !== undefined &&
        connection.type !== prior.type
      ) {
        return {
          ...prior,
          ...connection,
          control_socket_path: connection.control_socket_path,
          client_socket_path: connection.client_socket_path,
          ssh_destination: connection.ssh_destination,
          remote_control_socket_path: connection.remote_control_socket_path,
          remote_client_socket_path: connection.remote_client_socket_path,
        };
      }
      return {
        ...prior,
        ...connection,
        type: connection.type ?? prior.type,
        read_only: connection.read_only ?? prior.read_only,
        auto_connect: connection.auto_connect ?? prior.auto_connect,
        control_socket_path:
          connection.control_socket_path ?? prior.control_socket_path,
        client_socket_path:
          connection.client_socket_path ?? prior.client_socket_path,
        ssh_destination: connection.ssh_destination ?? prior.ssh_destination,
        remote_control_socket_path:
          connection.remote_control_socket_path ??
          prior.remote_control_socket_path,
        remote_client_socket_path:
          connection.remote_client_socket_path ??
          prior.remote_client_socket_path,
      };
    });
}

function applyConnectionCatalog(result: unknown, requestSeq: number) {
  if (
    requestSeq < appliedCatalogRequestSeq ||
    !result ||
    typeof result !== "object"
  ) {
    return;
  }
  appliedCatalogRequestSeq = requestSeq;
  const catalog = result as {
    default_connection_id?: unknown;
    connections?: unknown;
  };
  const defaultConnectionId =
    typeof catalog.default_connection_id === "string" &&
    catalog.default_connection_id.length > 0
      ? catalog.default_connection_id
      : state.defaultConnectionId;
  const connections = Array.isArray(catalog.connections)
    ? mergeConnectionCatalog(state.connections, catalog.connections)
    : state.connections;
  if (Array.isArray(catalog.connections)) {
    catalogReadyForConnection = true;
    bridge.setConnectionRuntimeGenerations(connections);
  }
  const nextActive = connections.find(
    (connection) => connection.id === state.activeConnectionId,
  );
  const reconciliation = reconcileConnectionCatalogSessions(state, connections);
  for (const connectionId of reconciliation.invalidatedConnectionIds) {
    taskCompletionTracker.reset(connectionId);
  }
  if (nextActive && reconciliation.activeRuntimeChanged) {
    resetActiveConnectionLease(
      connections,
      defaultConnectionId,
      reconciliation,
    );
    return;
  }

  // Steady-state catalog polls rebuild identical DTOs every tick. Publish
  // only real changes so unchanged slices keep their references and idle
  // polls do not re-render every subscriber.
  const stableConnections = jsonDeepEqual(state.connections, connections)
    ? state.connections
    : connections;
  const previousSessions = state.sessionsByConnectionId;
  const nextSessions = reconciliation.sessionsByConnectionId;
  let sessionsChanged =
    reconciliation.invalidatedConnectionIds.length > 0 ||
    Object.keys(nextSessions).length !== Object.keys(previousSessions).length;
  const stableSessions: Record<string, ServerSessionState> = {};
  for (const [id, session] of Object.entries(nextSessions)) {
    const previous = previousSessions[id];
    if (previous && serverSessionEqual(previous, session)) {
      stableSessions[id] = previous;
    } else {
      stableSessions[id] = session;
      sessionsChanged = true;
    }
  }
  if (
    stableConnections === state.connections &&
    !sessionsChanged &&
    defaultConnectionId === state.defaultConnectionId
  ) {
    if (!nextActive) selectConnectionNow(defaultConnectionId);
    return;
  }

  state = {
    ...state,
    ...(reconciliation.activeSession ?? {}),
    connections: stableConnections,
    defaultConnectionId,
    sessionsByConnectionId: stableSessions,
  };
  emit();
  if (!nextActive) selectConnectionNow(defaultConnectionId);
}

async function refreshConnectionCatalog(): Promise<boolean> {
  if (state.connectionPaused || state.status !== "connected") return false;
  const requestSeq = ++catalogRequestSeq;
  try {
    applyConnectionCatalog(await bridge.call("connections.list"), requestSeq);
    return catalogReadyForConnection && appliedCatalogRequestSeq >= requestSeq;
  } catch {
    // The catalog is bridge-global and is retried on the next status poll.
    return false;
  }
}

function rearmTerminalAttachmentsAfterCatalog(catalogReady: boolean): boolean {
  if (
    !terminalReattachPending ||
    !catalogReady ||
    state.status !== "connected" ||
    state.connectionPaused
  ) {
    return false;
  }
  terminalReattachPending = false;
  set({ terminalAttachEpoch: state.terminalAttachEpoch + 1 });
  return true;
}

const RECONNECT_RETRY_WAIT_MS = 10_000;
const RECONNECT_RETRY_POLL_MS = 100;

async function waitForReconnectReady(): Promise<boolean> {
  const deadline = Date.now() + RECONNECT_RETRY_WAIT_MS;
  // The connection catalog carrying the runtime generation lands shortly
  // after the socket reconnects; a fresh lease only reports current once
  // scoped routing is usable, so poll instead of trusting the status flip.
  while (Date.now() < deadline) {
    if (
      state.status === "connected" &&
      !state.connectionPaused &&
      captureConnectionLease().client.isCurrent()
    ) {
      return true;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, RECONNECT_RETRY_POLL_MS),
    );
  }
  return false;
}

async function action<T>(
  fn: (lease: StoreConnectionLease) => Promise<T>,
  options: {
    refresh?: "scheduled" | "immediate" | "none";
    pendingFocusWorkspaceSeq?: number;
    failureNotice?: (error: Error) => Notice;
    retryOnReconnect?: boolean;
  } = {},
): Promise<T | undefined> {
  if (state.connectionPaused) {
    // The caller may have already stamped a focus marker; the attempt never
    // starts here, so release it instead of stranding it unsettled.
    if (options.pendingFocusWorkspaceSeq !== undefined) {
      clearPendingFocusWorkspace(options.pendingFocusWorkspaceSeq);
    }
    set({
      notice: {
        kind: "info",
        message: "Connection is paused",
        detail: "Resume the connection before sending actions to Herdr.",
      },
    });
    return undefined;
  }
  const attempt = (
    activeLease: StoreConnectionLease,
  ): Promise<{ ok: true; value: T } | { ok: false; error: Error }> =>
    fn(activeLease).then(
      (value) => ({ ok: true, value }) as const,
      (error: Error) => ({ ok: false, error }) as const,
    );
  let activeLease = captureConnectionLease();
  let outcome = await attempt(activeLease);
  // A focus action fired while the bridge socket is reconnecting fails before
  // reaching the server, which makes clicks right after returning to the app
  // look dropped. Retry it once on the fresh connection with a new lease.
  if (
    !outcome.ok &&
    options.retryOnReconnect &&
    isReconnectRetryableError(outcome.error) &&
    !state.connectionPaused &&
    (await waitForReconnectReady()) &&
    !state.connectionPaused
  ) {
    activeLease = captureConnectionLease();
    outcome = await attempt(activeLease);
  }
  if (!outcome.ok) {
    // Releasing the focus marker must not depend on the lease surviving: the
    // attempt is over, and a dead lease (pause, disconnect, connection
    // switch) would otherwise strand the marker in a cached session whose
    // steady-state restore never marks it settled.
    if (options.pendingFocusWorkspaceSeq !== undefined) {
      clearPendingFocusWorkspace(options.pendingFocusWorkspaceSeq);
    }
    if (!leaseIsCurrent(activeLease)) return undefined;
    const error = outcome.error;
    setForConnection(activeLease, {
      error: error.message,
      notice: options.failureNotice?.(error) ?? state.notice,
    });
    return undefined;
  }
  // The action completed, so the attempt is settled even when the lease died
  // before the client observed it; the next fresh observation decides.
  if (options.pendingFocusWorkspaceSeq !== undefined) {
    settlePendingFocusWorkspace(options.pendingFocusWorkspaceSeq);
  }
  if (!leaseIsCurrent(activeLease)) return undefined;
  if (options.refresh === "immediate") {
    void refreshNow(activeLease);
  } else if (options.refresh !== "none") {
    scheduleRefresh(activeLease);
  }
  return outcome.value;
}

function hookEventLabel(event: WorktreeHookEvent): string {
  switch (event) {
    case "worktree.before_remove":
      return "Worktree teardown hook";
    case "worktree.opened":
      return "Worktree opened hook";
    case "worktree.removed":
      return "Worktree removed hook";
    case "worktree.created":
      return "Worktree setup hook";
  }
}

function hookOutput(
  result: Pick<WorktreeHookRunResult, "stdout" | "stderr" | "error">,
) {
  return [result.stderr, result.stdout, result.error]
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .join("\n")
    .trim();
}

export function summarizeDirectHookResult(
  result: WorktreeHookRunResult,
): Notice | null {
  if (result.status === "skipped") return null;
  const output = hookOutput(result);
  const exitSuffix =
    typeof result.exit_code === "number" ? ` (exit ${result.exit_code})` : "";
  return {
    kind: result.status === "succeeded" ? "success" : "error",
    message:
      result.status === "succeeded"
        ? `${hookEventLabel(result.event)} completed`
        : `${hookEventLabel(result.event)} failed${exitSuffix}`,
    detail: output ? output.slice(0, 1400) : undefined,
    detailMode: output ? "output" : undefined,
    detailTitle: output ? `${hookEventLabel(result.event)} output` : undefined,
    ...(result.status === "succeeded"
      ? { autoDismissMs: DEFAULT_NOTICE_AUTO_DISMISS_MS }
      : {}),
  };
}

export function worktreeRemovalCompletionNotice(
  cleanup: WorktreeRemovalCleanup | undefined,
  removedHookNotice: Notice | null,
): Notice | null {
  if (!cleanup?.recovered_stale_checkout && !cleanup?.warning) {
    return removedHookNotice;
  }

  const stopped = Number(cleanup.terminated_processes ?? 0);
  const recoveryDetails = [
    stopped > 0
      ? `Stopped ${stopped} process${stopped === 1 ? "" : "es"} still using the checkout.`
      : "",
    cleanup.preserved_path
      ? `Stale files were preserved at ${cleanup.preserved_path}.`
      : cleanup.recovered_stale_checkout
        ? "The checkout was already absent; stale Herdr state was reconciled."
        : "",
    cleanup.warning ?? "",
  ].filter(Boolean);

  if (removedHookNotice) {
    const cleanupWarning = Boolean(cleanup.warning);
    return {
      ...removedHookNotice,
      kind: cleanupWarning ? "error" : removedHookNotice.kind,
      message:
        cleanupWarning && removedHookNotice.kind !== "error"
          ? "Worktree removed with cleanup warning"
          : removedHookNotice.message,
      detail: [
        cleanupWarning && removedHookNotice.kind !== "error"
          ? removedHookNotice.message
          : "",
        removedHookNotice.detail,
        ...recoveryDetails,
      ]
        .filter(Boolean)
        .join("\n"),
      detailTitle:
        removedHookNotice.detail || cleanupWarning
          ? "Worktree removal details"
          : undefined,
    };
  }

  return {
    kind: cleanup.warning ? "error" : "success",
    message: cleanup.warning
      ? "Worktree removed with cleanup warning"
      : "Worktree removed",
    detail: recoveryDetails.join("\n"),
  };
}

function handlePopupPush(push: PopupStatePush) {
  if (
    !state.connectionPaused &&
    connectionEventIsActive(
      state,
      push.connection_id,
      push.connection_generation,
    )
  ) {
    set({ popup: push.popup });
  }
}

function handleHerdrEvent(event: HerdrEventMsg) {
  if (
    !state.connectionPaused &&
    connectionEventIsActive(
      state,
      event.connection_id,
      event.connection_generation,
    )
  ) {
    if (
      event.event === "workspace.last_step_completed" &&
      typeof event.data.workspace_id === "string"
    ) {
      publishLastStepCompletion(event.connection_id, event.data.workspace_id);
    }
    scheduleRefresh();
  }
}

function browserSelectionIsCurrent(navigation: BrowserNavigation) {
  const current = state.browserNavigation;
  const workspaceId = navigation.workspaceId;
  const tabId = workspaceId ? navigation.tabIds[workspaceId] : undefined;
  return (
    current.revision === navigation.revision &&
    current.workspaceId === workspaceId &&
    (!workspaceId || current.tabIds[workspaceId] === tabId) &&
    (!tabId || current.paneIds[tabId] === navigation.paneIds[tabId])
  );
}

export function endpointCreationReason(
  snapshot: State,
  method: "tab.create" | "workspace.create",
  workspaceId = snapshot.browserNavigation.workspaceId,
): string | null {
  if (snapshot.navigationMode === "shared") return null;
  // Empty bootstrap deliberately uses the validated control API, not an endpoint.
  if (method === "workspace.create" && snapshot.workspaces.length === 0)
    return null;
  const tabId = workspaceId
    ? snapshot.browserNavigation.tabIds[workspaceId]
    : undefined;
  const paneId = tabId ? snapshot.browserNavigation.paneIds[tabId] : undefined;
  const pane = snapshot.panes.find((pane) => pane.pane_id === paneId);
  const advertisement = pane
    ? snapshot.endpointAvailability[pane.terminal_id]
    : null;
  return (
    endpointMethodReason(
      snapshot.navigationMode,
      advertisement,
      "pane.focus",
    ) ?? endpointMethodReason(snapshot.navigationMode, advertisement, method)
  );
}

export function useEndpointCreationReason(
  method: "tab.create" | "workspace.create",
  workspaceId?: string,
) {
  return useStoreSelector((snapshot) =>
    endpointCreationReason(snapshot, method, workspaceId),
  );
}

function browserCreationSource(workspaceId: string | null) {
  const tabId = workspaceId
    ? state.browserNavigation.tabIds[workspaceId]
    : undefined;
  const paneId = tabId ? state.browserNavigation.paneIds[tabId] : undefined;
  const pane = state.panes.find((pane) => pane.pane_id === paneId);
  return pane
    ? {
        workspace_id: pane.workspace_id,
        tab_id: pane.tab_id,
        pane_id: pane.pane_id,
        terminal_id: pane.terminal_id,
      }
    : null;
}

function navigateBrowser(workspaceId: string, tabId?: string, paneId?: string) {
  const navigation = selectBrowserTarget(
    state.browserNavigation,
    workspaceId,
    tabId,
    paneId,
  );
  const projected = projectBrowserNavigation(
    navigation,
    state.workspaces,
    state.tabs,
    state.panes,
  );
  const activeTabId = projected.browserNavigation.tabIds[workspaceId];
  // Render the target tab from its last known geometry instead of blanking the
  // terminal area until pane.layout answers. The refresh below corrects it.
  const nextLayout =
    state.layout?.tab_id === activeTabId
      ? state.layout
      : provisionalTabLayout(
          tabLayoutFor(
            state.activeConnectionId,
            state.connectionGeneration,
            activeTabId,
          ),
          state.panes,
          activeTabId,
        );
  set({
    ...projected,
    layout: projectBrowserLayout(nextLayout, projected.selectedPaneId),
    pendingFocusWorkspaceId: null,
    pendingFocusWorkspaceSettledAt: null,
    error: null,
  });
  return refreshNow();
}

/** Adopt an explicit RPC result without requiring it in an older list snapshot. */
function adoptBrowserTarget(lease: StoreConnectionLease, result: unknown) {
  if (
    !leaseIsCurrent(lease) ||
    state.navigationMode !== "browser-local" ||
    !result ||
    typeof result !== "object"
  )
    return;
  const target = result as {
    root_pane?: Partial<Pane>;
    pane?: Partial<Pane>;
    tab?: Partial<Tab>;
    workspace?: Partial<Workspace>;
  };
  const pane = target.root_pane ?? target.pane;
  const tabId = pane?.tab_id ?? target.tab?.tab_id;
  const workspaceId =
    pane?.workspace_id ??
    target.tab?.workspace_id ??
    target.workspace?.workspace_id;
  if (typeof workspaceId !== "string") return;
  setForConnection(lease, {
    browserNavigation: selectBrowserTarget(
      state.browserNavigation,
      workspaceId,
      typeof tabId === "string" ? tabId : undefined,
      typeof pane?.pane_id === "string" ? pane.pane_id : undefined,
    ),
  });
}

export const store = {
  setTerminalEndpoint(
    client: ConnectionClient,
    terminalId: string,
    advertisement: unknown,
  ) {
    if (!client.isCurrent()) return;
    set({
      endpointAvailability: {
        ...state.endpointAvailability,
        [terminalId]: parseEndpointAdvertisement(advertisement),
      },
    });
  },
  terminalScrollReason(terminalId: string, mouseReporting = false) {
    if (mouseReporting) return null; // Wheel input uses the negotiated semantic codec.
    return endpointMethodReason(
      state.navigationMode,
      state.endpointAvailability[terminalId],
      "pane.scroll",
    );
  },
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  init() {
    if (initialized) return;
    initialized = true;
    void store.restoreTaskNotifications();
    window.addEventListener("storage", (event) => {
      const key = event.key?.replace(/^roamgate:/, "");
      if (
        key === TASK_NOTIFICATIONS_KEY ||
        key === TASK_NOTIFICATION_PREFERENCES_KEY ||
        event.key === null
      ) {
        set({
          taskNotificationsEnabled: storedTaskNotificationsEnabled(),
          taskNotificationPreferences: storedTaskNotificationPreferences(),
        });
        void store.restoreTaskNotifications();
      }
    });
    bridge.onHello((hello) => {
      const defaultConnectionId = hello.default_connection_id;
      set({ defaultConnectionId });
      if (
        state.activeConnectionId === LEGACY_DEFAULT_CONNECTION_ID &&
        defaultConnectionId !== state.activeConnectionId
      ) {
        selectConnectionNow(defaultConnectionId, false);
      }
      if (state.status === "connected" && !state.connectionPaused) {
        void refreshConnectionCatalog();
      }
    });
    bridge.onStatus((s) => {
      if (s === "disconnected") {
        set({ endpointAvailability: {} });
        catalogReadyForConnection = false;
        terminalReattachPending = true;
        bridge.setConnectionRuntimeGenerations([]);
        clearTerminalRelayViewports();
        clearTabLayouts();
        focusActionChain = Promise.resolve();
        queuedConnectionKeys.clear();
      }
      const completedRecovery =
        s === "connected" && !state.connectionPaused && state.notice?.loading
          ? connectionRecoveryIntent
          : null;
      if (s === "connected") connectionRecoveryIntent = null;
      const completedRecoveryMessage =
        completedRecovery === "reconnect"
          ? "Browser reconnected"
          : "Browser sync resumed";
      set(
        completedRecovery
          ? {
              status: s,
              connectionGeneration: state.connectionGeneration,
              notice: {
                kind: "success",
                message: completedRecoveryMessage,
                autoDismissMs: 5000,
              },
            }
          : {
              status: s,
              connectionGeneration:
                s === "disconnected"
                  ? bridge.clientGeneration
                  : state.connectionGeneration,
              bridgeStatus: s === "connected" ? state.bridgeStatus : null,
            },
      );
      if (s === "connected" && !state.connectionPaused) {
        // Polling may have been stopped by the hello-driven initial
        // connection switch; every settled connection must re-arm it.
        startPolling();
        void refreshConnectionCatalog().then((catalogReady) => {
          if (
            !catalogReady ||
            state.status !== "connected" ||
            state.connectionPaused
          ) {
            return;
          }
          rearmTerminalAttachmentsAfterCatalog(true);
          void refreshNow();
          void refreshBridgeStatus();
          // Popup state is pushed only on change, so ask once per
          // settled connection.
          void store.watchPopup();
        });
        if (state.pendingRestartVersion) {
          void reloadWhenUpdatedServerIsReady(state.pendingRestartVersion);
        }
      }
    });
    bridge.onEvent(handleHerdrEvent);
    bridge.onPopup(handlePopupPush);
    bridge.onControl((control) => {
      if (control.type === "pause_connection") {
        store.pauseConnection(
          control.reason ??
            "Another Roamgate client paused this connection. Resume when you want this browser to sync again.",
        );
      }
    });
    // Browsers throttle timers in hidden tabs, which stalls the metadata
    // poll that carries agent statuses. Catch up as soon as the page is
    // visible, focused, or back online instead of waiting out the throttle.
    const refreshOnReturn = () => {
      if (state.connectionPaused || state.status !== "connected") return;
      // Mobile OSes can silently kill the socket while the page is frozen;
      // probe now so reconnect and terminal re-attach start immediately
      // instead of waiting for the next heartbeat tick.
      bridge.probeConnectionNow();
      void refreshNow();
      void refreshBridgeStatus();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) refreshOnReturn();
      });
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", refreshOnReturn);
      window.addEventListener("online", refreshOnReturn);
    }
    // If the server requires a password and the session is missing/expired,
    // bounce to the login page instead of spinning on a failing socket.
    fetch("/api/health", {
      credentials: "same-origin",
      cache: "no-store",
    }).then((r) => {
      if (r.status === 401) {
        redirectToLogin();
        return;
      }
      if (state.pendingRestartVersion) {
        void reloadWhenUpdatedServerIsReady(state.pendingRestartVersion);
      }
      if (!state.connectionPaused) {
        bridge.connect();
        startPolling();
      }
    });
  },

  refresh: refreshNow,

  /** Refresh bridge-global profile/status metadata without changing selection. */
  refreshConnections: refreshConnectionCatalog,

  /** Programmatic switch seam for the M5 selector. */
  selectConnection(connectionId: string) {
    return selectConnectionNow(connectionId);
  },

  pauseConnection(
    detail = "This browser will stop syncing until you resume it.",
  ) {
    connectionRecoveryIntent = null;
    roamgateLocalStorage.setItem("connectionPaused", "true");
    stopPolling();
    disposeTerminalConnection(
      {
        connectionId: state.activeConnectionId,
        generation: state.connectionGeneration,
      },
      true,
    );
    bridge.disconnect();
    set({
      connectionPaused: true,
      status: "disconnected",
      connectionGeneration: bridge.clientGeneration,
      bridgeStatus: null,
      terminalAttachEpoch: state.terminalAttachEpoch + 1,
      notice: {
        kind: "info",
        message: "Connection paused",
        detail,
      },
    });
  },

  pauseOtherClients() {
    return action(async (lease) => {
      const result = await bridge.call("bridge.pause_others");
      const pausedClients = Number(result?.paused_clients ?? 0);
      setForConnection(lease, {
        notice: {
          kind: pausedClients > 0 ? "success" : "info",
          message:
            pausedClients === 1
              ? "Paused 1 other browser"
              : `Paused ${pausedClients} other browsers`,
          autoDismissMs: 5000,
        },
      });
      void refreshBridgeStatus();
      return result;
    });
  },

  resumeConnection() {
    connectionRecoveryIntent = state.connectionPaused ? "resume" : "reconnect";
    roamgateLocalStorage.setItem("connectionPaused", "false");
    set({
      connectionPaused: false,
      error: null,
      notice: {
        kind: "info",
        message:
          connectionRecoveryIntent === "reconnect"
            ? "Reconnecting browser"
            : "Resuming browser sync",
        loading: true,
      },
    });
    bridge.connect();
    startPolling();
  },

  selectPane(paneId: string) {
    if (state.navigationMode === "browser-local")
      return store.focusPane(paneId);
    set({
      selectedPaneId: paneId,
      error: null,
    });
  },

  focusTab(tabId: string) {
    if (state.navigationMode === "browser-local") {
      const tab = state.tabs.find((tab) => tab.tab_id === tabId);
      return tab ? navigateBrowser(tab.workspace_id, tabId) : Promise.resolve();
    }
    const workspaceId = state.tabs.find(
      (t) => t.tab_id === tabId,
    )?.workspace_id;
    const targetPane =
      state.panes.find((pane) => pane.tab_id === tabId && pane.focused) ??
      state.panes.find((pane) => pane.tab_id === tabId);
    const pendingFocusSeq = workspaceId
      ? stampPendingFocusWorkspace(workspaceId)
      : undefined;
    return action(
      (lease) =>
        enqueueFocusAction(async () => {
          const relaySize = terminalRelayViewportForTab(
            lease.connectionId,
            lease.generation,
            tabId,
          );
          if (relaySize) {
            // Pre-size background runtimes for the target tab while the current
            // tab's direct attachments are still locked. The bridge confirms the
            // projected viewport through pane.layout before focus proceeds, so
            // the target is stable before it becomes visible.
            await lease.client
              .call("terminal.relay_resize", {
                cols: relaySize.cols,
                rows: relaySize.rows,
                ...(targetPane ? { pane_id: targetPane.pane_id } : {}),
              })
              .catch(() => null);
          }
          if (workspaceId) {
            await lease.client.call("workspace.focus", {
              workspace_id: workspaceId,
            });
          }
          return lease.client.call("tab.focus", { tab_id: tabId });
        }),
      {
        refresh: "immediate",
        pendingFocusWorkspaceSeq: pendingFocusSeq,
        retryOnReconnect: true,
      },
    );
  },

  createTab(workspaceId: string, options: { numberedLabel?: boolean } = {}) {
    const navigation = state.browserNavigation;
    return action(
      async (lease) => {
        const reason = endpointCreationReason(state, "tab.create", workspaceId);
        if (reason) throw new Error(reason);
        const result: unknown = await lease.client.call("tab.create", {
          workspace_id: workspaceId,
          focus: state.navigationMode !== "browser-local",
          ...(state.navigationMode === "browser-local"
            ? {
                browser_source: browserCreationSource(workspaceId),
              }
            : {}),
        });
        if (browserSelectionIsCurrent(navigation))
          adoptBrowserTarget(lease, result);
        if (!options.numberedLabel) return result;

        const rename = numberedCreatedTabRename(result);
        if (!rename) return result;
        try {
          await lease.client.call("tab.rename", {
            tab_id: rename.tabId,
            label: rename.label,
          });
        } catch (error) {
          // The tab already exists, so keep the successful create visible while
          // surfacing the non-fatal naming failure to the user.
          setForConnection(lease, {
            notice: {
              kind: "error",
              message: "Tab created, but naming failed",
              detail: (error as Error).message,
            },
          });
        }
        return result;
      },
      {
        failureNotice: (error) => ({
          kind: "error",
          message: "Tab creation failed",
          detail: error.message,
        }),
      },
    );
  },

  closeTab(tabId: string) {
    return action((lease) => lease.client.call("tab.close", { tab_id: tabId }));
  },

  renameTab(tabId: string, label: string) {
    return action((lease) =>
      lease.client.call("tab.rename", { tab_id: tabId, label }),
    );
  },

  focusWorkspace(workspaceId: string) {
    if (state.navigationMode === "browser-local") {
      return state.workspaces.some(
        (workspace) => workspace.workspace_id === workspaceId,
      )
        ? navigateBrowser(workspaceId)
        : Promise.resolve();
    }
    const pendingFocusSeq = stampPendingFocusWorkspace(workspaceId);
    return action(
      (lease) =>
        enqueueFocusAction(() =>
          lease.client.call("workspace.focus", { workspace_id: workspaceId }),
        ),
      {
        refresh: "immediate",
        pendingFocusWorkspaceSeq: pendingFocusSeq,
        retryOnReconnect: true,
      },
    );
  },

  focusTaskNotificationTarget(target: TaskNotificationTarget) {
    if (!taskNotificationTargetIsCurrent(state, target)) {
      return Promise.resolve(undefined);
    }
    if (
      target.connectionId !== state.activeConnectionId &&
      !selectConnectionNow(target.connectionId)
    ) {
      return Promise.resolve(undefined);
    }
    if (
      !taskNotificationTargetIsCurrent(state, target) ||
      state.serverRuntimeGeneration !== target.runtimeGeneration
    ) {
      return Promise.resolve(undefined);
    }
    if (state.navigationMode === "browser-local") {
      const navigation = state.browserNavigation;
      return action(
        async (lease) => {
          const result = await lease.client
            .call("pane.get", { pane_id: target.paneId })
            .catch(() => null);
          if (!leaseIsCurrent(lease)) return;
          if (!browserSelectionIsCurrent(navigation)) return refreshNow(lease);
          if (result?.pane) adoptBrowserTarget(lease, result);
          else
            setForConnection(lease, {
              browserNavigation: selectBrowserTarget(
                state.browserNavigation,
                target.workspaceId,
              ),
            });
          return refreshNow(lease);
        },
        { refresh: "none" },
      );
    }
    const pendingFocusSeq = stampPendingFocusWorkspace(target.workspaceId);
    return action(
      (lease) =>
        enqueueFocusAction(async () => {
          let pane: Pane | null = null;
          try {
            const result = await lease.client.call("pane.get", {
              pane_id: target.paneId,
            });
            pane = (result?.pane ?? null) as Pane | null;
          } catch {
            // The pane may have closed after the notification was shown.
          }

          const workspaceId = pane?.workspace_id ?? target.workspaceId;
          await lease.client.call("workspace.focus", {
            workspace_id: workspaceId,
          });
          if (!pane) return null;

          try {
            await lease.client.call("tab.focus", { tab_id: pane.tab_id });
          } catch {
            // The pane or tab can close between pane.get and tab.focus.
            return null;
          }
          setForConnection(lease, { selectedPaneId: pane.pane_id });
          return pane;
        }),
      {
        refresh: "immediate",
        pendingFocusWorkspaceSeq: pendingFocusSeq,
      },
    );
  },

  createWorkspace(label?: string, cwd?: string) {
    const navigation = state.browserNavigation;
    return action(
      async (lease) => {
        const reason = endpointCreationReason(state, "workspace.create");
        if (reason) throw new Error(reason);
        const result = await lease.client.call("workspace.create", {
          label,
          cwd,
          focus: state.navigationMode !== "browser-local",
          ...(state.navigationMode === "browser-local"
            ? {
                browser_source: browserCreationSource(
                  state.browserNavigation.workspaceId,
                ),
              }
            : {}),
        });
        if (browserSelectionIsCurrent(navigation))
          adoptBrowserTarget(lease, result);
        return result;
      },
      {
        failureNotice: (error) => ({
          kind: "error",
          message: "Workspace creation failed",
          detail: error.message,
        }),
      },
    );
  },

  renameWorkspace(workspaceId: string, label: string) {
    return action((lease) =>
      lease.client.call("workspace.rename", {
        workspace_id: workspaceId,
        label,
      }),
    );
  },

  closeWorkspace(workspaceId: string) {
    return action(
      (lease) =>
        lease.client.call("workspace.close", { workspace_id: workspaceId }),
      {
        failureNotice: (error) => ({
          kind: "error",
          message: error.message.startsWith("workspace_group_close_required:")
            ? "Workspace belongs to a group"
            : "Workspace close failed",
          detail: error.message.startsWith("workspace_group_close_required:")
            ? "Nothing was closed. To close this workspace and its linked workspaces, explicitly close the group in the Herdr CLI with --group."
            : error.message,
        }),
      },
    );
  },

  moveWorkspace(workspaceId: string, insertIndex: number) {
    return action(
      (lease) =>
        lease.client.call("workspace.move", {
          workspace_id: workspaceId,
          insert_index: insertIndex,
        }),
      { refresh: "immediate" },
    );
  },

  gitPullWorkspace(workspaceId: string) {
    return action(
      async (lease) => {
        setForConnection(lease, {
          notice: {
            kind: "info",
            message: "Running git pull",
            detail: "git pull --ff-only",
            detailMode: "output",
            detailTitle: "Command",
            loading: true,
          },
        });
        const result = await lease.client.call("git.pull", {
          workspace_id: workspaceId,
        });
        const output = [result?.stdout, result?.stderr]
          .filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0,
          )
          .join("\n")
          .trim();
        setForConnection(lease, {
          notice: {
            kind: "success",
            message: "Git pull completed",
            detail: output ? output.slice(0, 1400) : "Already up to date.",
            detailMode: output ? "output" : "text",
            detailTitle: output ? "git pull --ff-only" : undefined,
          },
        });
        return result;
      },
      {
        refresh: "immediate",
        failureNotice: (error) => ({
          kind: "error",
          message: "Git pull failed",
          detail: error.message,
          detailMode: "output",
          detailTitle: "git pull --ff-only",
        }),
      },
    );
  },

  runGitFileAction(
    workspaceId: string,
    gitAction: GitFileAction,
    entry: Pick<GitDiffEntry, "path" | "old_path" | "mtime_ms" | "size">,
  ) {
    const label = gitFileActionLabel(gitAction);
    return action(
      async (lease) => {
        const result = await lease.client.call("git.file_action", {
          workspace_id: workspaceId,
          action: gitAction,
          path: entry.path,
          old_path: entry.old_path,
          mtime_ms: entry.mtime_ms,
          size: entry.size,
        });
        setForConnection(lease, {
          notice: {
            kind: "success",
            message: gitFileActionSuccessMessage(gitAction),
            detail: entry.path,
            autoDismissMs: 5000,
          },
        });
        return result;
      },
      {
        refresh: "immediate",
        failureNotice: (error) => ({
          kind: "error",
          message: `${label} failed`,
          detail: error.message,
          detailMode: "text",
        }),
      },
    );
  },

  runGitFileActionBatch(
    workspaceId: string,
    gitAction: GitFileAction,
    entries: Pick<GitDiffEntry, "path" | "old_path" | "mtime_ms" | "size">[],
  ) {
    const label = gitFileActionLabel(gitAction);
    let completed = 0;
    return action(
      async (lease) => {
        try {
          for (const entry of entries) {
            await lease.client.call("git.file_action", {
              workspace_id: workspaceId,
              action: gitAction,
              path: entry.path,
              old_path: entry.old_path,
              mtime_ms: entry.mtime_ms,
              size: entry.size,
            });
            completed += 1;
          }
        } catch (error) {
          if (completed && leaseIsCurrent(lease)) void refreshNow(lease);
          throw error;
        }
        setForConnection(lease, {
          notice: {
            kind: "success",
            message: `${gitFileActionSuccessMessage(gitAction)} (${
              completed === 1 ? "1 file" : `${completed} files`
            })`,
            autoDismissMs: 5000,
          },
        });
        return completed;
      },
      {
        refresh: "immediate",
        failureNotice: (error) => ({
          kind: "error",
          message: `${label} failed`,
          detail: `${completed} of ${entries.length} files completed. ${error.message}`,
          detailMode: "text",
        }),
      },
    );
  },

  runGitRepoAction(
    workspaceId: string,
    gitAction: GitRepoAction,
    expectedCounts?: Partial<GitWorkingCounts>,
  ) {
    return action(
      async (lease) => {
        const result = await lease.client.call("git.repo_action", {
          workspace_id: workspaceId,
          action: gitAction,
          expected_counts: expectedCounts,
        });
        setForConnection(lease, {
          notice: {
            kind: "success",
            message: gitRepoActionSuccessMessage(gitAction),
            autoDismissMs: 5000,
          },
        });
        return result;
      },
      {
        refresh: "immediate",
        failureNotice: (error) => ({
          kind: "error",
          message: "Git action failed",
          detail: error.message,
          detailMode: "text",
        }),
      },
    );
  },

  createWorktree(workspaceId: string, branch: string) {
    const navigation = state.browserNavigation;
    return action(
      async (lease) => {
        setForConnection(lease, {
          notice: {
            kind: "info",
            message: "Creating worktree",
            detail: `Updating origin's default branch before creating ${branch}.`,
            detailMode: "output",
            detailTitle: "Fetch origin's default branch",
            loading: true,
          },
        });
        const result = await lease.client.call("worktree.create", {
          workspace_id: workspaceId,
          branch,
          focus: state.navigationMode !== "browser-local",
        });
        if (browserSelectionIsCurrent(navigation))
          adoptBrowserTarget(lease, result);
        const setupHook = result?.setup_hook as
          | WorktreeHookRunResult
          | undefined;
        const setupNotice = setupHook
          ? summarizeDirectHookResult(setupHook)
          : null;
        if (setupNotice) {
          setForConnection(lease, { notice: setupNotice });
        } else {
          const commit = String(result?.base_sync?.commit ?? "").slice(0, 12);
          const base = String(
            result?.base_sync?.base ?? "origin's default branch",
          );
          setForConnection(lease, {
            notice: {
              kind: "success",
              message: "Worktree created",
              detail: commit
                ? `${branch} starts from ${base} at ${commit}.`
                : `${branch} starts from the latest ${base}.`,
              autoDismissMs: 5000,
            },
          });
        }
        return result;
      },
      {
        failureNotice: (error) => ({
          kind: "error",
          message: "Failed to create worktree",
          detail: error.message,
        }),
      },
    );
  },

  openWorktree(workspaceId: string, target: string, focus = true) {
    const navigation = state.browserNavigation;
    const trimmed = target.trim();
    const locator = trimmed.startsWith("/")
      ? { path: trimmed }
      : { branch: trimmed };
    return action(async (lease) => {
      const result = await lease.client.call("worktree.open", {
        workspace_id: workspaceId,
        ...locator,
        focus: focus && state.navigationMode !== "browser-local",
      });
      if (focus && browserSelectionIsCurrent(navigation))
        adoptBrowserTarget(lease, result);
      const openedHook = result?.opened_hook as
        | WorktreeHookRunResult
        | undefined;
      const openedNotice = openedHook
        ? summarizeDirectHookResult(openedHook)
        : null;
      if (openedNotice) setForConnection(lease, { notice: openedNotice });
      return result;
    });
  },

  // A linked checkout can remain open after its main workspace is closed.
  // Herdr accepts the repository root as the source in that state, allowing
  // the GUI to reopen main without inventing or guessing a workspace ID.
  openWorktreeFromCwd(cwd: string, target: string, focus = true) {
    const navigation = state.browserNavigation;
    const trimmed = target.trim();
    const locator = trimmed.startsWith("/")
      ? { path: trimmed }
      : { branch: trimmed };
    return action(async (lease) => {
      const result = await lease.client.call("worktree.open", {
        cwd,
        ...locator,
        focus: focus && state.navigationMode !== "browser-local",
      });
      if (focus && browserSelectionIsCurrent(navigation))
        adoptBrowserTarget(lease, result);
      const openedHook = result?.opened_hook as
        | WorktreeHookRunResult
        | undefined;
      const openedNotice = openedHook
        ? summarizeDirectHookResult(openedHook)
        : null;
      if (openedNotice) setForConnection(lease, { notice: openedNotice });
      return result;
    });
  },

  removeWorktree(
    workspaceId: string,
    force = false,
    workspaceHint?: Workspace,
  ) {
    return action(
      async (lease) => {
        const removedWorkspace =
          state.workspaces.find(
            (workspace) => workspace.workspace_id === workspaceId,
          ) ?? workspaceHint;
        setForConnection(lease, {
          notice: {
            kind: "info",
            message: "Removing worktree",
            detail: "Running teardown hook if configured.",
            loading: true,
          },
        });
        const result = await lease.client.call(
          "worktree.remove",
          {
            workspace_id: workspaceId,
            force,
          },
          // Hooks are part of this RPC and can legitimately run longer than
          // Herdr's own bounded remove call. Let disconnects end the browser
          // wait instead of reporting a timeout while deletion continues.
          null,
        );
        const beforeRemoveHook = result?.before_remove_hook as
          | WorktreeHookRunResult
          | undefined;
        const beforeRemoveNotice = beforeRemoveHook
          ? summarizeDirectHookResult(beforeRemoveHook)
          : null;
        if (beforeRemoveNotice) {
          setForConnection(lease, { notice: beforeRemoveNotice });
        }
        if (result?.skipped_remove) {
          if (!beforeRemoveNotice) setForConnection(lease, { notice: null });
          return result;
        }

        await refreshNow(lease);
        setForConnection(lease, {
          terminalAttachEpoch: state.terminalAttachEpoch + 1,
        });
        if (removedWorkspace && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent<WorktreeRemovedTarget>(WORKTREE_REMOVED_EVENT, {
              detail: {
                connectionId: lease.connectionId,
                generation: lease.generation,
                workspace: removedWorkspace,
              },
            }),
          );
        }
        const removedHook = result?.removed_hook as
          | WorktreeHookRunResult
          | undefined;
        const removedNotice = removedHook
          ? summarizeDirectHookResult(removedHook)
          : null;
        const cleanup = result?.cleanup as WorktreeRemovalCleanup | undefined;
        const completionNotice = worktreeRemovalCompletionNotice(
          cleanup,
          removedNotice,
        );
        if (completionNotice) {
          setForConnection(lease, { notice: completionNotice });
        } else if (!beforeRemoveNotice) {
          setForConnection(lease, {
            notice: {
              kind: "success",
              message: "Worktree removed",
            },
          });
        }
        return result;
      },
      {
        failureNotice: (error) => ({
          kind: "error",
          message: "Failed to remove worktree",
          detail: error.message,
        }),
      },
    );
  },

  setRepoWorktreeHooksEnabled(key: string, enabled: boolean) {
    return action(async (lease) => {
      const result = await lease.client.call("settings.update_repo", {
        key,
        settings: { worktree_hooks_enabled: enabled },
      });
      await refreshNow(lease);
      return result;
    });
  },

  setWorkspaceAutoSyncEnabled(workspaceId: string, enabled: boolean) {
    return action(
      async (lease) => {
        const result = await lease.client.call(
          "settings.workspace_auto_sync.update",
          {
            workspace_id: workspaceId,
            enabled,
          },
        );
        setForConnection(lease, {
          notice: {
            kind: "success",
            message: enabled
              ? "Automatic branch updates enabled"
              : "Automatic branch updates disabled",
            detail: enabled
              ? "A sync will run now, then every 10 minutes while this workspace remains open."
              : undefined,
            autoDismissMs: 5000,
          },
        });
        return result;
      },
      {
        refresh: "none",
        failureNotice: (error) => ({
          kind: "error",
          message: "Failed to update automatic sync settings",
          detail: error.message,
        }),
      },
    );
  },

  setWorkspaceAutoSyncConfigEnabled(key: string, enabled: boolean) {
    return action(
      async (lease) => {
        const result = await lease.client.call(
          "settings.workspace_auto_sync.update_key",
          { key, enabled },
        );
        setForConnection(lease, {
          notice: {
            kind: "success",
            message: enabled
              ? "Automatic branch updates enabled"
              : "Automatic branch updates disabled",
            detail: key,
            autoDismissMs: 5000,
          },
        });
        return result;
      },
      {
        refresh: "none",
        failureNotice: (error) => ({
          kind: "error",
          message: "Failed to update automatic sync settings",
          detail: error.message,
        }),
      },
    );
  },

  clearNotice() {
    set({ notice: null });
  },

  notify(notice: Notice) {
    set({ notice });
  },

  async restoreTaskNotifications() {
    const version = ++taskNotificationPreferenceVersion;
    set({ taskNotificationBusy: true });
    try {
      if (state.taskNotificationsEnabled) await prepareTaskNotifications();
      if (version !== taskNotificationPreferenceVersion) return;
      const transport = await syncTaskPush(
        state.taskNotificationsEnabled,
        state.taskNotificationPreferences,
      );
      if (version === taskNotificationPreferenceVersion) {
        roamgateLocalStorage.setItem("taskNotificationTransport", transport);
        set({ taskNotificationTransport: transport });
      }
    } catch (error) {
      if (version === taskNotificationPreferenceVersion)
        set({
          notice: {
            kind: "error",
            message: "Background notification sync failed",
            detail: (error as Error).message,
          },
        });
    } finally {
      if (version === taskNotificationPreferenceVersion)
        set({ taskNotificationBusy: false });
    }
  },

  async setTaskNotificationPreference(
    kind: keyof TaskNotificationPreferences,
    enabled: boolean,
  ) {
    const version = ++taskNotificationPreferenceVersion;
    const preferences = {
      ...state.taskNotificationPreferences,
      [kind]: enabled,
    };
    set({ taskNotificationBusy: true });
    try {
      const transport = await syncTaskPush(
        state.taskNotificationsEnabled,
        preferences,
      );
      if (version !== taskNotificationPreferenceVersion) return;
      roamgateLocalStorage.setItem("taskNotificationTransport", transport);
      roamgateLocalStorage.setItem(
        TASK_NOTIFICATION_PREFERENCES_KEY,
        JSON.stringify(preferences),
      );
      set({
        taskNotificationPreferences: preferences,
        taskNotificationTransport: transport,
      });
    } catch (error) {
      if (version === taskNotificationPreferenceVersion)
        set({
          notice: {
            kind: "error",
            message: "Notification preference was not saved",
            detail: (error as Error).message,
          },
        });
    } finally {
      if (version === taskNotificationPreferenceVersion)
        set({ taskNotificationBusy: false });
    }
  },

  async setTaskNotificationsEnabled(enabled: boolean) {
    const version = ++taskNotificationPreferenceVersion;
    set({ taskNotificationBusy: true });
    if (!enabled) {
      try {
        await syncTaskPush(false, state.taskNotificationPreferences);
      } catch (error) {
        if (version === taskNotificationPreferenceVersion)
          set({
            taskNotificationBusy: false,
            notice: {
              kind: "error",
              message: "Notification revocation failed",
              detail: (error as Error).message,
            },
          });
        return;
      }
      if (version !== taskNotificationPreferenceVersion) return;
      roamgateLocalStorage.setItem(TASK_NOTIFICATIONS_KEY, "false");
      set({
        taskNotificationsEnabled: false,
        taskNotificationBusy: false,
        taskNotificationTransport: "local",
        taskNotificationPermission: notificationPermission(),
        notice: {
          kind: "info",
          message: "Task notifications disabled on this device",
          autoDismissMs: 5000,
        },
      });
      return;
    }

    if (notificationPermission() === "unsupported") {
      roamgateLocalStorage.setItem(TASK_NOTIFICATIONS_KEY, "false");
      set({
        taskNotificationsEnabled: false,
        taskNotificationPermission: "unsupported",
        taskNotificationBusy: false,
        notice: {
          kind: "error",
          message: "Browser notifications are not supported",
          detail:
            "Use a browser with notification support over HTTPS. On iPhone or iPad, open Roamgate from the Home Screen (iOS/iPadOS 16.4 or later).",
        },
      });
      return;
    }

    let permission = Notification.permission;
    try {
      if (permission === "default") {
        permission = await Notification.requestPermission();
      }
      if (version !== taskNotificationPreferenceVersion) return;
    } catch (e) {
      if (version !== taskNotificationPreferenceVersion) return;
      roamgateLocalStorage.setItem(TASK_NOTIFICATIONS_KEY, "false");
      set({
        taskNotificationsEnabled: false,
        taskNotificationBusy: false,
        taskNotificationPermission: notificationPermission(),
        notice: {
          kind: "error",
          message: "Notification permission failed",
          detail: (e as Error).message,
        },
      });
      return;
    }

    const granted = permission === "granted";
    let transport: "local" | "push" = "local";
    if (granted) {
      set({ taskNotificationBusy: true });
      try {
        await prepareTaskNotifications();
        if (version !== taskNotificationPreferenceVersion) return;
        transport = await syncTaskPush(
          true,
          state.taskNotificationPreferences,
          true,
        );
      } catch (error) {
        reportTaskNotificationFailure(error, version);
        return;
      } finally {
        if (version === taskNotificationPreferenceVersion)
          set({ taskNotificationBusy: false });
      }
    }
    if (version !== taskNotificationPreferenceVersion) return;
    roamgateLocalStorage.setItem("taskNotificationTransport", transport);
    roamgateLocalStorage.setItem(
      TASK_NOTIFICATIONS_KEY,
      granted ? "true" : "false",
    );
    set({
      taskNotificationsEnabled: granted,
      taskNotificationTransport: transport,
      taskNotificationBusy: false,
      taskNotificationPermission: permission,
      notice: granted
        ? {
            kind: "success",
            message: "Task notifications enabled",
            detail:
              transport === "push"
                ? "This device receives completion and input-required notifications even when Roamgate is closed, subject to your platform settings."
                : "Local notifications work while this page is running. Background delivery requires Web Push support and server configuration.",
            autoDismissMs: 5000,
          }
        : {
            kind: "error",
            message: "Notification permission was not granted",
            detail:
              "Enable notifications for this site in the browser settings, then try again.",
          },
    });
  },

  checkForUpdate() {
    return checkForUpdate(true);
  },

  setAutomaticUpdateChecksEnabled(enabled: boolean) {
    try {
      roamgateLocalStorage.setItem(
        AUTOMATIC_UPDATE_CHECKS_KEY,
        String(enabled),
      );
    } catch {
      // The in-memory preference still applies when storage is unavailable.
    }
    if (!enabled && updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }
    set({
      automaticUpdateChecksEnabled: enabled,
      updateInfo: enabled ? state.updateInfo : null,
    });
    if (enabled && !state.connectionPaused) startUpdatePolling();
  },

  updateOrCheck() {
    if (
      state.updateInfo?.update_available &&
      state.updateInfo.can_auto_update
    ) {
      return this.installUpdate();
    }
    return checkForUpdate(true);
  },

  dismissUpdate() {
    set({
      dismissedUpdateVersion: state.updateInfo?.latest_version ?? null,
      updateInfo: null,
    });
  },

  async installUpdate() {
    if (state.connectionPaused) {
      set({
        notice: {
          kind: "info",
          message: "Connection is paused",
          detail: "Resume the connection before installing updates.",
        },
      });
      return;
    }
    const latestVersion = state.updateInfo?.latest_version;
    if (!latestVersion || state.updateInstalling) return;
    set({ updateInstalling: true });
    try {
      const r = await fetch("/api/update/install", {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-roamgate-update": "1" },
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        throw new Error(body?.error ?? r.statusText);
      }
      if (body?.installed) {
        const installedVersion = body.installed_version ?? latestVersion;
        if (body.restart_scheduled) {
          storePendingRestartVersion(installedVersion);
          set({
            updateInfo: null,
            updateInstalling: false,
            pendingRestartVersion: installedVersion,
            dismissedUpdateVersion: latestVersion,
            notice: {
              kind: "info",
              message: "Restarting the Roamgate process",
              detail:
                "The binary was updated. Waiting for the external process supervisor to start the new version.",
              loading: true,
            },
          });
          void reloadWhenUpdatedServerIsReady(installedVersion);
          return;
        }
        set({
          updateInfo: null,
          updateInstalling: false,
          dismissedUpdateVersion: latestVersion,
          notice: {
            kind: "success",
            message: `Roamgate ${installedVersion} installed`,
            detail: "Restart the Roamgate process to use the new version.",
          },
        });
        return;
      }
      set({
        updateInfo: null,
        updateInstalling: false,
        dismissedUpdateVersion: latestVersion,
        notice: {
          kind: "success",
          message: "Roamgate is already up to date",
        },
      });
    } catch (e) {
      set({
        updateInstalling: false,
        notice: {
          kind: "error",
          message: "Update install failed",
          detail: (e as Error).message,
        },
      });
    }
  },

  sendText(paneId: string, text: string) {
    return action((lease) =>
      lease.client.call("pane.send_text", { pane_id: paneId, text }),
    );
  },

  sendKeys(paneId: string, keys: string) {
    // Herdr expects `keys` to be a sequence of key-combo strings.
    return action((lease) =>
      lease.client.call("pane.send_keys", { pane_id: paneId, keys: [keys] }),
    );
  },

  focusPane(paneId: string) {
    const pane = state.panes.find((p) => p.pane_id === paneId);
    if (state.navigationMode === "browser-local") {
      return pane
        ? navigateBrowser(pane.workspace_id, pane.tab_id, paneId)
        : Promise.resolve();
    }
    const pendingFocusSeq = pane?.workspace_id
      ? stampPendingFocusWorkspace(pane.workspace_id)
      : undefined;
    return action(
      (lease) =>
        enqueueFocusAction(async () => {
          if (pane?.workspace_id) {
            await lease.client.call("workspace.focus", {
              workspace_id: pane.workspace_id,
            });
          }
          if (pane)
            await lease.client.call("tab.focus", { tab_id: pane.tab_id });
          setForConnection(lease, { selectedPaneId: paneId });
          return pane;
        }),
      { refresh: "immediate", pendingFocusWorkspaceSeq: pendingFocusSeq },
    );
  },

  splitPane(paneId: string, direction: "right" | "down") {
    const navigation = state.browserNavigation;
    return action(async (lease) => {
      const result = await lease.client.call("pane.split", {
        target_pane_id: paneId,
        direction,
        focus: state.navigationMode !== "browser-local",
      });
      const selectionIsCurrent = browserSelectionIsCurrent(navigation);
      if (selectionIsCurrent) adoptBrowserTarget(lease, result);
      const nextPaneId =
        typeof result?.pane?.pane_id === "string" ? result.pane.pane_id : null;
      if (nextPaneId && selectionIsCurrent)
        setForConnection(lease, { selectedPaneId: nextPaneId });
      return result;
    });
  },

  zoomPane(paneId: string) {
    return action((lease) =>
      lease.client.call("pane.zoom", { pane_id: paneId }),
    );
  },

  resizePane(
    paneId: string,
    direction: "left" | "right" | "up" | "down",
    amount: number,
  ) {
    return action(async (lease) => {
      const result = await lease.client.call("pane.resize", {
        pane_id: paneId,
        direction,
        amount,
      });
      const layout = result?.resize?.layout;
      rememberTabLayout(lease.connectionId, lease.generation, layout ?? null);
      if (layout && state.layout?.tab_id === layout.tab_id)
        setForConnection(lease, {
          layout:
            state.navigationMode === "browser-local"
              ? projectBrowserLayout(layout, state.selectedPaneId)
              : layout,
        });
      return result;
    });
  },

  focusPaneDirection(
    paneId: string,
    direction: "left" | "right" | "up" | "down",
  ) {
    if (state.navigationMode === "browser-local") {
      const target = browserPaneInDirection(state.layout, paneId, direction);
      return target ? store.focusPane(target) : Promise.resolve();
    }
    return action(async (lease) => {
      const result = await lease.client.call("pane.focus_direction", {
        pane_id: paneId,
        direction,
      });
      const focus = result?.focus ?? result?.focus_direction ?? result;
      const focusedPaneId =
        typeof focus?.focused_pane_id === "string"
          ? focus.focused_pane_id
          : null;
      if (focusedPaneId) {
        setForConnection(lease, { selectedPaneId: focusedPaneId });
      }
      if (focus?.layout) {
        setForConnection(lease, { layout: focus.layout as PaneLayout });
      }
      await refreshNow(lease);
      return result;
    });
  },

  /**
   * Ask the bridge which popup Herdr currently has open. Pushes only fire on
   * change, so a browser that just connected, or just switched connection, has
   * to ask once.
   */
  watchPopup() {
    return action(async (lease) => {
      const result = (await lease.client.call("terminal.watch_popup", {})) as
        | { popup: PopupInfo | null }
        | undefined;
      setForConnection(lease, { popup: result?.popup ?? null });
    });
  },

  /** Close the open popup, if any (Herdr's generic popup.close method). */
  closePopup() {
    return action((lease) => lease.client.call("popup.close", {}));
  },

  /**
   * Hide the popup if one is open, otherwise invoke the plugin action that
   * opens it.
   *
   * Asks Herdr rather than trusting this client's popup state, which can lag
   * behind: opening on a stale "none" is refused with "a popup pane is already
   * open", and that refusal only ever reaches the plugin's command log, so the
   * key would look dead. "popup_not_open" is the definitive answer that
   * nothing was open and the action should run.
   */
  togglePluginPopup(
    pluginId: string,
    actionId: string,
    context: Record<string, unknown> = {},
  ) {
    return action(async (lease) => {
      try {
        await lease.client.call("popup.close", {});
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("popup_not_open")) throw error;
      }
      if (!leaseIsCurrent(lease)) return;
      // Herdr opens a popup in whichever Space it has focused, and a plugin
      // handed a different one declines: herdr-float reports "Space changed"
      // and exits successfully, so the key looks dead. Match Herdr's focus to
      // the Space the action is invoked for.
      const workspaceId = context.workspace_id;
      if (typeof workspaceId === "string" && workspaceId) {
        const focused = store.get().workspaces.find((w) => w.focused);
        if (focused?.workspace_id !== workspaceId) {
          await lease.client.call("workspace.focus", {
            workspace_id: workspaceId,
          });
          if (!leaseIsCurrent(lease)) return;
        }
      }
      await lease.client.call("plugin.action.invoke", {
        plugin_id: pluginId,
        action_id: actionId,
        context,
      });
    });
  },

  closePane(paneId: string) {
    return action((lease) =>
      lease.client.call("pane.close", { pane_id: paneId }),
    );
  },
};

/** Test-only singleton seam for deterministic deferred production-store tests. */
export const __storeTesting = {
  handleHerdrEvent,
  startUpdatePolling,
  updatePollingActive: () => updateTimer !== null,
  refreshBridgeStatus,
  markTerminalReattachPending() {
    terminalReattachPending = true;
    catalogReadyForConnection = false;
    bridge.setConnectionRuntimeGenerations([]);
  },
  rearmTerminalAttachmentsAfterCatalog,
  replaceState(snapshot: State) {
    stopPolling();
    refreshingConnectionKeys.clear();
    queuedConnectionKeys.clear();
    focusActionChain = Promise.resolve();
    taskCompletionTracker.clear();
    state = snapshot;
    terminalReattachPending = false;
    connectionRecoveryIntent = null;
    catalogReadyForConnection = snapshot.connections.length > 0;
    bridge.setConnectionRuntimeGenerations(snapshot.connections);
  },
  applyCatalog(connections: ConnectionSummary[], defaultConnectionId: string) {
    const requestSeq = ++catalogRequestSeq;
    applyConnectionCatalog(
      { connections, default_connection_id: defaultConnectionId },
      requestSeq,
    );
  },
};

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Shallowly compares own enumerable values; pair with useStoreSelector. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (
      !Object.is(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Subscribe to a derived slice of the store. The selector result is cached
 * and reused while `isEqual` reports equality, so inline selectors are safe
 * as long as they keep stable semantics; object-returning selectors should
 * pass a shallow equality to avoid re-rendering on every emit.
 */
export function useStoreSelector<T>(
  selector: (state: State) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cacheRef = useRef<{
    state: State;
    selector: (state: State) => T;
    value: T;
  } | null>(null);

  const getSnapshot = () => {
    const snapshot = store.get();
    const cache = cacheRef.current;
    if (cache && cache.state === snapshot && cache.selector === selector) {
      return cache.value;
    }
    const value = selector(snapshot);
    if (cache && isEqual(cache.value, value)) {
      cacheRef.current = { state: snapshot, selector, value: cache.value };
      return cache.value;
    }
    cacheRef.current = { state: snapshot, selector, value };
    return value;
  };

  return useSyncExternalStore(store.subscribe, getSnapshot);
}
