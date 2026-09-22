import { describe, expect, spyOn, test } from "bun:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalView } from "./components/TerminalView";
import { terminalThemeFor } from "./terminalThemes";
import {
  browserPaneInDirection,
  emptyBrowserNavigation,
  projectBrowserLayout,
  projectBrowserNavigation,
  selectBrowserTarget,
} from "./browserNavigation";
import type { Pane, PaneLayout, Tab, Workspace } from "./types";
import type { EndpointAvailability } from "./endpointAvailability";

function navigationTopology() {
  const workspaces: Workspace[] = ["a", "b"].map((id, i) => ({
    workspace_id: id,
    number: i + 1,
    label: id,
    focused: id === "a",
    pane_count: 3,
    tab_count: 2,
    active_tab_id: `${id}1`,
    agent_status: "idle",
    cwd: `/tmp/${id}`,
  }));
  const tabs: Tab[] = ["a1", "a2", "b1"].map((id, i) => ({
    tab_id: id,
    workspace_id: id[0],
    number: i + 1,
    label: id,
    focused: id === "a1",
    pane_count: 2,
    agent_status: "idle",
  }));
  const panes: Pane[] = ["a1p", "a1q", "a2p", "b1p"].map((id) => ({
    pane_id: id,
    terminal_id: `${id}-terminal`,
    workspace_id: id[0],
    tab_id: id.slice(0, 2),
    focused: id === "a1p",
    agent_status: "idle",
    revision: 1,
    cwd: `/tmp/${id}`,
    foreground_cwd: `/tmp/${id}-foreground`,
  }));
  return { workspaces, tabs, panes };
}

function navigationLayout(pane: Pane, panes: Pane[]): PaneLayout {
  return {
    workspace_id: pane.workspace_id,
    tab_id: pane.tab_id,
    zoomed: false,
    area: { x: 0, y: 0, width: 100, height: 30 },
    focused_pane_id: pane.pane_id,
    panes: panes
      .filter((p) => p.tab_id === pane.tab_id)
      .map((p, i) => ({
        pane_id: p.pane_id,
        focused: i === 0,
        rect: { x: i * 50, y: 0, width: 50, height: 30 },
      })),
    splits: [],
  };
}

describe("browser navigation projection", () => {
  test("reproduces shared snapshot clobber but isolates two browser selections", () => {
    const { workspaces, tabs, panes } = navigationTopology();
    const a = selectBrowserTarget(emptyBrowserNavigation(), "a", "a2", "a2p");
    const b = selectBrowserTarget(emptyBrowserNavigation(), "b", "b1", "b1p");
    const native = JSON.stringify({ workspaces, tabs, panes });
    // The old refresh published shared focus a/a1 for both browsers.
    expect(workspaces.find((w) => w.focused)?.active_tab_id).toBe("a1");
    const projectedA = projectBrowserNavigation(a, workspaces, tabs, panes);
    const projectedB = projectBrowserNavigation(b, workspaces, tabs, panes);
    expect(projectedA.selectedPaneId).toBe("a2p");
    expect(projectedB.selectedPaneId).toBe("b1p");
    expect(JSON.stringify({ workspaces, tabs, panes })).toBe(native);
    workspaces[0].focused = false;
    workspaces[1].focused = true;
    expect(
      projectBrowserNavigation(
        projectedA.browserNavigation,
        workspaces,
        tabs,
        panes,
      ).selectedPaneId,
    ).toBe("a2p");
  });

  test("closed and moved panes stay within the selected tab; missing tabs/workspaces fall back", () => {
    const { workspaces, tabs, panes } = navigationTopology();
    const selected = selectBrowserTarget(
      emptyBrowserNavigation(),
      "a",
      "a1",
      "a1q",
    );
    const moved = panes.map((p) =>
      p.pane_id === "a1q" ? { ...p, workspace_id: "b", tab_id: "b1" } : p,
    );
    const projection = projectBrowserNavigation(
      selected,
      workspaces,
      tabs,
      moved,
    );
    expect(projection.selectedPaneId).toBe("a1p");
    expect(projection.browserNavigation.paneIds.a1).toBe("a1p");
    expect(
      projectBrowserNavigation(
        selected,
        workspaces,
        tabs,
        panes.filter((p) => p.pane_id !== "a1q"),
      ).selectedPaneId,
    ).toBe("a1p");
    expect(
      projectBrowserNavigation(
        selected,
        workspaces,
        tabs.filter((t) => t.tab_id !== "a1"),
        moved,
      ).selectedPaneId,
    ).toBe("a2p");
    expect(
      projectBrowserNavigation(
        selected,
        workspaces.slice(1),
        tabs.slice(2),
        moved,
      ).selectedPaneId,
    ).toBe("a1q");
    expect(
      projectBrowserNavigation(selected, [], [], []).browserNavigation,
    ).toEqual({ ...emptyBrowserNavigation(), revision: selected.revision + 1 });
  });

  test("remembers per-workspace tabs and per-tab panes without adopting later focus", () => {
    const topology = navigationTopology();
    let selection = selectBrowserTarget(
      emptyBrowserNavigation(),
      "a",
      "a1",
      "a1q",
    );
    selection = selectBrowserTarget(selection, "b", "b1", "b1p");
    selection = selectBrowserTarget(selection, "a");
    const projected = projectBrowserNavigation(
      selection,
      topology.workspaces,
      topology.tabs,
      topology.panes,
    );
    expect(projected.selectedPaneId).toBe("a1q");
    const layout = navigationLayout(topology.panes[0], topology.panes);
    expect(
      projectBrowserLayout(layout, projected.selectedPaneId)?.focused_pane_id,
    ).toBe("a1q");
    expect(layout.focused_pane_id).toBe("a1p");
    expect(browserPaneInDirection(layout, "a1p", "right")).toBe("a1q");
    expect(browserPaneInDirection(layout, "a1q", "left")).toBe("a1p");
    expect(browserPaneInDirection(layout, "a1p", "up")).toBeNull();
  });
});

