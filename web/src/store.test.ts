import { describe, expect, test } from "bun:test";
import { bridge, type ConnectionClient } from "./api";
import {
  __storeTesting,
  activateConnectionState,
  automaticUpdateChecksEnabledFromStorage,
  bindTaskNotificationActivation,
  connectionEventIsActive,
  DEFAULT_NOTICE_AUTO_DISMISS_MS,
  emptyServerSessionState,
  healthMatchesUpdateVersion,
  isTaskNotificationTarget,
  mergeConnectionCatalog,
  nextRecentPaneIds,
  noticeAutoDismissDelay,
  numberedCreatedTabRename,
  reconcileConnectionCatalogSessions,
  stabilizeRefreshPatch,
  type ServerSessionState,
  type State,
  store,
  summarizeDirectHookResult,
  TaskCompletionTracker,
  taskNotificationTag,
  taskNotificationTarget,
  taskNotificationTargetFromNotice,
  taskNotificationTargetIsCurrent,
  worktreeRemovalCompletionNotice,
} from "./store";
import type { Pane } from "./types";

describe("automatic update check preference", () => {
  test("defaults to enabled and honors an explicit disabled value", () => {
    expect(automaticUpdateChecksEnabledFromStorage(undefined)).toBe(true);
    expect(
      automaticUpdateChecksEnabledFromStorage({
        getItem: () => "false",
      }),
    ).toBe(false);
    expect(
      automaticUpdateChecksEnabledFromStorage({
        getItem: () => "true",
      }),
    ).toBe(true);
  });

  test("falls back to enabled when browser storage is unavailable", () => {
    expect(
      automaticUpdateChecksEnabledFromStorage({
        getItem: () => {
          throw new Error("storage denied");
        },
      }),
    ).toBe(true);
  });

  test("cancels polling and ignores an in-flight automatic result when disabled", async () => {
    const previousState = store.get();
    const previousFetch = globalThis.fetch;
    const previousLocalStorage = globalThis.localStorage;
    let resolveFetch!: (response: Response) => void;
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as unknown as typeof fetch;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { setItem: () => undefined },
    });
    try {
      __storeTesting.replaceState(partitionState());
      const automaticCheck = __storeTesting.startUpdatePolling();
      expect(__storeTesting.updatePollingActive()).toBe(true);

      store.setAutomaticUpdateChecksEnabled(false);
      expect(__storeTesting.updatePollingActive()).toBe(false);
      expect(store.get().automaticUpdateChecksEnabled).toBe(false);

      resolveFetch(
        Response.json({
          current_version: "0.4.5",
          latest_version: "0.5.0",
          update_available: true,
          can_auto_update: true,
          platform: "darwin-arm64",
        }),
      );
      await automaticCheck;
      expect(store.get().updateInfo).toBeNull();
    } finally {
      __storeTesting.replaceState(previousState);
      globalThis.fetch = previousFetch;
      if (previousLocalStorage === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: previousLocalStorage,
        });
      }
    }
  });

  test("restarts polling when enabled while manual checks bypass the preference", async () => {
    const previousState = store.get();
    const previousFetch = globalThis.fetch;
    const previousLocalStorage = globalThis.localStorage;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return Response.json({
        current_version: "0.4.5",
        latest_version: "0.4.5",
        update_available: false,
        can_auto_update: true,
        platform: "darwin-arm64",
      });
    }) as unknown as typeof fetch;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { setItem: () => undefined },
    });
    try {
      __storeTesting.replaceState({
        ...partitionState(),
        automaticUpdateChecksEnabled: false,
      });

      store.setAutomaticUpdateChecksEnabled(true);
      expect(fetchCalls).toBe(1);
      expect(__storeTesting.updatePollingActive()).toBe(true);
      store.setAutomaticUpdateChecksEnabled(false);
      expect(__storeTesting.updatePollingActive()).toBe(false);

      await store.checkForUpdate();
      expect(fetchCalls).toBe(2);
      expect(store.get().notice?.message).toBe("Roamgate is up to date");
    } finally {
      __storeTesting.replaceState(previousState);
      globalThis.fetch = previousFetch;
      if (previousLocalStorage === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: previousLocalStorage,
        });
      }
    }
  });
});

describe("task notification activation", () => {
  test("closes the system notification, focuses the window, and dispatches its pane target", () => {
    const calls: string[] = [];
    const targets: Array<{
      connectionId: string;
      runtimeGeneration: number;
      workspaceId: string;
      paneId: string;
    }> = [];
    const notification = {
      onclick: null as ((event: Event) => void) | null,
      close: () => calls.push("close"),
    };

    bindTaskNotificationActivation(
      notification,
      {
        connectionId: "alpha",
        runtimeGeneration: 1,
        workspaceId: "w1",
        paneId: "p2",
      },
      (target) => {
        calls.push("activate");
        targets.push(target);
      },
      () => calls.push("focus"),
    );
    notification.onclick?.(new Event("click"));

    expect(calls).toEqual(["close", "focus", "activate"]);
    expect(targets).toEqual([
      {
        connectionId: "alpha",
        runtimeGeneration: 1,
        workspaceId: "w1",
        paneId: "p2",
      },
    ]);
  });

  test("still dispatches navigation when browser window focus is denied", () => {
    let activated = false;
    const notification = {
      onclick: null as ((event: Event) => void) | null,
      close: () => undefined,
    };

    bindTaskNotificationActivation(
      notification,
      {
        connectionId: "alpha",
        runtimeGeneration: 1,
        workspaceId: "w1",
        paneId: "p2",
      },
      () => {
        activated = true;
      },
      () => {
        throw new Error("focus denied");
      },
    );

    expect(() => notification.onclick?.(new Event("click"))).not.toThrow();
    expect(activated).toBe(true);
  });

  test("rejects malformed notification targets", () => {
    expect(isTaskNotificationTarget(null)).toBe(false);
    expect(isTaskNotificationTarget({ workspaceId: "w1" })).toBe(false);
    expect(isTaskNotificationTarget({ workspaceId: "", paneId: "p2" })).toBe(
      false,
    );
    expect(
      isTaskNotificationTarget({
        connectionId: "alpha",
        runtimeGeneration: 1,
        workspaceId: "w1",
        paneId: "p2",
      }),
    ).toBe(true);
  });
});

