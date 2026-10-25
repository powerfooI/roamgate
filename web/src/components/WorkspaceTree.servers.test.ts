import { expect, jest, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { bridge } from "../api";
import { __storeTesting, store } from "../store";
import { connectionStorageKey } from "../connectionStorage";
import { WORKSPACE_PINS_STORAGE_KEY } from "../workspacePins";
import { COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY } from "../workspaceTreeCollapse";
import {
  AGENT_LIST_SCOPE_STORAGE_KEY,
  WORKSPACE_AGENT_LAYOUT_STORAGE_KEY,
} from "../workspaceAgentLayout";
import type { ConnectionAgentSessions } from "../useAllServerAgentSessions";
import { WorkspaceTree } from "./WorkspaceTree";
import { TREE_DEPTH_INDENT } from "./treeIndent";

function snapshot(id: string): ConnectionAgentSessions {
  const worktree = {
    repo_key: "repo",
    repo_name: "Project",
    repo_root: "/repo",
    checkout_path: "/repo",
    is_linked_worktree: false,
    git_status: {
      branch: `${id}/main`,
      ahead: 1,
      behind: 0,
      staged: 0,
      unstaged: 1,
      untracked: 1,
      conflicted: 0,
      dirty: true,
    },
  };
  return {
    connection_id: id,
    connection_generation: 1,
    agents: null,
    workspaces: ["w1", "w2", "w3"].map((workspace_id, index) => ({
      workspace_id,
      number: index + 1,
      label: `${id} ${workspace_id}`,
      focused: index === 0,
      pane_count: 1,
      tab_count: 1,
      agent_status: "working",
      worktree:
        index === 2
          ? {
              ...worktree,
              is_linked_worktree: true,
              checkout_path: "/repo/branch",
              parent_workspace_id: "w2",
            }
          : worktree,
    })),
    tabs: ["w1", "w2", "w3"].map((workspace_id) => ({
      workspace_id,
      tab_id: `${workspace_id}:t1`,
      number: 1,
      label: `${id} ${workspace_id} tab`,
      focused: true,
      pane_count: 1,
      agent_status: "working",
    })),
    panes: ["w1", "w3"].map((workspace_id) => ({
      workspace_id,
      pane_id: `${workspace_id}:p1`,
      tab_id: `${workspace_id}:t1`,
      terminal_id: `${workspace_id}:term`,
      agent: "codex",
      agent_status: "working",
      focused: workspace_id === "w1",
      revision: 1,
    })),
  };
}

if (process.env.ROAMGATE_SERVER_TREE_DOM_TEST !== "1") {
  test("all workspace layouts preserve connection ownership in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_SERVER_TREE_DOM_TEST: "1" },
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
  test("labels all layouts without a server level, preserves worktree preferences, and routes menus safely", async () => {
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
    const snapshots = [snapshot("alpha"), snapshot("beta")];
    const mocks: { mockRestore(): void }[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const write = async (key: string, value: string) =>
      act(async () => {
        browser.localStorage.setItem(`roamgate:${key}`, value);
        browser.dispatchEvent(
          new browser.StorageEvent("storage", {
            key: `roamgate:${key}`,
            storageArea: browser.localStorage,
          }),
        );
      });
    const rows = (id: string) =>
      container.querySelectorAll<HTMLElement>(
        `.tree-row[data-connection-id="${id}"]`,
      );
    const workspace = (id: string, name: string) =>
      [...rows(id)].find(
        (row) => row.querySelector(".ws-label")?.textContent === name,
      )!;
    const agent = (id: string) =>
      workspace(id, `${id} w1`).nextElementSibling as HTMLElement;
    try {
      jest.useFakeTimers();
      const summary = spyOn(bridge, "call").mockResolvedValue({
        connections: snapshots,
      });
      const navigate = spyOn(store, "focusWorkspaceSource").mockResolvedValue(
        true,
      );
      const focus = spyOn(store, "focusWorkspace").mockResolvedValue(undefined);
      const rename = spyOn(store, "renameWorkspace").mockResolvedValue(
        undefined,
      );
      const close = spyOn(store, "closeWorkspace").mockResolvedValue(undefined);
      const selected = spyOn(store, "focusPane").mockResolvedValue(undefined);
      mocks.push(summary, navigate, focus, rename, close, selected);
      __storeTesting.replaceState({
        ...previousState,
        activeConnectionId: "alpha",
        serverRuntimeGeneration: 1,
        status: "connected",
        connectionPaused: false,
        workspaces: snapshots[0].workspaces,
        tabs: snapshots[0].tabs,
        panes: snapshots[0].panes,
        connections: ["alpha", "beta", "offline"].map((id) => ({
          id,
          label: id,
          generation: 1,
          source: "test",
          is_default: id === "alpha",
          state: id === "offline" ? "disconnected" : "ready",
        })),
      });
      await write(AGENT_LIST_SCOPE_STORAGE_KEY, "all");
      await act(async () =>
        root.render(
          createElement(WorkspaceTree, { onCreateWorkspace: () => {} }),
        ),
      );
      expect(container.querySelector(".workspace-server-group")).toBeNull();
      expect(
        container.querySelectorAll(".workspace-server-badge"),
      ).toHaveLength(6);
      for (const id of ["alpha", "beta"]) {
        for (const row of rows(id)) {
          const badge = row.querySelector<HTMLElement>(
            ".workspace-server-badge",
          )!;
          expect(badge.textContent).toBe(id);
          expect(badge.title).toBe(id);
          expect(badge.getAttribute("aria-label")).toBe(`Server: ${id}`);
        }
      }
      expect(
        container.querySelector('[data-connection-id="offline"]')?.textContent,
      ).toContain("offline: Disconnected");
      expect(container.querySelector(".agents-panel")).toBeNull();
      expect(rows("alpha")).toHaveLength(3);
      expect(rows("beta")).toHaveLength(3);
      expect(
        workspace("beta", "beta w1").querySelector(".git-branch")?.textContent,
      ).toBe("beta/main");
      expect(
        workspace("beta", "beta w1").querySelector(".git-dirty")?.textContent,
      ).toBe("Δ2");
      expect(
        workspace("beta", "beta w1").querySelector(".git-ahead")?.textContent,
      ).toBe("↑1");
      expect(workspace("beta", "beta w3").getAttribute("aria-level")).toBe("2");
      expect(workspace("beta", "beta w1").getAttribute("aria-level")).toBe("1");
      expect(workspace("beta", "beta w1").style.paddingLeft).toBe("6px");
      expect(workspace("beta", "beta w3").style.paddingLeft).toBe(
        `${6 + TREE_DEPTH_INDENT}px`,
      );
      expect(workspace("alpha", "alpha w1").getAttribute("aria-selected")).toBe(
        "true",
      );
      expect(workspace("beta", "beta w1").getAttribute("aria-selected")).toBe(
        "false",
      );
      expect(agent("beta").classList.contains("agent-row")).toBe(true);
      expect(agent("beta").getAttribute("aria-selected")).toBe("false");
      expect(agent("beta").getAttribute("aria-level")).toBe("2");
      expect(agent("beta").style.marginLeft).toBe(`${2 * TREE_DEPTH_INDENT}px`);
      expect(agent("beta").textContent).toContain("beta w1 tab");
      expect(agent("beta").textContent).not.toContain("alpha w1 tab");
      expect(store.get().activeConnectionId).toBe("alpha");

      await act(async () => workspace("beta", "beta w1").click());
      expect(navigate).toHaveBeenLastCalledWith({
        connectionId: "beta",
        runtimeGeneration: 1,
        workspaceId: "w1",
        paneId: undefined,
      });
      await act(async () => agent("beta").click());
      expect(navigate).toHaveBeenLastCalledWith({
        connectionId: "beta",
        runtimeGeneration: 1,
        workspaceId: "w1",
        paneId: "w1:p1",
      });
      expect(focus).not.toHaveBeenCalled();
      expect(selected).not.toHaveBeenCalled();

      await write(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY, "compact");
      expect(rows("beta")).toHaveLength(3);
      expect(
        container.querySelectorAll(".workspace-server-badge"),
      ).toHaveLength(6);
      expect(container.querySelector(".agent-row")).toBeNull();
      expect(
        workspace("beta", "beta w1").querySelector(".workspace-tab-count")
          ?.textContent,
      ).toBe("1");

      await write(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY, "nested");
      await act(async () =>
        workspace("beta", "beta w2")
          .querySelector<HTMLButtonElement>(".workspace-group-toggle")!
          .click(),
      );
      expect(rows("beta")).toHaveLength(2);
      expect(rows("alpha")).toHaveLength(3);
      expect(
        browser.localStorage.getItem(
          `roamgate:${connectionStorageKey("beta", COLLAPSED_WORKTREE_GROUPS_STORAGE_KEY)}`,
        ),
      ).toContain("workspace:w2");
      await write(
        connectionStorageKey("beta", WORKSPACE_PINS_STORAGE_KEY),
        '["workspace:w1"]',
      );
      expect(workspace("beta", "beta w1").classList.contains("is-pinned")).toBe(
        true,
      );
      expect(
        workspace("alpha", "alpha w1").classList.contains("is-pinned"),
      ).toBe(false);

      await act(async () => {
        workspace("beta", "beta w1").dispatchEvent(
          new window.MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 40,
            clientY: 40,
          }),
        );
        await import("./ContextMenu");
      });
      const menu = container.querySelector<HTMLElement>(".context-menu")!;
      expect(menu.textContent).toContain("beta w1");
      expect(menu.textContent).toContain("Open workspace");
      expect(menu.textContent).not.toContain("Rename workspace");
      expect(menu.textContent).not.toContain("Close workspace");
      expect(store.get().activeConnectionId).toBe("alpha");
      await act(async () =>
        menu.querySelector<HTMLButtonElement>(".context-menu-item")!.click(),
      );
      expect(navigate).toHaveBeenLastCalledWith({
        connectionId: "beta",
        runtimeGeneration: 1,
        workspaceId: "w1",
        paneId: undefined,
      });
      expect(rename).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();

      await write(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY, "separate");
      expect(
        container.querySelectorAll(".agents-panel .agent-row"),
      ).toHaveLength(4);
      expect(
        container.querySelector(".workspace-tree-panel .agent-row"),
      ).toBeNull();
      expect(container.querySelector(".agents-panel")?.textContent).toContain(
        "beta",
      );
      expect(workspace("beta", "beta w2").getAttribute("aria-expanded")).toBe(
        "false",
      );
      await write(AGENT_LIST_SCOPE_STORAGE_KEY, "current");
      expect(container.querySelector(".workspace-server-badge")).toBeNull();
      const currentRoot = container.querySelector<HTMLElement>(".tree-row")!;
      expect(currentRoot.getAttribute("aria-level")).toBe("1");
      expect(currentRoot.style.paddingLeft).toBe("6px");
      expect(
        container.querySelectorAll(".agents-panel .agent-row"),
      ).toHaveLength(2);
      await write(AGENT_LIST_SCOPE_STORAGE_KEY, "all");
      expect(workspace("beta", "beta w2").getAttribute("aria-expanded")).toBe(
        "false",
      );
      expect(rows("beta")).toHaveLength(2);
      expect(rows("alpha")).toHaveLength(3);
      const callCount = summary.mock.calls.length;
      await write(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY, "compact");
      await write(WORKSPACE_AGENT_LAYOUT_STORAGE_KEY, "nested");
      expect(summary).toHaveBeenCalledTimes(callCount);
      expect(
        container.querySelector(
          '.workspace-tree-panel [aria-label="Workspace server scope"]',
        ),
      ).not.toBeNull();
      for (const connectedCount of [1, 0, 2]) {
        __storeTesting.replaceState({
          ...store.get(),
          connections: store.get().connections.map((connection, index) => ({
            ...connection,
            state: index < connectedCount ? "ready" : "disconnected",
          })),
        });
        await act(async () =>
          root.render(
            createElement(WorkspaceTree, { onCreateWorkspace: () => {} }),
          ),
        );
        expect(
          !!container.querySelector('[aria-label="Workspace server scope"]'),
        ).toBe(connectedCount > 1);
      }
    } finally {
      await act(async () => root.unmount());
      jest.useRealTimers();
      for (const mock of mocks) mock.mockRestore();
      container.remove();
      __storeTesting.replaceState(previousState);
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      await browser.happyDOM.close();
    }
  });
}