import { bridge, type ConnectionClient } from "./api";
import {
  __storeTesting,
  activateConnectionState,
  emptyServerSessionState,
  endpointCreationReason,
  terminalNavigationLoading,
  store,
  type State,
} from "./store";
import { clearTabLayouts } from "./tabLayout";

function browserState(): State {
  const topology = navigationTopology();
  const session = {
    ...emptyServerSessionState(1),
    navigationMode: "browser-local" as const,
    endpointAvailability: Object.fromEntries(
      topology.panes.map((pane) => [
        pane.terminal_id,
        {
          methods: [
            "pane.focus",
            "pane.scroll",
            "tab.create",
            "workspace.create",
          ],
          capabilities: [],
        },
      ]),
    ),
    ...projectBrowserNavigation(
      emptyBrowserNavigation(),
      topology.workspaces,
      topology.tabs,
      topology.panes,
    ),
    layout: navigationLayout(topology.panes[0], topology.panes),
  };
  return {
    ...store.get(),
    ...session,
    status: "connected",
    connectionPaused: false,
    activeConnectionId: "test",
    connectionGeneration: 1,
    connections: ["test", "other"].map((id) => ({
      id,
      label: id,
      source: "test",
      is_default: id === "test",
      state: "ready" as const,
      generation: 1,
    })),
    sessionsByConnectionId: {
      test: session,
      other: emptyServerSessionState(1),
    },
  };
}

async function withBrowserStore(
  run: (
    calls: Array<{ method: string; params: Record<string, unknown> }>,
    topology: ReturnType<typeof navigationTopology>,
    control: {
      mode: string;
      endpointAvailability?: EndpointAvailability;
      layoutWait?: Promise<void>;
      createWait?: Promise<void>;
      actionWait?: (method: string) => Promise<void>;
    },
  ) => Promise<void>,
) {
  const previous = store.get();
  const original = bridge.connection;
  const topology = navigationTopology();
  clearTabLayouts();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const control: {
    mode: string;
    endpointAvailability?: EndpointAvailability;
    layoutWait?: Promise<void>;
    createWait?: Promise<void>;
    actionWait?: (method: string) => Promise<void>;
  } = {
    mode: "browser-local",
  };
  bridge.connection = ((connectionId = "test") =>
    ({
      connectionId,
      generation: 1,
      serverRuntimeGeneration: 1,
      isCurrent: () => true,
      acceptsServerGeneration: () => true,
      call: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        await control.actionWait?.(method);
        if (method === "workspace.list")
          return {
            workspaces: topology.workspaces,
            navigation_mode: control.mode,
            endpoint_availability:
              control.endpointAvailability ??
              Object.fromEntries(
                topology.panes.map((pane) => [
                  pane.terminal_id,
                  {
                    methods: [
                      "pane.focus",
                      "tab.create",
                      "workspace.create",
                      "pane.scroll",
                    ],
                    capabilities: [],
                  },
                ]),
              ),
          };
        if (method === "tab.list") return { tabs: topology.tabs };
        if (method === "pane.list") return { panes: topology.panes };
        if (method === "pane.layout") {
          const pane = topology.panes.find(
            (p) => p.pane_id === params.pane_id,
          )!;
          await control.layoutWait;
          return { layout: navigationLayout(pane, topology.panes) };
        }
        if (method === "pane.get")
          return {
            pane: topology.panes.find((p) => p.pane_id === params.pane_id),
          };
        if (method === "tab.create" || method === "workspace.create")
          await control.createWait;
        if (method === "tab.create")
          return {
            type: "tab_created",
            tab: topology.tabs[1],
            root_pane: topology.panes[2],
          };
        if (
          method === "workspace.create" ||
          method === "worktree.create" ||
          method === "worktree.open"
        )
          return {
            workspace: topology.workspaces[1],
            tab: topology.tabs[2],
            root_pane: topology.panes[3],
            base_sync:
              method === "worktree.create"
                ? { base: "origin/master", commit: "0123456789abcdef" }
                : undefined,
          };
        if (method === "pane.split") return { pane: topology.panes[1] };
        return {};
      },
    }) satisfies ConnectionClient) as typeof bridge.connection;
  __storeTesting.replaceState(browserState());
  try {
    await run(calls, topology, control);
  } finally {
    __storeTesting.replaceState(previous);
    bridge.connection = original;
  }
}