function pane(connectionLabel: string, status: string): Pane {
  return {
    pane_id: "same-pane",
    terminal_id: "same-terminal",
    workspace_id: "same-workspace",
    tab_id: "same-tab",
    focused: false,
    agent: connectionLabel,
    agent_status: status,
    revision: 1,
  };
}

function session(
  label: string,
  runtimeGeneration = 1,
  overrides: Partial<ServerSessionState> = {},
): ServerSessionState {
  return {
    ...emptyServerSessionState(runtimeGeneration),
    workspaces: [
      {
        workspace_id: "same-workspace",
        number: 1,
        label,
        focused: true,
        pane_count: 1,
        tab_count: 1,
        active_tab_id: "same-tab",
        agent_status: "idle",
      },
    ],
    tabs: [
      {
        tab_id: "same-tab",
        workspace_id: "same-workspace",
        number: 1,
        label,
        focused: true,
        pane_count: 1,
        agent_status: "idle",
      },
    ],
    panes: [pane(label, "idle")],
    selectedPaneId: "same-pane",
    recentPaneIds: [`${label}-recent`, "same-pane"],
    pendingFocusWorkspaceId: `${label}-pending`,
    ...overrides,
  };
}

function partitionState(): State {
  const alpha = session("alpha");
  const beta = session("beta");
  return {
    ...alpha,
    status: "connected",
    connectionPaused: false,
    bridgeStatus: null,
    connections: [
      {
        id: "alpha",
        label: "Alpha",
        source: "test",
        is_default: true,
        state: "ready",
        generation: 1,
      },
      {
        id: "beta",
        label: "Beta",
        source: "test",
        is_default: false,
        state: "ready",
        generation: 1,
      },
    ],
    defaultConnectionId: "alpha",
    activeConnectionId: "alpha",
    connectionGeneration: 10,
    sessionsByConnectionId: { alpha, beta },
    notice: null,
    taskNotificationsEnabled: false,
    taskNotificationPreferences: { completed: true, blocked: true },
    taskNotificationTransport: "local",
    taskNotificationBusy: false,
    taskNotificationPermission: "unsupported",
    automaticUpdateChecksEnabled: true,
    updateInfo: null,
    updateInstalling: false,
    pendingRestartVersion: null,
    dismissedUpdateVersion: null,
  };
}

