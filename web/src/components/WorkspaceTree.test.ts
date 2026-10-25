import { expect, jest, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { roamgateLocalStorage } from "../browserStorage";
import { bridge, type HerdrEventMsg } from "../api";
import { connectionStorageKey } from "../connectionStorage";
import { __storeTesting, store } from "../store";
import {
  __resetTabPinsForTests,
  setTabPinned,
  TAB_PINS_STORAGE_KEY,
  tabPinsFor,
  useTabPins,
} from "../tabPins";
import {
  AGENT_LIST_PREFERENCES_STORAGE_KEY,
  AGENT_ORDER_STORAGE_KEY,
} from "../agentOrder";
import { WORKSPACE_PINS_STORAGE_KEY } from "../workspacePins";
import { COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY } from "../workspaceTreeCollapse";
import {
  AGENT_LIST_SCOPE_STORAGE_KEY,
  WORKSPACE_AGENT_LAYOUT_STORAGE_KEY,
} from "../workspaceAgentLayout";
import type { ConnectionAgentSessions } from "../useAllServerAgentSessions";
import { WorkspaceTree } from "./WorkspaceTree";

// Isolate browser globals and React's module graph from other Bun tests.
if (process.env.ROAMGATE_WORKSPACE_STORAGE_DOM_TEST !== "1") {
  test("workspace preference updates in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_WORKSPACE_STORAGE_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);
} else {
  test("reloads preferences and monitors isolated server sessions", async () => {
    const browser = new Window({ url: "http://localhost" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const previousState = store.get();
    const mocks: { mockRestore(): void }[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const pinsKey = connectionStorageKey("alpha", WORKSPACE_PINS_STORAGE_KEY);
    const collapseKey = connectionStorageKey(
      "alpha",
      COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY,
    );
    const orderKey = connectionStorageKey("alpha", AGENT_ORDER_STORAGE_KEY);
    const tabPinsKey = connectionStorageKey("alpha", TAB_PINS_STORAGE_KEY);
    const emit = async (
      key: string | null,
      storageArea = browser.localStorage,
    ) => {
      await act(async () => {
        browser.dispatchEvent(
          new browser.StorageEvent("storage", {
            key: key ?? undefined,
            storageArea,
          }),
        );
      });
    };
    const write = async (key: string, value: string) => {
      browser.localStorage.setItem(`roamgate:${key}`, value);
      await emit(`roamgate:${key}`);
    };
    const activeLayout = () =>
      container.querySelector(".workspace-agent-layout-control .is-active")
        ?.textContent;
    function Pins() {
      return createElement("output", null, [...useTabPins("alpha")].join(","));
    }
    try {
      __resetTabPinsForTests();
      __storeTesting.replaceState({
        ...previousState,
        activeConnectionId: "alpha",
        workspaces: [
          {
            workspace_id: "w1",
            number: 1,
            label: "Workspace",
            focused: false,
            pane_count: 2,
            tab_count: 1,
            agent_status: "working",
          },
        ],
        panes: ["p1", "p2"].map((id) => ({
          pane_id: `w1:${id}`,
          terminal_id: id,
          workspace_id: "w1",
          tab_id: "t1",
          focused: false,
          agent: "claude",
          agent_status: "working",
          revision: 1,
        })),
      });
      await act(async () =>
        root.render(
          createElement(
            "div",
            null,
            createElement(WorkspaceTree),
            createElement(Pins),
          ),
        ),
      );
      expect(activeLayout()).toBe("Nested");
      await write(pinsKey, '["workspace:w1"]');
      expect(container.querySelector(".tree-row.is-pinned")).not.toBeNull();
      await write(collapseKey, '["workspace:w1"]');
      expect(
        container.querySelector(".tree-row")?.getAttribute("aria-expanded"),
      ).toBe("false");
      expect(container.querySelector(".agent-row")).toBeNull();
      await write(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY, "separate");
      await write(
        AGENT_LIST_PREFERENCES_STORAGE_KEY,
        '{"sort":"manual","grouping":"none"}',
      );
      await write(orderKey, '["w1:p2","w1:p1"]');
      expect(activeLayout()).toBe("Separate");
      expect(
        container
          .querySelector(".agents-panel .agent-row")
          ?.getAttribute("title"),
      ).toStartWith("w1:p2");

      // A stale legacy write cannot override the current namespaced value.
      browser.localStorage.setItem(
        WORKSPACE_AGENT_LAYOUT_STORAGE_KEY,
        "compact",
      );
      await emit(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY);
      expect(activeLayout()).toBe("Separate");
      browser.sessionStorage.setItem(
        `roamgate:${WORKSPACE_AGENT_LAYOUT_STORAGE_KEY}`,
        "compact",
      );
      await emit(
        `roamgate:${WORKSPACE_AGENT_LAYOUT_STORAGE_KEY}`,
        browser.sessionStorage,
      );
      expect(activeLayout()).toBe("Separate");

      const setItem = browser.localStorage.setItem;
      browser.localStorage.setItem = () => {
        throw new Error("storage full");
      };
      await act(async () => setTabPinned("beta", "unsaved", true));
      browser.localStorage.setItem = setItem;
      await write(tabPinsKey, '["remote"]');
      expect(container.querySelector("output")?.textContent).toBe("remote");
      expect([...tabPinsFor("beta")]).toEqual(["unsaved"]);
      await emit(`roamgate:${tabPinsKey}`, browser.sessionStorage);
      expect([...tabPinsFor("beta")]).toEqual(["unsaved"]);
      await write(
        connectionStorageKey("gamma", TAB_PINS_STORAGE_KEY),
        '["other"]',
      );
      expect([...tabPinsFor("beta")]).toEqual(["unsaved"]);

      roamgateLocalStorage.removeItem(tabPinsKey);
      await emit(`roamgate:deleted:${encodeURIComponent(tabPinsKey)}`);
      expect(container.querySelector("output")?.textContent).toBe("");
      browser.localStorage.clear();
      await emit(null);
      expect(activeLayout()).toBe("Nested");
      expect(container.querySelector(".tree-row.is-pinned")).toBeNull();
      expect(
        container.querySelector(".tree-row")?.getAttribute("aria-expanded"),
      ).toBe("true");
      expect(container.querySelectorAll(".agent-row").length).toBe(2);
      expect(tabPinsFor("beta").size).toBe(0);

      jest.useFakeTimers();
      let onEvent: ((event: HerdrEventMsg) => void) | undefined;
      mocks.push(
        spyOn(bridge, "onEvent").mockImplementation((callback) => {
          onEvent = callback;
          return () => {
            onEvent = undefined;
          };
        }),
      );
      let snapshots: ConnectionAgentSessions[] = ["alpha", "beta"].map(
        (id) => ({
          connection_id: id,
          connection_generation: 1,
          workspaces: [
            {
              workspace_id: "w1",
              label: `${id} workspace`,
              number: 1,
              focused: false,
              pane_count: 1,
              tab_count: 1,
              agent_status: "working",
            },
          ],
          tabs: [
            {
              tab_id: "t1",
              workspace_id: "w1",
              number: 1,
              label: `${id} tab`,
              focused: true,
              pane_count: 1,
              agent_status: "working",
            },
          ],
          panes: [
            {
              pane_id: "w1:p1",
              terminal_id: "term1",
              workspace_id: "w1",
              tab_id: "t1",
              focused: true,
              agent: "codex",
              agent_status: "working",
              revision: 1,
            },
          ],
          agents: null,
        }),
      );
      const summary = spyOn(bridge, "call").mockImplementation(
        async (method) => {
          expect(method).toBe("connections.agent_sessions");
          return { connections: snapshots };
        },
      );
      const navigate = spyOn(store, "focusWorkspaceSource").mockResolvedValue(
        true,
      );
      const localFocus = spyOn(store, "focusPane").mockResolvedValue(undefined);
      mocks.push(summary, navigate, localFocus);
      await act(async () =>
        __storeTesting.replaceState({
          ...store.get(),
          status: "connected",
          connectionPaused: false,
          workspaces: [],
          panes: [],
          tabs: [],
          layout: null,
          connections: ["alpha", "beta", "offline"].map((id) => ({
            id,
            label: id,
            source: "test",
            generation: 1,
            is_default: id === "alpha",
            state: id === "offline" ? "disconnected" : "ready",
          })),
        }),
      );
      await write(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY, "separate");
      expect(summary).not.toHaveBeenCalled();
      await write(AGENT_LIST_SCOPE_STORAGE_KEY, "all");
      const rows = () => [
        ...container.querySelectorAll<HTMLElement>(".agents-panel .agent-row"),
      ];
      expect(rows()).toHaveLength(2);
      expect(rows().map((row) => row.textContent)).toEqual([
        expect.stringContaining("alpha tab"),
        expect.stringContaining("beta tab"),
      ]);
      expect(
        container.querySelector('[data-connection-id="offline"]')?.textContent,
      ).toContain("Disconnected");
      expect(
        container.querySelector(
          '.workspace-tree-panel [aria-label="Workspace server scope"]',
        ),
      ).not.toBeNull();
      expect(
        container.querySelector(
          '.agents-panel [aria-label="Workspace server scope"]',
        ),
      ).toBeNull();
      expect(store.get().activeConnectionId).toBe("alpha");
      await act(async () => rows()[1].click());
      expect(navigate).toHaveBeenCalledWith({
        connectionId: "beta",
        runtimeGeneration: 1,
        workspaceId: "w1",
        paneId: "w1:p1",
      });
      expect(localFocus).not.toHaveBeenCalled();
      await act(async () =>
        rows()[1].dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
      );
      expect(navigate).toHaveBeenCalledTimes(2);
      const remoteMenu = new window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      await act(async () => rows()[1].dispatchEvent(remoteMenu));
      expect(remoteMenu.defaultPrevented).toBe(true);
      expect(container.querySelector(".context-menu")?.textContent).toContain(
        "beta",
      );
      expect(
        container.querySelector(".context-menu")?.textContent,
      ).not.toContain("Close pane");
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(".context-menu-item")!
          .click(),
      );
      expect(navigate).toHaveBeenLastCalledWith({
        connectionId: "beta",
        runtimeGeneration: 1,
        workspaceId: "w1",
        paneId: "w1:p1",
      });
      await act(async () => rows()[0].click());
      expect(navigate).toHaveBeenLastCalledWith({
        connectionId: "alpha",
        runtimeGeneration: 1,
        workspaceId: "w1",
        paneId: "w1:p1",
      });
      expect(localFocus).not.toHaveBeenCalled();

      const refresh = async () =>
        act(async () => {
          onEvent?.({
            connection_id: "beta",
            connection_generation: 1,
            event: "pane.agent_status_changed",
            data: {},
          });
          jest.advanceTimersByTime(150);
        });
      snapshots = snapshots.map((snapshot) =>
        snapshot.connection_id === "beta"
          ? {
              ...snapshot,
              panes: snapshot.panes.map((pane) => ({
                ...pane,
                agent_status: "blocked",
              })),
            }
          : snapshot,
      );
      await refresh();
      expect(rows()[0].textContent).toContain("beta tab");
      expect(rows()[0].textContent).toContain("blocked");
      await write(
        AGENT_LIST_PREFERENCES_STORAGE_KEY,
        '{"grouping":"workspace"}',
      );
      expect(container.querySelectorAll(".agent-group-toggle")).toHaveLength(2);

      await act(async () =>
        __storeTesting.applyCatalog(
          store
            .get()
            .connections.map((connection) =>
              connection.id === "beta"
                ? { ...connection, generation: 2 }
                : connection,
            ),
          "alpha",
        ),
      );
      expect(rows()).toHaveLength(1);
      snapshots = snapshots.map((snapshot) => ({
        ...snapshot,
        connection_generation: snapshot.connection_id === "beta" ? 2 : 1,
      }));
      await refresh();
      expect(rows()).toHaveLength(2);
      await act(async () =>
        __storeTesting.applyCatalog(
          store
            .get()
            .connections.map((connection) =>
              connection.id === "beta"
                ? { ...connection, state: "disconnected" }
                : connection,
            ),
          "alpha",
        ),
      );
      expect(rows()).toHaveLength(1);
      expect(
        container.querySelector('[data-connection-id="beta"]')?.textContent,
      ).toContain("Disconnected");

      summary.mockRejectedValueOnce(new Error("read failed"));
      await refresh();
      expect(rows()).toHaveLength(0);
      expect(container.textContent).toContain(
        "Could not load sessions: read failed",
      );
      await act(async () => {
        jest.advanceTimersByTime(15_000);
      });
      expect(rows()).toHaveLength(1);

      const pending = Promise.withResolvers<{
        connections: ConnectionAgentSessions[];
      }>();
      summary.mockReturnValueOnce(pending.promise);
      await refresh();
      await write(AGENT_LIST_SCOPE_STORAGE_KEY, "current");
      await act(async () => pending.resolve({ connections: snapshots }));
      expect(rows()).toHaveLength(0);
      const callCount = summary.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      expect(summary).toHaveBeenCalledTimes(callCount);
      expect(onEvent).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
      jest.useRealTimers();
      for (const mock of mocks) mock.mockRestore();
      container.remove();
      __storeTesting.replaceState(previousState);
      __resetTabPinsForTests();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      await browser.happyDOM.close();
    }
  });
}