function renderTerminalSnapshot() {
  const snapshot = spyOn(React, "useSyncExternalStore").mockImplementation(
    (_subscribe, getSnapshot) => getSnapshot(),
  );
  const layoutEffect = spyOn(React, "useLayoutEffect").mockImplementation(
    () => {},
  );
  try {
    return renderToStaticMarkup(
      React.createElement(TerminalView, {
        terminalTheme: terminalThemeFor("dark"),
        uiScale: 100,
      }),
    );
  } finally {
    snapshot.mockRestore();
    layoutEffect.mockRestore();
  }
}

describe("store browser-local navigation", () => {
  test.each(["workspace", "tab", "agent"])(
    "%s selection renders the target pane while its layout is deferred",
    async (route) => {
      await withBrowserStore(async (_calls, _topology, control) => {
        let release!: () => void;
        control.layoutWait = new Promise<void>((resolve) => {
          release = resolve;
        });
        const pending =
          route === "workspace"
            ? store.focusWorkspace("b")
            : route === "tab"
              ? store.focusTab("b1")
              : store.focusPane("b1p");
        try {
          expect(store.get().selectedPaneId).toBe("b1p");
          // A provisional layout keeps the terminal on screen while the real
          // one is still in flight, so no navigation spinner is reached.
          expect(store.get().layout?.tab_id).toBe("b1");
          expect(terminalNavigationLoading(store.get())).toBe(false);
          const waiting = renderTerminalSnapshot();
          expect(waiting).toContain('class="terminal-view"');
          expect(waiting).not.toContain("Select a workspace");
          // The attach spinner only appears once its delay elapses, which a
          // static render never reaches.
          expect(waiting).not.toContain("Loading terminal");
        } finally {
          release();
          await pending;
        }
        expect(store.get().layout?.tab_id).toBe("b1");
        expect(terminalNavigationLoading(store.get())).toBe(false);
        const attaching = renderTerminalSnapshot();
        expect(attaching).toContain('class="terminal-view"');
        expect(attaching).not.toContain("Select a workspace");
      });
    },
  );

  test("a revisited split reappears with the geometry it was left in", async () => {
    await withBrowserStore(async (_calls, _topology, control) => {
      // Observe the split once so its geometry is known, then leave it.
      await store.refresh();
      expect(store.get().layout?.panes).toHaveLength(2);
      await store.focusTab("b1");
      expect(store.get().layout?.tab_id).toBe("b1");

      let release!: () => void;
      control.layoutWait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = store.focusTab("a1");
      try {
        const restored = store.get().layout;
        expect(restored?.tab_id).toBe("a1");
        expect(restored?.panes.map((pane) => pane.pane_id)).toEqual([
          "a1p",
          "a1q",
        ]);
        expect(terminalNavigationLoading(store.get())).toBe(false);
      } finally {
        release();
        await pending;
      }
      expect(store.get().layout?.panes).toHaveLength(2);
    });
  });

  test("a split that changed while it was away waits for real geometry", async () => {
    await withBrowserStore(async (_calls, topology, control) => {
      await store.refresh();
      await store.focusTab("b1");
      // A third pane appears in the tab while it is not being shown, so the
      // remembered rects no longer describe it.
      topology.panes.push({
        ...topology.panes[0],
        pane_id: "a1r",
        terminal_id: "a1r-terminal",
        focused: false,
      });
      await store.refresh();

      let release!: () => void;
      control.layoutWait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = store.focusTab("a1");
      try {
        expect(store.get().layout).toBeNull();
        expect(terminalNavigationLoading(store.get())).toBe(true);
      } finally {
        release();
        await pending;
      }
      expect(store.get().layout?.panes).toHaveLength(3);
    });
  });

  test("failed layout requests stop loading and a successful retry restores the terminal", async () => {
    await withBrowserStore(async (_calls, _topology, control) => {
      control.actionWait = (method) =>
        method === "pane.layout"
          ? Promise.reject(new Error("Layout unavailable"))
          : Promise.resolve();
      await store.focusWorkspace("b");
      expect(store.get().layout).toBeNull();
      expect(store.get().error).toBe("Layout unavailable");
      expect(terminalNavigationLoading(store.get())).toBe(false);
      const failed = renderTerminalSnapshot();
      expect(failed).toContain('role="alert"');
      expect(failed).toContain("Layout unavailable");
      expect(failed).toContain("Retry");
      expect(failed).not.toContain("Loading terminal");
      control.actionWait = undefined;
      await store.refresh();
      expect(store.get().error).toBeNull();
      expect(store.get().layout?.tab_id).toBe("b1");
      expect(renderTerminalSnapshot()).toContain('class="terminal-view"');
    });
  });

  test("a workspace with no panes keeps the empty prompt", async () => {
    await withBrowserStore(async (_calls, topology) => {
      topology.panes = topology.panes.filter(
        (pane) => pane.workspace_id !== "b",
      );
      await store.focusWorkspace("b");
      const empty = renderTerminalSnapshot();
      expect(empty).toContain("Select a workspace");
      expect(empty).not.toContain("Loading terminal");
    });
  });

  test("empty, removed, paused, disconnected and failed targets do not spin", () => {
    const pending = { ...browserState(), layout: null };
    expect(terminalNavigationLoading(pending)).toBe(true);
    for (const patch of [
      { selectedPaneId: null },
      { panes: [] },
      { connectionPaused: true },
      { status: "disconnected" as const },
      { error: "Refresh failed" },
    ]) {
      expect(terminalNavigationLoading({ ...pending, ...patch })).toBe(false);
    }
    expect(
      terminalNavigationLoading({
        ...pending,
        selectedPaneId: null,
        pendingFocusWorkspaceId: "b",
      }),
    ).toBe(true);
  });

  test("all navigation routes avoid shared focus and target input explicitly", async () => {
    await withBrowserStore(async (calls) => {
      await store.focusWorkspace("b");
      expect(store.get().selectedPaneId).toBe("b1p");
      await store.focusTab("a2");
      expect(store.get().selectedPaneId).toBe("a2p");
      await store.focusPane("a1p");
      await store.focusPaneDirection("a1p", "right");
      expect(store.get().selectedPaneId).toBe("a1q");
      await store.selectPane("a1p");
      await store.focusTaskNotificationTarget({
        connectionId: "test",
        runtimeGeneration: 1,
        workspaceId: "b",
        paneId: "b1p",
      });
      expect(store.get().selectedPaneId).toBe("b1p");
      await store.sendText(store.get().selectedPaneId!, "targeted");
      await store.sendKeys(store.get().selectedPaneId!, "Enter");
      expect(calls.filter((call) => /focus/.test(call.method))).toEqual([]);
      expect(
        calls.filter((call) => call.method.startsWith("pane.send")),
      ).toEqual([
        {
          method: "pane.send_text",
          params: { pane_id: "b1p", text: "targeted" },
        },
        {
          method: "pane.send_keys",
          params: { pane_id: "b1p", keys: ["Enter"] },
        },
      ]);
    });
  });

  test("event/resync snapshots and reconnect preserve selection; connection switches restore it", async () => {
    await withBrowserStore(async (_calls, topology) => {
      await store.focusTab("a2");
      topology.workspaces[0].focused = false;
      topology.workspaces[1].focused = true;
      __storeTesting.handleHerdrEvent({
        connection_id: "test",
        connection_generation: 1,
        event: "session.resync_required",
        data: {},
      });
      await Bun.sleep(120);
      expect(store.get().selectedPaneId).toBe("a2p");
      const before = store.get();
      __storeTesting.markTerminalReattachPending();
      __storeTesting.applyCatalog(before.connections, "test");
      __storeTesting.rearmTerminalAttachmentsAfterCatalog(true);
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("a2p");
      const other = activateConnectionState(store.get(), "other", 2);
      const restored = activateConnectionState(other, "test", 3);
      expect(restored.browserNavigation).toEqual(store.get().browserNavigation);
      expect(restored.selectedPaneId).toBe("a2p");
    });
  });

  test("a deferred layout cannot overwrite a newer local click", async () => {
    await withBrowserStore(async (_calls, _topology, control) => {
      let resolve!: () => void;
      control.layoutWait = new Promise<void>((r) => {
        resolve = r;
      });
      const refresh = store.refresh();
      await Bun.sleep(1);
      await store.focusTab("b1");
      expect(store.get().layout?.tab_id).toBe("b1");
      expect(terminalNavigationLoading(store.get())).toBe(false);
      resolve();
      await refresh;
      await Bun.sleep(5);
      expect(store.get().selectedPaneId).toBe("b1p");
      expect(store.get().layout?.tab_id).toBe("b1");
      expect(terminalNavigationLoading(store.get())).toBe(false);
    });
  });

  test("closed/moved snapshots reconcile action targets without following remote focus", async () => {
    await withBrowserStore(async (calls, topology) => {
      await store.focusPane("a1q");
      Object.assign(topology.panes[1], { workspace_id: "b", tab_id: "b1" });
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("a1p");
      await store.closePane(store.get().selectedPaneId!);
      expect(calls[calls.length - 1]).toEqual({
        method: "pane.close",
        params: { pane_id: "a1p" },
      });
      topology.panes = topology.panes.filter((pane) => pane.pane_id !== "a1p");
      topology.tabs = topology.tabs.filter((tab) => tab.tab_id !== "a1");
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("a2p");
    });
  });

  test("notification activation follows an explicitly moved pane and falls back when closed", async () => {
    await withBrowserStore(async (calls, topology) => {
      Object.assign(topology.panes[1], { workspace_id: "b", tab_id: "b1" });
      const target = {
        connectionId: "test",
        runtimeGeneration: 1,
        workspaceId: "a",
        paneId: "a1q",
      };
      await store.focusTaskNotificationTarget(target);
      expect(store.get().browserNavigation.workspaceId).toBe("b");
      expect(store.get().selectedPaneId).toBe("a1q");
      topology.panes = topology.panes.filter((pane) => pane.pane_id !== "a1q");
      await store.focusTaskNotificationTarget(target);
      expect(store.get().browserNavigation.workspaceId).toBe("a");
      expect(store.get().selectedPaneId).toBe("a1p");
      expect(calls.filter((call) => /focus/.test(call.method))).toEqual([]);
    });
  });

  test("a pane moved while its layout is in flight never publishes the destination tab", async () => {
    await withBrowserStore(async (_calls, topology, control) => {
      let resolve!: () => void;
      control.layoutWait = new Promise<void>((r) => {
        resolve = r;
      });
      const refresh = store.refresh();
      await Bun.sleep(1);
      Object.assign(topology.panes[0], { workspace_id: "b", tab_id: "b1" });
      const publishedTabs: Array<string | undefined> = [];
      const unsubscribe = store.subscribe(() =>
        publishedTabs.push(store.get().layout?.tab_id),
      );
      resolve();
      await refresh;
      await Bun.sleep(5);
      unsubscribe();
      expect(publishedTabs).not.toContain("b1");
      expect(store.get().selectedPaneId).toBe("a1q");
      expect(store.get().layout?.tab_id).toBe("a1");
    });
  });

  test("creation suppresses shared focus, inherits local context and selects returned objects", async () => {
    await withBrowserStore(async (calls) => {
      await store.focusPane("a1q");
      await store.createTab("a");
      expect(
        calls.find((call) => call.method === "tab.create")?.params,
      ).toEqual({
        workspace_id: "a",
        focus: false,
        browser_source: {
          workspace_id: "a",
          tab_id: "a1",
          pane_id: "a1q",
          terminal_id: "a1q-terminal",
        },
      });
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("a2p");
      await store.createWorkspace("new");
      expect(
        calls.find((call) => call.method === "workspace.create")?.params,
      ).toMatchObject({
        browser_source: {
          workspace_id: "a",
          tab_id: "a2",
          pane_id: "a2p",
          terminal_id: "a2p-terminal",
        },
        focus: false,
      });
      expect(
        calls.find((call) => call.method === "workspace.create")?.params.cwd,
      ).toBeUndefined();
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("b1p");
      await store.splitPane("a1p", "right");
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("a1q");
      expect(
        calls.find((call) => call.method === "pane.split")?.params,
      ).toEqual({ target_pane_id: "a1p", direction: "right", focus: false });
      await store.openWorktree("a", "topic");
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("b1p");
      expect(
        calls.find((call) => call.method === "worktree.open")?.params.focus,
      ).toBe(false);
    });
  });

  test("worktree creation notice uses the resolved default branch", async () => {
    await withBrowserStore(async () => {
      await store.createWorktree("a", "topic");
      expect(store.get().notice?.detail).toBe(
        "topic starts from origin/master at 0123456789ab.",
      );
    });
  });

  test("creation never synthesizes cwd and carries nonactive workspace context", async () => {
    await withBrowserStore(async (calls) => {
      await store.createTab("b");
      const tabCreate = calls.find((call) => call.method === "tab.create")!;
      expect(tabCreate.params).not.toHaveProperty("cwd");
      expect(tabCreate.params.browser_source).toEqual({
        workspace_id: "b",
        tab_id: "b1",
        pane_id: "b1p",
        terminal_id: "b1p-terminal",
      });
      await store.createWorkspace("explicit", "/chosen");
      expect(
        calls.find((call) => call.method === "workspace.create")?.params.cwd,
      ).toBe("/chosen");
    });
  });

  test("a delayed create response does not navigate away from a newer local choice", async () => {
    await withBrowserStore(async (_calls, _topology, control) => {
      let resolve!: () => void;
      control.createWait = new Promise<void>((r) => {
        resolve = r;
      });
      const creation = store.createTab("a");
      await store.focusWorkspace("b");
      resolve();
      await creation;
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("b1p");
    });
  });

  for (const kind of [
    "worktree-create",
    "worktree-open",
    "worktree-cwd",
    "split",
    "notification",
    "notification-fallback",
  ] as const) {
    test(`delayed ${kind} preserves a newer browser selection`, async () => {
      await withBrowserStore(async (_calls, topology, control) => {
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
          release = resolve;
        });
        const worktree = kind.startsWith("worktree");
        const method =
          kind === "worktree-create"
            ? "worktree.create"
            : worktree
              ? "worktree.open"
              : kind === "split"
                ? "pane.split"
                : "pane.get";
        control.actionWait = (call) =>
          call === method ? waiting : Promise.resolve();
        if (worktree) await store.focusWorkspace("b");
        if (kind === "notification-fallback")
          topology.panes = topology.panes.filter(
            (pane) => pane.pane_id !== "a1q",
          );
        const pending =
          kind === "worktree-create"
            ? store.createWorktree("b", "topic")
            : kind === "worktree-open"
              ? store.openWorktree("b", "topic")
              : kind === "worktree-cwd"
                ? store.openWorktreeFromCwd("/tmp/b", "main")
                : kind === "split"
                  ? store.splitPane("a1p", "right")
                  : store.focusTaskNotificationTarget({
                      connectionId: "test",
                      runtimeGeneration: 1,
                      workspaceId: "a",
                      paneId: "a1q",
                    });
        await store.focusWorkspace(worktree ? "a" : "b");
        release();
        await pending;
        await store.refresh();
        expect(store.get().selectedPaneId).toBe(worktree ? "a1p" : "b1p");
      });
    });
  }

  test("reverse mutation completion cannot let an older split steal selection", async () => {
    await withBrowserStore(async (_calls, _topology, control) => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      control.actionWait = (method) =>
        method === "pane.split" ? waiting : Promise.resolve();
      const split = store.splitPane("a1p", "right");
      await store.openWorktree("a", "topic");
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("b1p");
      release();
      await split;
      expect(store.get().selectedPaneId).toBe("b1p");
    });
  });

  test("legacy or endpoint-disabled metadata explicitly restores shared behavior", async () => {
    await withBrowserStore(async (calls, _topology, control) => {
      await store.focusWorkspace("b");
      control.mode = "shared";
      await store.refresh();
      expect(store.get().navigationMode).toBe("shared");
      expect(store.get().workspaces.find((w) => w.focused)?.workspace_id).toBe(
        "a",
      );
      await store.focusTab("b1");
      expect(
        calls
          .filter((call) => /focus/.test(call.method))
          .map((call) => call.method),
      ).toEqual(["workspace.focus", "tab.focus"]);
    });
  });
});