describe("connection-partitioned store state", () => {
  test("keeps the store generation aligned when pausing an already-disconnected bridge", () => {
    const previousLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { setItem: () => undefined },
    });
    try {
      const before = bridge.clientGeneration;
      expect(bridge.status).toBe("disconnected");
      store.pauseConnection();
      expect(bridge.clientGeneration).toBe(before + 1);
      expect(store.get().connectionGeneration).toBe(bridge.clientGeneration);
    } finally {
      if (previousLocalStorage === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: previousLocalStorage,
        });
      }
    }
  });

  test("uses distinct notices for reconnecting and resuming browser sync", () => {
    const previousState = store.get();
    const previousLocalStorage = globalThis.localStorage;
    const originalConnect = bridge.connect;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { setItem: () => undefined },
    });
    bridge.connect = () => undefined;
    try {
      __storeTesting.replaceState({
        ...partitionState(),
        status: "disconnected",
        automaticUpdateChecksEnabled: false,
      });
      store.resumeConnection();
      expect(store.get().notice?.message).toBe("Reconnecting browser");

      __storeTesting.replaceState({
        ...partitionState(),
        status: "disconnected",
        connectionPaused: true,
        automaticUpdateChecksEnabled: false,
      });
      store.resumeConnection();
      expect(store.get().notice?.message).toBe("Resuming browser sync");
    } finally {
      bridge.connect = originalConnect;
      __storeTesting.replaceState(previousState);
      if (previousLocalStorage === undefined) {
        delete (globalThis as { localStorage?: Storage }).localStorage;
      } else {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: previousLocalStorage,
        });
      }
    }
  });

  test("rearms terminal attachment when status polling recovers a failed catalog", async () => {
    const previousState = store.get();
    const originalCall = bridge.call;
    const snapshot = {
      ...partitionState(),
      terminalAttachEpoch: 7,
    };
    bridge.call = (async (method: string) => {
      expect(method).toBe("bridge.status");
      return {
        clients: 2,
        terminals: [],
        connections: snapshot.connections,
        default_connection_id: snapshot.defaultConnectionId,
      };
    }) as typeof bridge.call;
    try {
      __storeTesting.replaceState(snapshot);
      __storeTesting.markTerminalReattachPending();

      await __storeTesting.refreshBridgeStatus();

      expect(store.get().terminalAttachEpoch).toBe(8);
      expect(store.get().bridgeStatus?.clients).toBe(2);
      expect(__storeTesting.rearmTerminalAttachmentsAfterCatalog(true)).toBe(
        false,
      );
    } finally {
      bridge.call = originalCall;
      __storeTesting.replaceState(previousState);
    }
  });

  test("preserves profile DTO fields across transition bridge-status catalogs", () => {
    const previous = [
      {
        ...partitionState().connections[0],
        type: "local" as const,
        read_only: false,
        auto_connect: true,
        control_socket_path: "/tmp/alpha.sock",
        client_socket_path: "/tmp/alpha-client.sock",
      },
    ];
    const merged = mergeConnectionCatalog(previous, [
      {
        id: "alpha",
        label: "Alpha renamed",
        source: "local-profile",
        is_default: true,
        state: "connecting",
        generation: 2,
      },
    ]);
    expect(merged[0]).toMatchObject({
      label: "Alpha renamed",
      state: "connecting",
      generation: 2,
      type: "local",
      read_only: false,
      auto_connect: true,
      control_socket_path: "/tmp/alpha.sock",
      client_socket_path: "/tmp/alpha-client.sock",
    });
  });

  test("preserves SSH profile DTO fields across transition status catalogs", () => {
    const previous = [
      {
        ...partitionState().connections[0],
        source: "ssh-profile",
        type: "ssh" as const,
        read_only: false,
        auto_connect: true,
        ssh_destination: "operator@dev-box",
        remote_control_socket_path: "/remote/herdr.sock",
        remote_client_socket_path: "/remote/herdr-client.sock",
      },
    ];
    const merged = mergeConnectionCatalog(previous, [
      {
        id: "alpha",
        label: "Remote renamed",
        source: "ssh-profile",
        is_default: true,
        state: "connecting",
        generation: 2,
      },
    ]);
    expect(merged[0]).toMatchObject({
      label: "Remote renamed",
      type: "ssh",
      ssh_destination: "operator@dev-box",
      remote_control_socket_path: "/remote/herdr.sock",
      remote_client_socket_path: "/remote/herdr-client.sock",
    });
  });

  test("drops opposite transport fields when a profile changes type", () => {
    const previous = [
      {
        ...partitionState().connections[0],
        type: "local" as const,
        read_only: false,
        auto_connect: false,
        control_socket_path: "/tmp/old-control.sock",
        client_socket_path: "/tmp/old-render.sock",
      },
    ];
    const [changed] = mergeConnectionCatalog(previous, [
      {
        id: "alpha",
        label: "Remote Alpha",
        source: "ssh-profile",
        is_default: true,
        state: "disconnected",
        generation: 2,
        type: "ssh",
        read_only: false,
        auto_connect: false,
        ssh_destination: "operator@dev-box",
        remote_control_socket_path: "/remote/herdr.sock",
        remote_client_socket_path: "/remote/herdr-client.sock",
      },
    ]);
    expect(changed.type).toBe("ssh");
    expect(changed.control_socket_path).toBeUndefined();
    expect(changed.client_socket_path).toBeUndefined();
    expect(changed.ssh_destination).toBe("operator@dev-box");
  });

  test("restores sessions whose server resource IDs deliberately collide", () => {
    const alpha = partitionState();
    const beta = activateConnectionState(alpha, "beta", 11);

    expect(beta.activeConnectionId).toBe("beta");
    expect(beta.workspaces[0]?.label).toBe("beta");
    expect(beta.pendingFocusWorkspaceId).toBe("beta-pending");
    expect(beta.recentPaneIds).toEqual(["beta-recent", "same-pane"]);

    const restoredAlpha = activateConnectionState(beta, "alpha", 12);
    expect(restoredAlpha.workspaces[0]?.label).toBe("alpha");
    expect(restoredAlpha.pendingFocusWorkspaceId).toBe("alpha-pending");
    expect(restoredAlpha.recentPaneIds).toEqual(["alpha-recent", "same-pane"]);
  });

  test("empties active resources on a runtime replacement", () => {
    const snapshot = partitionState();
    const connections = snapshot.connections.map((connection) =>
      connection.id === "alpha" ? { ...connection, generation: 2 } : connection,
    );
    const reconciliation = reconcileConnectionCatalogSessions(
      snapshot,
      connections,
    );

    expect(reconciliation.activeRuntimeChanged).toBe(true);
    expect(reconciliation.activeSession).toMatchObject({
      serverRuntimeGeneration: 2,
      workspaces: [],
      tabs: [],
      panes: [],
      layout: null,
      selectedPaneId: null,
      pendingFocusWorkspaceId: null,
    });
    expect(reconciliation.activeSession?.panes).not.toContainEqual(
      expect.objectContaining({ terminal_id: "same-terminal" }),
    );
  });

  test("falls back to the default when the active profile is removed", () => {
    const originalSetActiveConnection = bridge.setActiveConnection;
    bridge.setActiveConnection = (() =>
      22) as typeof bridge.setActiveConnection;
    try {
      const snapshot = activateConnectionState(partitionState(), "beta", 11);
      __storeTesting.replaceState(snapshot);
      __storeTesting.applyCatalog(
        snapshot.connections.filter((connection) => connection.id === "alpha"),
        "alpha",
      );
      expect(store.get().activeConnectionId).toBe("alpha");
      expect(store.get().connectionGeneration).toBe(22);
      expect(store.get().workspaces[0]?.label).toBe("alpha");
    } finally {
      bridge.setActiveConnection = originalSetActiveConnection;
      __storeTesting.replaceState(partitionState());
    }
  });

  test("publishes an empty active session before replacement refresh", () => {
    const originalAdvanceGeneration = bridge.advanceActiveConnectionGeneration;
    bridge.advanceActiveConnectionGeneration = (() =>
      99) as typeof bridge.advanceActiveConnectionGeneration;
    try {
      const snapshot = partitionState();
      __storeTesting.replaceState(snapshot);
      __storeTesting.applyCatalog(
        snapshot.connections.map((connection) =>
          connection.id === "alpha"
            ? { ...connection, generation: 2 }
            : connection,
        ),
        "alpha",
      );
      expect(store.get()).toMatchObject({
        activeConnectionId: "alpha",
        connectionGeneration: 99,
        serverRuntimeGeneration: 2,
        workspaces: [],
        tabs: [],
        panes: [],
        layout: null,
        selectedPaneId: null,
      });
    } finally {
      bridge.advanceActiveConnectionGeneration = originalAdvanceGeneration;
      __storeTesting.replaceState(partitionState());
    }
  });

  test("invalidates an inactive replacement before it can be restored", () => {
    const snapshot = partitionState();
    const connections = snapshot.connections.map((connection) =>
      connection.id === "beta" ? { ...connection, generation: 2 } : connection,
    );
    const reconciliation = reconcileConnectionCatalogSessions(
      snapshot,
      connections,
    );
    const reconciled: State = {
      ...snapshot,
      ...(reconciliation.activeSession ?? {}),
      connections,
      sessionsByConnectionId: reconciliation.sessionsByConnectionId,
    };
    const beta = activateConnectionState(reconciled, "beta", 11);

    expect(beta.serverRuntimeGeneration).toBe(2);
    expect(beta.workspaces).toEqual([]);
    expect(beta.tabs).toEqual([]);
    expect(beta.panes).toEqual([]);
    expect(beta.selectedPaneId).toBeNull();
    expect(beta.sessionsByConnectionId.beta?.panes).toEqual([]);
  });

  test("drives real refresh and action paths without stale publication after a switch", async () => {
    const originalConnection = bridge.connection;
    const originalSetActiveConnection = bridge.setActiveConnection;
    let activeConnectionId = "alpha";
    let browserGeneration = 10;
    let mode: "refresh" | "action" = "refresh";
    let startedRefreshCalls = 0;
    let signalRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    let resolveWorkspaces!: (value: unknown) => void;
    let resolveTabs!: (value: unknown) => void;
    let resolvePanes!: (value: unknown) => void;
    let resolveAction!: (value: unknown) => void;
    const workspaceResult = new Promise((resolve) => {
      resolveWorkspaces = resolve;
    });
    const tabResult = new Promise((resolve) => {
      resolveTabs = resolve;
    });
    const paneResult = new Promise((resolve) => {
      resolvePanes = resolve;
    });
    const actionResult = new Promise((resolve) => {
      resolveAction = resolve;
    });
    const callsFor = ((method: string) => {
      if (mode === "action") return actionResult;
      startedRefreshCalls += 1;
      if (startedRefreshCalls === 3) signalRefreshStarted();
      if (method === "workspace.list") return workspaceResult;
      if (method === "tab.list") return tabResult;
      if (method === "pane.list") return paneResult;
      return Promise.reject(new Error(`unexpected method: ${method}`));
    }) as ConnectionClient["call"];

    bridge.connection = ((
      connectionId = activeConnectionId,
      serverRuntimeGeneration: number | null = 1,
    ) => {
      const generation = browserGeneration;
      return {
        connectionId,
        generation,
        serverRuntimeGeneration,
        call: callsFor,
        isCurrent: () =>
          activeConnectionId === connectionId &&
          browserGeneration === generation,
        acceptsServerGeneration: (value: unknown) =>
          value === serverRuntimeGeneration,
      };
    }) as typeof bridge.connection;
    bridge.setActiveConnection = ((connectionId: string) => {
      if (connectionId !== activeConnectionId) {
        activeConnectionId = connectionId;
        browserGeneration += 1;
      }
      return browserGeneration;
    }) as typeof bridge.setActiveConnection;

    try {
      __storeTesting.replaceState(partitionState());
      const refresh = store.refresh();
      await refreshStarted;
      expect(store.selectConnection("beta")).toBe(true);
      resolveWorkspaces({ workspaces: session("stale-refresh").workspaces });
      resolveTabs({ tabs: session("stale-refresh").tabs });
      resolvePanes({ panes: session("stale-refresh").panes });
      await refresh;
      expect(store.get().activeConnectionId).toBe("beta");
      expect(store.get().workspaces[0]?.label).toBe("beta");
      expect(store.get().error).toBeNull();
      expect(store.get().notice).toBeNull();

      activeConnectionId = "alpha";
      browserGeneration = 20;
      mode = "action";
      __storeTesting.replaceState({
        ...partitionState(),
        connectionGeneration: browserGeneration,
      });
      const action = store.createWorkspace("stale-action");
      expect(store.selectConnection("beta")).toBe(true);
      resolveAction({ workspace: { workspace_id: "same-workspace" } });
      await action;
      expect(store.get().activeConnectionId).toBe("beta");
      expect(store.get().workspaces[0]?.label).toBe("beta");
      expect(store.get().error).toBeNull();
      expect(store.get().notice).toBeNull();
    } finally {
      bridge.connection = originalConnection;
      bridge.setActiveConnection = originalSetActiveConnection;
      __storeTesting.replaceState(partitionState());
    }
  });

  test("filters inactive events and keeps task transitions partitioned", () => {
    const snapshot = activateConnectionState(partitionState(), "beta", 11);
    expect(connectionEventIsActive(snapshot, "alpha")).toBe(false);
    expect(connectionEventIsActive(snapshot, "beta")).toBe(true);
    expect(connectionEventIsActive(snapshot, "beta", 0, true)).toBe(false);
    expect(connectionEventIsActive(snapshot, "beta", 1, true)).toBe(true);

    const tracker = new TaskCompletionTracker();
    expect(tracker.update("alpha", [pane("alpha", "working")])).toEqual([]);
    expect(tracker.update("beta", [pane("beta", "done")])).toEqual([]);
    expect(tracker.update("alpha", [pane("alpha", "done")])).toEqual([
      pane("alpha", "done"),
    ]);
    expect(tracker.update("beta", [pane("beta", "working")])).toEqual([]);
    expect(tracker.update("beta", [pane("beta", "idle")])).toEqual([
      pane("beta", "idle"),
    ]);
    tracker.reset("alpha");
    expect(tracker.update("alpha", [pane("alpha", "done")])).toEqual([]);
  });

  test("carries runtime identity in browser and toast activation targets", () => {
    const target = {
      connectionId: "alpha",
      runtimeGeneration: 1,
      workspaceId: "same-workspace",
      paneId: "same-pane",
    };
    expect(taskNotificationTarget("alpha", 1, pane("alpha", "done"))).toEqual(
      target,
    );
    expect(
      taskNotificationTargetFromNotice({
        actionConnectionId: "alpha",
        actionRuntimeGeneration: 1,
        actionWorkspaceId: "same-workspace",
        actionPaneId: "same-pane",
      }),
    ).toEqual(target);
    expect(
      taskNotificationTargetFromNotice({
        actionConnectionId: "alpha",
        actionWorkspaceId: "same-workspace",
        actionPaneId: "same-pane",
      }),
    ).toBeNull();
    expect(taskNotificationTargetIsCurrent(partitionState(), target)).toBe(
      true,
    );
    expect(
      taskNotificationTargetIsCurrent(
        {
          connections: partitionState().connections.map((connection) =>
            connection.id === "alpha"
              ? { ...connection, generation: 2 }
              : connection,
          ),
        },
        target,
      ),
    ).toBe(false);
    expect(taskNotificationTag(target)).not.toBe(
      taskNotificationTag({
        ...target,
        connectionId: "alpha-1",
        paneId: "same-pane",
      }),
    );
    expect(taskNotificationTag(target)).not.toBe(
      taskNotificationTag({ ...target, runtimeGeneration: 2 }),
    );
  });

  test("opens unchanged-generation notifications but rejects replaced targets", async () => {
    const originalConnection = bridge.connection;
    const originalSetActiveConnection = bridge.setActiveConnection;
    let activeConnectionId = "beta";
    let browserGeneration = 11;
    const calls: string[] = [];
    bridge.connection = ((connectionId = activeConnectionId) => {
      const generation = browserGeneration;
      return {
        connectionId,
        generation,
        isCurrent: () =>
          activeConnectionId === connectionId &&
          browserGeneration === generation,
        call: (async (method: string) => {
          calls.push(`${connectionId}:${method}`);
          if (method === "pane.get") return { pane: pane("alpha", "idle") };
          return {};
        }) as ConnectionClient["call"],
      };
    }) as typeof bridge.connection;
    bridge.setActiveConnection = ((connectionId: string) => {
      if (connectionId !== activeConnectionId) {
        activeConnectionId = connectionId;
        browserGeneration += 1;
      }
      return browserGeneration;
    }) as typeof bridge.setActiveConnection;

    const target = taskNotificationTarget("alpha", 1, pane("alpha", "done"));
    try {
      __storeTesting.replaceState({
        ...activateConnectionState(partitionState(), "beta", 11),
        status: "disconnected",
      });
      await store.focusTaskNotificationTarget(target);
      expect(store.get().activeConnectionId).toBe("alpha");
      expect(calls).toEqual([
        "alpha:pane.get",
        "alpha:workspace.focus",
        "alpha:tab.focus",
      ]);

      calls.length = 0;
      activeConnectionId = "beta";
      browserGeneration = 20;
      const beta = activateConnectionState(partitionState(), "beta", 20);
      __storeTesting.replaceState({
        ...beta,
        status: "disconnected",
        connections: beta.connections.map((connection) =>
          connection.id === "alpha"
            ? { ...connection, generation: 2 }
            : connection,
        ),
      });
      await store.focusTaskNotificationTarget(target);
      expect(store.get().activeConnectionId).toBe("beta");
      expect(calls).toEqual([]);
    } finally {
      bridge.connection = originalConnection;
      bridge.setActiveConnection = originalSetActiveConnection;
      __storeTesting.replaceState(partitionState());
    }
  });
});