for (const kind of [
  "worktree-create",
  "worktree-open",
  "worktree-cwd",
  "split",
  "notification",
] as const) {
  test(`delayed ${kind} cannot adopt into a replacement runtime on the same connection`, async () => {
    await withBrowserStore(async (_calls, _topology, control) => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const method =
        kind === "worktree-create"
          ? "worktree.create"
          : kind.startsWith("worktree")
            ? "worktree.open"
            : kind === "split"
              ? "pane.split"
              : "pane.get";
      control.actionWait = (call) =>
        call === method ? waiting : Promise.resolve();
      const pending =
        kind === "worktree-create"
          ? store.createWorktree("a", "topic")
          : kind === "worktree-open"
            ? store.openWorktree("a", "topic")
            : kind === "worktree-cwd"
              ? store.openWorktreeFromCwd("/tmp/a", "main")
              : kind === "split"
                ? store.splitPane("a1p", "right")
                : store.focusTaskNotificationTarget({
                    connectionId: "test",
                    runtimeGeneration: 1,
                    workspaceId: "a",
                    paneId: "a1q",
                  });
      __storeTesting.replaceState({
        ...activateConnectionState(store.get(), "test", 2),
        serverRuntimeGeneration: 2,
      });
      release();
      await pending;
      expect(store.get().selectedPaneId).toBe("a1p");
      expect(store.get().browserNavigation.workspaceId).toBe("a");
    });
  });
}