describe("stabilizeRefreshPatch", () => {
  test("returns null when a refresh reproduces the current state", () => {
    const snapshot = partitionState();
    expect(
      stabilizeRefreshPatch(snapshot, {
        workspaces: structuredClone(snapshot.workspaces),
        tabs: structuredClone(snapshot.tabs),
        panes: structuredClone(snapshot.panes),
        layout: structuredClone(snapshot.layout),
        error: null,
        lastRefresh: Date.now(),
      }),
    ).toBeNull();
  });

  test("keeps unchanged slice references and adopts changed ones", () => {
    const snapshot = partitionState();
    const panes = [pane("alpha", "working")];
    const patch = stabilizeRefreshPatch(snapshot, {
      workspaces: structuredClone(snapshot.workspaces),
      tabs: structuredClone(snapshot.tabs),
      panes,
      layout: null,
      error: null,
      lastRefresh: 123,
    });

    expect(patch?.workspaces).toBe(snapshot.workspaces);
    expect(patch?.tabs).toBe(snapshot.tabs);
    expect(patch?.layout).toBe(snapshot.layout);
    expect(patch?.panes).toBe(panes);
    expect(patch?.lastRefresh).toBe(123);
    expect(patch).not.toHaveProperty("error");
  });

  test("publishes scalar-only transitions like selection or error moves", () => {
    const snapshot = partitionState();
    const cleared = stabilizeRefreshPatch(snapshot, {
      selectedPaneId: null,
      error: null,
      lastRefresh: 5,
    });
    expect(cleared).toMatchObject({ selectedPaneId: null, lastRefresh: 5 });

    const failed = stabilizeRefreshPatch(snapshot, {
      error: "boom",
      lastRefresh: 6,
    });
    expect(failed).toMatchObject({ error: "boom", lastRefresh: 6 });
    expect(failed).not.toHaveProperty("selectedPaneId");
  });

  test("returns null when scalar values already match", () => {
    const snapshot = partitionState();
    expect(
      stabilizeRefreshPatch(snapshot, {
        selectedPaneId: snapshot.selectedPaneId,
        error: snapshot.error,
        lastRefresh: Date.now(),
      }),
    ).toBeNull();
  });

  test("keeps the store silent when an idle refresh changes nothing", async () => {
    const originalConnection = bridge.connection;
    const snapshot = partitionState();
    bridge.connection = (() => ({
      connectionId: "alpha",
      generation: 10,
      isCurrent: () => true,
      call: (async (method: string) => {
        if (method === "workspace.list") {
          return { workspaces: structuredClone(snapshot.workspaces) };
        }
        if (method === "tab.list") {
          return { tabs: structuredClone(snapshot.tabs) };
        }
        if (method === "pane.list") {
          return { panes: structuredClone(snapshot.panes) };
        }
        if (method === "pane.layout") return { layout: null };
        return {};
      }) as ConnectionClient["call"],
    })) as typeof bridge.connection;
    try {
      __storeTesting.replaceState(snapshot);
      let emissions = 0;
      const unsubscribe = store.subscribe(() => {
        emissions += 1;
      });
      try {
        const before = store.get();
        await store.refresh();
        expect(store.get()).toBe(before);
        expect(emissions).toBe(0);
      } finally {
        unsubscribe();
      }
    } finally {
      bridge.connection = originalConnection;
      __storeTesting.replaceState(partitionState());
    }
  });
});