for (const kind of [
  "tab",
  "workspace",
  "worktree-create",
  "worktree-open",
  "worktree-cwd",
  "split",
  "notification",
  "notification-fallback",
] as const) {
  test(`delayed ${kind} cannot adopt after workspace A-B-A navigation`, async () => {
    await withBrowserStore(async (_calls, _topology, control) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const method =
        kind === "tab"
          ? "tab.create"
          : kind === "workspace"
            ? "workspace.create"
            : kind === "worktree-create"
              ? "worktree.create"
              : kind.startsWith("worktree")
                ? "worktree.open"
                : kind === "split"
                  ? "pane.split"
                  : "pane.get";
      control.actionWait = (call) =>
        call === method ? held : Promise.resolve();
      const pending =
        kind === "tab"
          ? store.createTab("a")
          : kind === "workspace"
            ? store.createWorkspace("new")
            : kind === "worktree-create"
              ? store.createWorktree("a", "topic")
              : kind === "worktree-open"
                ? store.openWorktree("a", "topic")
                : kind === "worktree-cwd"
                  ? store.openWorktreeFromCwd("/tmp/a", "main")
                  : kind === "split"
                    ? store.splitPane("a1p", "right")
                    : store.focusTaskNotificationTarget({
                        connectionId: "test",
                        runtimeGeneration: 1,
                        workspaceId:
                          kind === "notification-fallback" ? "b" : "a",
                        paneId:
                          kind === "notification-fallback" ? "closed" : "a1q",
                      });
      await store.focusWorkspace("b");
      await store.focusWorkspace("a");
      release();
      await pending;
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("a1p");
    });
  });
}