describe("worktree hook notices", () => {
  test("dismisses successful hook output after a short actionable window", () => {
    expect(
      summarizeDirectHookResult({
        event: "worktree.created",
        status: "succeeded",
        stdout: "configured checkout",
      }),
    ).toMatchObject({
      kind: "success",
      autoDismissMs: 15_000,
    });
  });

  test("leaves failed hooks on the shared default timeout", () => {
    const notice = summarizeDirectHookResult({
      event: "worktree.before_remove",
      status: "failed",
      exit_code: 1,
      stderr: "cleanup failed",
    });
    expect(notice).toMatchObject({ kind: "error" });
    expect(notice?.autoDismissMs).toBeUndefined();
  });
});

describe("notice dismissal policy", () => {
  test("uses 15 seconds for an ordinary toast", () => {
    expect(DEFAULT_NOTICE_AUTO_DISMISS_MS).toBe(15_000);
    expect(noticeAutoDismissDelay({ kind: "info", message: "Saved" })).toBe(
      15_000,
    );
  });

  test("honors explicit durations and keeps loading notices visible", () => {
    expect(
      noticeAutoDismissDelay({
        kind: "success",
        message: "Copied",
        autoDismissMs: 5_000,
      }),
    ).toBe(5_000);
    expect(
      noticeAutoDismissDelay({
        kind: "info",
        message: "Working",
        loading: true,
      }),
    ).toBeNull();
  });
});