for (const scope of ["tab", "pane"] as const) {
  test(`delayed tab creation cannot adopt after same-workspace ${scope} ABA`, async () => {
    await withBrowserStore(async (_calls, _topology, control) => {
      let release!: () => void;
      control.createWait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = store.createTab("a");
      if (scope === "tab") {
        await store.focusTab("a2");
        await store.focusTab("a1");
      } else {
        await store.focusPane("a1q");
        await store.focusPane("a1p");
      }
      release();
      await pending;
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("a1p");
    });
  });
}

test("ordinary snapshots do not invalidate pending adoption, including copied navigation maps", async () => {
  await withBrowserStore(async (_calls, topology, control) => {
    let release!: () => void;
    control.createWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = store.createTab("a");
    const initialNavigation = store.get().browserNavigation;
    topology.workspaces[0] = { ...topology.workspaces[0], label: "renamed" };
    topology.tabs.push({ ...topology.tabs[2], tab_id: "b2" });
    topology.panes.push({ ...topology.panes[3], tab_id: "b2", pane_id: "b2p" });
    await store.refresh();
    await store.refresh();
    expect(initialNavigation.workspaceId).toBe("a");
    expect(store.get().browserNavigation).not.toBe(initialNavigation);
    expect(store.get().browserNavigation.revision).toBe(
      initialNavigation.revision,
    );
    release();
    await pending;
    await store.refresh();
    expect(store.get().selectedPaneId).toBe("a2p");
  });
});