describe("recent pane history", () => {
  const panes = Array.from({ length: 14 }, (_, index) => ({
    pane_id: `pane-${index + 1}`,
  }));

  test("moves the selected pane to the front without duplicates", () => {
    expect(
      nextRecentPaneIds("pane-2", ["pane-1", "pane-2", "pane-3"], panes),
    ).toEqual(["pane-2", "pane-1", "pane-3"]);
  });

  test("prunes missing panes and keeps the history bounded", () => {
    expect(
      nextRecentPaneIds(
        "pane-14",
        ["missing", ...panes.map((pane) => pane.pane_id)],
        panes,
      ),
    ).toEqual([
      "pane-14",
      "pane-1",
      "pane-2",
      "pane-3",
      "pane-4",
      "pane-5",
      "pane-6",
      "pane-7",
      "pane-8",
      "pane-9",
      "pane-10",
      "pane-11",
    ]);
  });

  test("does not add a pane that is no longer live", () => {
    expect(nextRecentPaneIds("missing", ["pane-1", "missing"], panes)).toEqual([
      "pane-1",
    ]);
  });
});

describe("update restart verification", () => {
  test("matches only the expected running server version", () => {
    expect(healthMatchesUpdateVersion({ version: "0.3.0" }, "0.3.0")).toBe(
      true,
    );
    expect(healthMatchesUpdateVersion({ version: "0.2.9" }, "0.3.0")).toBe(
      false,
    );
    expect(healthMatchesUpdateVersion({ ok: true }, "0.3.0")).toBe(false);
  });
});

describe("numbered tab creation", () => {
  test("uses the authoritative number returned by Herdr", () => {
    expect(
      numberedCreatedTabRename({
        type: "tab_created",
        tab: { tab_id: "w1:t7", number: 7, label: "7" },
      }),
    ).toEqual({ tabId: "w1:t7", label: "Tab 7" });
  });

  test("rejects malformed or unrelated responses", () => {
    expect(numberedCreatedTabRename(null)).toBeNull();
    expect(
      numberedCreatedTabRename({
        type: "tab_info",
        tab: { tab_id: "w1:t2", number: 2 },
      }),
    ).toBeNull();
    expect(
      numberedCreatedTabRename({
        type: "tab_created",
        tab: { tab_id: "w1:t2" },
      }),
    ).toBeNull();
    expect(
      numberedCreatedTabRename({
        type: "tab_created",
        tab: { tab_id: "w1:t2", number: 0 },
      }),
    ).toBeNull();
  });
});

describe("worktree removal notices", () => {
  test("keeps a removed-hook failure visible after stale checkout recovery", () => {
    expect(
      worktreeRemovalCompletionNotice(
        {
          recovered_stale_checkout: true,
          terminated_processes: 2,
          preserved_path: "/work/repo.recovered",
        },
        {
          kind: "error",
          message: "Worktree removed hook failed (exit 1)",
          detail: "cleanup failed",
          detailMode: "output",
          detailTitle: "Worktree removed hook output",
        },
      ),
    ).toEqual({
      kind: "error",
      message: "Worktree removed hook failed (exit 1)",
      detail:
        "cleanup failed\nStopped 2 processes still using the checkout.\nStale files were preserved at /work/repo.recovered.",
      detailMode: "output",
      detailTitle: "Worktree removal details",
    });
  });

  test("summarizes recovery when no removed hook ran", () => {
    expect(
      worktreeRemovalCompletionNotice(
        {
          recovered_stale_checkout: true,
          terminated_processes: 0,
        },
        null,
      ),
    ).toEqual({
      kind: "success",
      message: "Worktree removed",
      detail:
        "The checkout was already absent; stale Herdr state was reconciled.",
    });
  });

  test("reports a successful Herdr remove with incomplete local cleanup", () => {
    expect(
      worktreeRemovalCompletionNotice(
        {
          terminated_processes: 0,
          warning: "process 42 survived",
        },
        {
          kind: "success",
          message: "Worktree removed hook completed",
        },
      ),
    ).toEqual({
      kind: "error",
      message: "Worktree removed with cleanup warning",
      detail: "Worktree removed hook completed\nprocess 42 survived",
      detailTitle: "Worktree removal details",
    });
  });
});