for (const paneId of ["a1p", "closed"]) {
  test(`successful same-target notification ${paneId} adoption invalidates an older competing creation`, async () => {
    await withBrowserStore(async (_calls, _topology, control) => {
      let release!: () => void;
      control.createWait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = store.createTab("a");
      await store.focusTaskNotificationTarget({
        connectionId: "test",
        runtimeGeneration: 1,
        workspaceId: "a",
        paneId,
      });
      release();
      await pending;
      await store.refresh();
      expect(store.get().selectedPaneId).toBe("a1p");
    });
  });
}

test("revision snapshots are immutable; reconciliation changes revision only for a different active target", () => {
  const topology = navigationTopology();
  const initial = projectBrowserNavigation(
    emptyBrowserNavigation(),
    topology.workspaces,
    topology.tabs,
    topology.panes,
  ).browserNavigation;
  Object.freeze(initial);
  Object.freeze(initial.tabIds);
  Object.freeze(initial.paneIds);
  const selected = selectBrowserTarget(initial, "a", "a1", "a1q");
  expect(selected.revision).toBe(initial.revision + 1);
  expect(initial.paneIds.a1).toBe("a1p");
  const stable = projectBrowserNavigation(
    selected,
    topology.workspaces,
    topology.tabs,
    topology.panes,
  ).browserNavigation;
  expect(stable).not.toBe(selected);
  expect(stable.revision).toBe(selected.revision);
  const removed = projectBrowserNavigation(
    stable,
    topology.workspaces,
    topology.tabs,
    topology.panes.filter((pane) => pane.pane_id !== "a1q"),
  ).browserNavigation;
  expect(removed.revision).toBe(stable.revision + 1);
  expect(removed.paneIds.a1).toBe("a1p");
});

test("navigation revisions remain partitioned by connection and reset with runtime session state", async () => {
  await withBrowserStore(async () => {
    await store.focusWorkspace("b");
    const original = store.get().browserNavigation;
    __storeTesting.replaceState(
      activateConnectionState(store.get(), "other", 2),
    );
    expect(store.get().browserNavigation.revision).toBe(0);
    await store.refresh();
    await store.focusPane("a1q");
    __storeTesting.replaceState(
      activateConnectionState(store.get(), "test", 3),
    );
    expect(store.get().browserNavigation).toEqual(original);
    expect(emptyServerSessionState(2).browserNavigation.revision).toBe(0);
  });
});

test("shared fallback retains shared focus, creation and split selection semantics", async () => {
  await withBrowserStore(async (calls, _topology, control) => {
    control.mode = "shared";
    await store.refresh();
    const revision = store.get().browserNavigation.revision;
    await store.createTab("a");
    expect(calls.find((call) => call.method === "tab.create")?.params).toEqual({
      workspace_id: "a",
      focus: true,
    });
    await store.focusWorkspace("b");
    expect(
      calls.some(
        (call) =>
          call.method === "workspace.focus" && call.params.workspace_id === "b",
      ),
    ).toBe(true);
    await store.splitPane("a1p", "right");
    expect(store.get().selectedPaneId).toBe("a1q");
    expect(store.get().browserNavigation.revision).toBe(revision);
  });
});