describe("pending workspace focus settlement", () => {
  function mockFocusConnection(workspacesFocused: () => unknown[]) {
    const originalConnection = bridge.connection;
    const focusDeferreds: Array<{
      resolve: (value: unknown) => void;
      promise: Promise<unknown>;
    }> = [];
    bridge.connection = ((connectionId = "alpha", generation = 10) => ({
      connectionId,
      generation,
      isCurrent: () => true,
      call: (async (method: string) => {
        if (method === "workspace.focus") {
          const deferred = Promise.withResolvers<unknown>();
          focusDeferreds.push(deferred);
          return deferred.promise;
        }
        if (method === "workspace.list") {
          return { workspaces: workspacesFocused() };
        }
        if (method === "tab.list") return { tabs: [] };
        if (method === "pane.list") return { panes: [] };
        if (method === "pane.layout") return { layout: null };
        return {};
      }) as ConnectionClient["call"],
    })) as typeof bridge.connection;
    return {
      focusDeferreds,
      async resolveFocus(index: number, value: unknown = {}) {
        while (!focusDeferreds[index]) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        focusDeferreds[index].resolve(value);
      },
      restore() {
        bridge.connection = originalConnection;
      },
    };
  }

  function unfocusedWorkspaces(): unknown[] {
    return structuredClone(partitionState().workspaces);
  }

  test("releases a settled pending focus that a fresh observation still misses", async () => {
    const mock = mockFocusConnection(unfocusedWorkspaces);
    try {
      __storeTesting.replaceState(partitionState());
      const action = store.focusWorkspace("other-workspace");
      await mock.resolveFocus(0);
      await action;
      await store.refresh();
      await store.refresh();
      expect(store.get().pendingFocusWorkspaceId).toBeNull();
      expect(store.get().pendingFocusWorkspaceSettledAt).toBeNull();
    } finally {
      mock.restore();
      __storeTesting.replaceState(partitionState());
    }
  });

  test("keeps an unsettled pending focus across mid-flight refreshes", async () => {
    const mock = mockFocusConnection(unfocusedWorkspaces);
    try {
      __storeTesting.replaceState(partitionState());
      const action = store.focusWorkspace("other-workspace");
      await store.refresh();
      expect(store.get().pendingFocusWorkspaceId).toBe("other-workspace");
      expect(store.get().pendingFocusWorkspaceSettledAt).toBeNull();
      await mock.resolveFocus(0);
      await action;
      await store.refresh();
      await store.refresh();
      expect(store.get().pendingFocusWorkspaceId).toBeNull();
    } finally {
      mock.restore();
      __storeTesting.replaceState(partitionState());
    }
  });

  test("never lets a first same-id attempt settle or clear the second", async () => {
    const mock = mockFocusConnection(unfocusedWorkspaces);
    try {
      __storeTesting.replaceState(partitionState());
      const first = store.focusWorkspace("other-workspace");
      const second = store.focusWorkspace("other-workspace");
      await mock.resolveFocus(0);
      await first;
      expect(store.get().pendingFocusWorkspaceId).toBe("other-workspace");
      expect(store.get().pendingFocusWorkspaceSettledAt).toBeNull();
      await store.refresh();
      expect(store.get().pendingFocusWorkspaceId).toBe("other-workspace");
      await mock.resolveFocus(1);
      await second;
      await store.refresh();
      await store.refresh();
      expect(store.get().pendingFocusWorkspaceId).toBeNull();
    } finally {
      mock.restore();
      __storeTesting.replaceState(partitionState());
    }
  });

  test("clears the pending focus as soon as the workspace is observed focused", async () => {
    const mock = mockFocusConnection(() => [
      { ...partitionState().workspaces[0], focused: false },
      {
        ...partitionState().workspaces[0],
        workspace_id: "other-workspace",
        focused: true,
      },
    ]);
    try {
      __storeTesting.replaceState(partitionState());
      const action = store.focusWorkspace("other-workspace");
      await mock.resolveFocus(0);
      await action;
      await store.refresh();
      await store.refresh();
      expect(store.get().pendingFocusWorkspaceId).toBeNull();
    } finally {
      mock.restore();
      __storeTesting.replaceState(partitionState());
    }
  });

  for (const observedFocused of [false, true]) {
    for (const sameWorkspace of [false, true]) {
      test(`layout publication preserves a newer ${sameWorkspace ? "same-id" : "different-id"} focus after a ${observedFocused ? "positive" : "negative"} observation`, async () => {
        const originalConnection = bridge.connection;
        const layoutEntered = Promise.withResolvers<void>();
        const layoutResult = Promise.withResolvers<unknown>();
        const focusResult = Promise.withResolvers<unknown>();
        const snapshot = partitionState();
        const oldTarget = observedFocused ? "same-workspace" : "old-target";
        const newTarget = sameWorkspace ? oldTarget : "new-target";
        const workspaces = snapshot.workspaces.map((workspace) => ({
          ...workspace,
          label: "fresh observation",
        }));
        let focus: Promise<unknown> | undefined;
        let refresh: Promise<unknown> | undefined;
        bridge.connection = ((connectionId = "alpha", generation = 10) => ({
          connectionId,
          generation,
          isCurrent: () => true,
          call: (async (method: string) => {
            if (method === "workspace.list") return { workspaces };
            if (method === "tab.list") return { tabs: snapshot.tabs };
            if (method === "pane.list") return { panes: snapshot.panes };
            if (method === "pane.layout") {
              layoutEntered.resolve();
              return layoutResult.promise;
            }
            if (method === "workspace.focus") return focusResult.promise;
            return {};
          }) as ConnectionClient["call"],
        })) as typeof bridge.connection;
        try {
          __storeTesting.replaceState({
            ...snapshot,
            pendingFocusWorkspaceId: oldTarget,
            pendingFocusWorkspaceSeq: -1,
            pendingFocusWorkspaceSettledAt: 1,
          });
          refresh = store.refresh();
          await layoutEntered.promise;
          focus = store.focusWorkspace(newTarget);
          const newSeq = store.get().pendingFocusWorkspaceSeq;
          expect(newSeq).not.toBe(-1);
          layoutResult.resolve({ layout: null });
          await refresh;
          expect(store.get().pendingFocusWorkspaceId).toBe(newTarget);
          expect(store.get().pendingFocusWorkspaceSeq).toBe(newSeq);
          expect(store.get().pendingFocusWorkspaceSettledAt).toBeNull();
          expect(store.get().workspaces).toEqual(workspaces);
        } finally {
          layoutResult.resolve({ layout: null });
          focusResult.resolve({});
          await refresh;
          await focus;
          await store.refresh();
          bridge.connection = originalConnection;
          __storeTesting.replaceState(partitionState());
        }
      });
    }
  }

  test("restores pending focus deterministically and preserves settled tokens", () => {
    for (const settledAt of [null, 0, 123]) {
      const withPending: State = {
        ...partitionState(),
        lastRefresh: 42,
        pendingFocusWorkspaceId: "alpha-pending",
        pendingFocusWorkspaceSeq: 7,
        pendingFocusWorkspaceSettledAt: settledAt,
      };
      const beta = activateConnectionState(withPending, "beta", 11);
      const restored = activateConnectionState(beta, "alpha", 12);
      expect(restored.pendingFocusWorkspaceId).toBe("alpha-pending");
      expect(restored.pendingFocusWorkspaceSettledAt).toBe(settledAt ?? 42);
      expect(activateConnectionState(beta, "alpha", 12)).toEqual(restored);
    }
  });

  test("clears a failed focus attempt even when the lease is already dead", async () => {
    const originalConnection = bridge.connection;
    bridge.connection = ((connectionId = "alpha", generation = 10) => ({
      connectionId,
      generation,
      isCurrent: () => false,
      call: (async (method: string) => {
        if (method === "workspace.focus") {
          throw new Error("socket gone");
        }
        return {};
      }) as ConnectionClient["call"],
    })) as typeof bridge.connection;
    try {
      __storeTesting.replaceState(partitionState());
      await store.focusWorkspace("other-workspace");
      expect(store.get().pendingFocusWorkspaceId).toBeNull();
      expect(store.get().pendingFocusWorkspaceSettledAt).toBeNull();
    } finally {
      bridge.connection = originalConnection;
      __storeTesting.replaceState(partitionState());
    }
  });

  test("releases a stamped marker when the connection is paused", async () => {
    const originalConnection = bridge.connection;
    bridge.connection = ((connectionId = "alpha", generation = 10) => ({
      connectionId,
      generation,
      isCurrent: () => true,
      call: (async () => ({})) as ConnectionClient["call"],
    })) as typeof bridge.connection;
    try {
      __storeTesting.replaceState({
        ...partitionState(),
        connectionPaused: true,
      });
      await store.focusWorkspace("other-workspace");
      expect(store.get().pendingFocusWorkspaceId).toBeNull();
      expect(store.get().pendingFocusWorkspaceSettledAt).toBeNull();
    } finally {
      bridge.connection = originalConnection;
      __storeTesting.replaceState(partitionState());
    }
  });

  test("marks a completed focus attempt settled even when the lease is dead", async () => {
    const originalConnection = bridge.connection;
    bridge.connection = ((connectionId = "alpha", generation = 10) => ({
      connectionId,
      generation,
      isCurrent: () => false,
      call: (async () => ({})) as ConnectionClient["call"],
    })) as typeof bridge.connection;
    try {
      __storeTesting.replaceState(partitionState());
      await store.focusWorkspace("other-workspace");
      expect(store.get().pendingFocusWorkspaceId).toBe("other-workspace");
      expect(store.get().pendingFocusWorkspaceSettledAt).not.toBeNull();
    } finally {
      bridge.connection = originalConnection;
      __storeTesting.replaceState(partitionState());
    }
  });
});

describe("basic Herdr 0.9 compatibility", () => {
  test("safe workspace close reports grouped-close refusal without closing the group", async () => {
    const previousState = store.get();
    const originalConnection = bridge.connection;
    const calls: unknown[] = [];
    bridge.connection = (() => ({
      connectionId: "alpha",
      generation: 10,
      isCurrent: () => true,
      call: (async (method, params) => {
        calls.push({ method, params });
        throw new Error(
          "workspace_group_close_required: workspace has linked worktrees",
        );
      }) as ConnectionClient["call"],
    })) as typeof bridge.connection;
    try {
      __storeTesting.replaceState(partitionState());
      await store.closeWorkspace("workspace_1");
      expect(calls).toEqual([
        { method: "workspace.close", params: { workspace_id: "workspace_1" } },
      ]);
      expect(store.get().notice).toMatchObject({
        kind: "error",
        message: "Workspace belongs to a group",
        detail: expect.stringContaining("Herdr CLI with --group"),
      });
      expect(store.get().workspaces).toEqual(partitionState().workspaces);
    } finally {
      bridge.connection = originalConnection;
      __storeTesting.replaceState(previousState);
    }
  });

  for (const event of ["layout_updated", "session.resync_required"]) {
    test(`${event} uses generic refresh and queues reconciliation during an in-flight snapshot`, async () => {
      const previousState = store.get();
      const originalConnection = bridge.connection;
      const snapshot = partitionState();
      const refreshedWorkspaces = snapshot.workspaces.map((workspace) => ({
        ...workspace,
        label: "after-layout-event",
      }));
      let lists = 0;
      let published!: () => void;
      let publicationTimer!: ReturnType<typeof setTimeout>;
      const publication = new Promise<void>((resolve, reject) => {
        published = resolve;
        publicationTimer = setTimeout(
          () => reject(new Error("follow-up snapshot was not published")),
          2_000,
        );
      });
      const unsubscribe = store.subscribe(() => {
        if (store.get().workspaces[0]?.label === "after-layout-event") {
          published();
        }
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      bridge.connection = (() => ({
        connectionId: "alpha",
        generation: 10,
        isCurrent: () => true,
        call: (async (method) => {
          if (method === "workspace.list") {
            lists += 1;
            if (lists === 1) await gate;
            return {
              workspaces:
                lists === 1 ? snapshot.workspaces : refreshedWorkspaces,
            };
          }
          if (method === "tab.list") return { tabs: snapshot.tabs };
          if (method === "pane.list") return { panes: snapshot.panes };
          if (method === "pane.layout") return { layout: null };
          return {};
        }) as ConnectionClient["call"],
      })) as typeof bridge.connection;
      try {
        __storeTesting.replaceState(snapshot);
        const refreshing = store.refresh();
        __storeTesting.handleHerdrEvent({
          event,
          connection_id: "alpha",
          connection_generation: 1,
          data: {},
        });
        await Bun.sleep(100); // The production 80ms event debounce fires while busy.
        expect(lists).toBe(1);
        release();
        await refreshing;
        await publication;
        expect(lists).toBe(2); // No five-second metadata poll needed.
      } finally {
        clearTimeout(publicationTimer);
        unsubscribe();
        release();
        bridge.connection = originalConnection;
        __storeTesting.replaceState(previousState);
      }
    });
  }
});

describe("agent activity refresh", () => {
  test("reloads server recency and tolerates unavailable agent metadata", async () => {
    const originalConnection = bridge.connection;
    const snapshot = partitionState();
    let sequence = 42;
    let activity = 1234;
    let unavailable = false;
    bridge.connection = (() => ({
      connectionId: "alpha",
      generation: 10,
      isCurrent: () => true,
      call: (async (method) => {
        if (method === "workspace.list")
          return { workspaces: structuredClone(snapshot.workspaces) };
        if (method === "tab.list")
          return { tabs: structuredClone(snapshot.tabs) };
        if (method === "pane.list")
          return { panes: structuredClone(snapshot.panes) };
        if (method === "agent.list") {
          if (unavailable) throw new Error("Unsupported method");
          return {
            agents: snapshot.panes.map((pane) => ({
              ...pane,
              state_change_seq: sequence,
              last_activity_at: activity,
            })),
          };
        }
        if (method === "pane.layout") return { layout: null };
        return {};
      }) as ConnectionClient["call"],
    })) as typeof bridge.connection;
    try {
      __storeTesting.replaceState(snapshot);
      await store.refresh();
      expect(store.get().panes[0]?.state_change_seq).toBe(42);
      expect(store.get().panes[0]?.last_activity_at).toBe(1234);
      __storeTesting.replaceState(snapshot); // Fresh browser snapshot has no activity history.
      await store.refresh();
      expect(store.get().panes[0]?.state_change_seq).toBe(42);
      expect(store.get().panes[0]?.last_activity_at).toBe(1234);
      sequence = 2; // Herdr restarted: accept its new sequence rather than a cached maximum.
      await store.refresh();
      expect(store.get().panes[0]?.state_change_seq).toBe(2);
      expect(store.get().panes[0]?.last_activity_at).toBe(1234);
      activity = 2345;
      await store.refresh();
      expect(store.get().panes[0]?.last_activity_at).toBe(2345);
      unavailable = true;
      await store.refresh();
      expect(store.get().error).toBeNull();
      expect(store.get().panes).toEqual(snapshot.panes);
    } finally {
      bridge.connection = originalConnection;
      __storeTesting.replaceState(partitionState());
    }
  });
});