test("frontend dispatch and availability track each terminal subset and refresh without borrowing another connection", async () => {
  await withBrowserStore(async (calls) => {
    const initial = store.get();
    __storeTesting.replaceState({
      ...initial,
      endpointAvailability: {
        "a1p-terminal": {
          methods: ["pane.focus", "tab.create"],
          capabilities: [],
        },
        "b1p-terminal": { methods: [], capabilities: [] },
      },
    });
    expect(endpointCreationReason(store.get(), "tab.create", "a")).toBeNull();
    expect(endpointCreationReason(store.get(), "workspace.create")).toContain(
      "workspace.create",
    );
    expect(endpointCreationReason(store.get(), "tab.create", "b")).toContain(
      "pane.focus",
    );
    const advertisementBeforeStaleReply = store.get().endpointAvailability;
    store.setTerminalEndpoint(
      { ...bridge.connection(), isCurrent: () => false },
      "a1p-terminal",
      { methods: ["pane.scroll"], capabilities: [] },
    );
    expect(store.get().endpointAvailability).toBe(
      advertisementBeforeStaleReply,
    );
    expect(store.terminalScrollReason("a1p-terminal")).toContain("pane.scroll");
    expect(store.terminalScrollReason("a1p-terminal", true)).toBeNull();
    await store.createWorkspace("blocked");
    await store.createTab("b");
    expect(calls.some((call) => call.method.endsWith(".create"))).toBe(false);
    await store.createTab("a");
    expect(calls.filter((call) => call.method === "tab.create")).toHaveLength(
      1,
    );
    const switched = activateConnectionState(store.get(), "other", 2);
    expect(switched.endpointAvailability).toEqual({});
    expect(
      activateConnectionState(switched, "test", 3).endpointAvailability,
    ).toEqual({});
    __storeTesting.replaceState({ ...initial, endpointAvailability: {} });
    expect(endpointCreationReason(store.get(), "tab.create", "a")).toContain(
      "loading",
    );
    await store.refresh();
    expect(endpointCreationReason(store.get(), "tab.create", "a")).toBeNull();
  });
});

for (const transition of [
  "complete-to-reduced",
  "empty-to-attached",
  "close-to-unknown",
] as const) {
  test.each(["pane.layout", "workspace.list"])(
    `delayed %s preserves newer endpoint availability: ${transition}`,
    async (updateDuring) => {
      await withBrowserStore(async (calls, topology, control) => {
        const terminalId = "a1p-terminal";
        const complete = {
          methods: [
            "pane.focus",
            "pane.scroll",
            "tab.create",
            "workspace.create",
          ],
          capabilities: [],
        };
        const newer =
          transition === "close-to-unknown"
            ? null
            : transition === "complete-to-reduced"
              ? { methods: ["pane.focus"], capabilities: [] }
              : complete;
        control.endpointAvailability =
          transition === "empty-to-attached" ? {} : { [terminalId]: complete };
        __storeTesting.replaceState({
          ...store.get(),
          layout: null,
          endpointAvailability: control.endpointAvailability,
        });
        const navigation = store.get().browserNavigation;
        topology.workspaces[0] = {
          ...topology.workspaces[0],
          label: "fresh topology",
        };
        const listEntered = Promise.withResolvers<void>();
        const listRelease = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const queuedEntered = Promise.withResolvers<void>();
        const queuedRelease = Promise.withResolvers<void>();
        let layoutCalls = 0;
        control.actionWait = async (method) => {
          if (
            method === "workspace.list" &&
            updateDuring === method &&
            layoutCalls === 0
          ) {
            listEntered.resolve();
            await listRelease.promise;
          }
          if (method !== "pane.layout") return;
          if (++layoutCalls === 1) {
            entered.resolve();
            await release.promise;
          } else {
            queuedEntered.resolve();
            await queuedRelease.promise;
          }
        };
        const refreshed = Promise.withResolvers<void>();
        const freshAdvertisement = {
          methods: ["pane.focus", "tab.create"],
          capabilities: ["health_check"],
        };
        const unsubscribe = store.subscribe(() => {
          if (
            store
              .get()
              .endpointAvailability[terminalId]?.capabilities.includes(
                "health_check",
              )
          )
            refreshed.resolve();
        });
        try {
          const pending = store.refresh();
          await (updateDuring === "workspace.list"
            ? listEntered.promise
            : entered.promise);
          store.setTerminalEndpoint(bridge.connection(), terminalId, newer);
          const updated = store.get().endpointAvailability;
          listRelease.resolve();
          await entered.promise;
          // Only the queued refresh should see this next server observation.
          control.endpointAvailability = { [terminalId]: freshAdvertisement };
          release.resolve();
          await pending;
          expect(store.get().endpointAvailability).toBe(updated);
          expect(store.get().browserNavigation.revision).toBe(
            navigation.revision,
          );
          expect(store.get().selectedPaneId).toBe("a1p");
          expect(store.get().layout?.tab_id).toBe("a1");
          expect(store.get().workspaces[0].label).toBe("fresh topology");
          expect(endpointCreationReason(store.get(), "tab.create", "a")).toBe(
            newer === null
              ? "Endpoint availability is loading. Open the source terminal and wait for it to connect."
              : transition === "complete-to-reduced"
                ? "Herdr endpoint does not advertise tab.create"
                : null,
          );
          await queuedEntered.promise;
          expect(
            calls.filter((call) => call.method === "workspace.list"),
          ).toHaveLength(2);
          queuedRelease.resolve();
          await refreshed.promise;
          expect(store.get().endpointAvailability[terminalId]).toEqual(
            freshAdvertisement,
          );
          expect(
            endpointCreationReason(store.get(), "tab.create", "a"),
          ).toBeNull();
          expect(
            calls.filter((call) => call.method === "workspace.list"),
          ).toHaveLength(2);
        } finally {
          unsubscribe();
          listRelease.resolve();
          release.resolve();
          queuedRelease.resolve();
        }
      });
    },
  );
}
