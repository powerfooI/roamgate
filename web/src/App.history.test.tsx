import { expect, mock, spyOn, test } from "bun:test";
import * as React from "react";
import type { Pane } from "./types";
import type { TerminalView } from "./components/TerminalView";
import type { WorkspaceInspectorHost } from "./components/WorkspaceInspectorHost";

if (process.env.ROAMGATE_APP_HISTORY_TEST !== "1") {
  test("mobile history input routing in an isolated DOM runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_APP_HISTORY_TEST: "1" },
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
  test("history switches the input target and withholds input until focus settles", async () => {
    const { Window } = await import("happy-dom");
    const browser = new Window({ url: "http://localhost/?layout=mobile" });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    for (const [key, value] of Object.entries({
      window: browser,
      document: browser.document,
      navigator: browser.navigator,
      HTMLElement: browser.HTMLElement,
      Element: browser.Element,
      Node: browser.Node,
      Event: browser.Event,
      CustomEvent: browser.CustomEvent,
      localStorage: browser.localStorage,
      sessionStorage: browser.sessionStorage,
      requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
      cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
      });
    }
    const { store } = await import("./store");
    const panes: Pane[] = ["a", "b", "c"].map((id) => ({
      pane_id: id,
      terminal_id: `terminal-${id}`,
      workspace_id: "workspace",
      tab_id: "tab",
      agent: "codex",
      agent_status: "working",
      focused: id === "a",
      revision: 1,
    }));
    const rect = { x: 0, y: 0, width: 80, height: 24 };
    let snapshot = {
      ...store.get(),
      activeConnectionId: "local",
      connectionGeneration: 1,
      selectedPaneId: "a",
      panes,
      workspaces: [
        {
          workspace_id: "workspace",
          number: 1,
          label: "Workspace",
          focused: true,
          pane_count: 3,
          tab_count: 1,
          agent_status: "working",
          active_tab_id: "tab",
        },
      ],
      tabs: [
        {
          tab_id: "tab",
          workspace_id: "workspace",
          number: 1,
          label: "Tab",
          focused: true,
          pane_count: 3,
          agent_status: "working",
        },
      ],
      layout: {
        workspace_id: "workspace",
        tab_id: "tab",
        focused_pane_id: "a",
        zoomed: false,
        area: rect,
        panes: panes.map((pane) => ({
          pane_id: pane.pane_id,
          focused: pane.focused,
          rect,
        })),
        splits: [],
      },
    };
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    };
    const spies: Array<{ mockRestore: () => void }> = [
      spyOn(store, "get").mockImplementation(() => snapshot),
      spyOn(store, "init").mockImplementation(() => {}),
      spyOn(store, "subscribe").mockImplementation(subscribe),
    ];
    const focusRequests: Array<{ paneId: string; finish: () => void }> = [];
    spies.push(
      spyOn(store, "focusPane").mockImplementation(
        (paneId) =>
          new Promise<undefined>((resolve) => {
            focusRequests.push({ paneId, finish: () => resolve(undefined) });
          }),
      ),
    );
    const storeModule = await import("./store");
    mock.module("./store", () => ({
      ...storeModule,
      useStoreSelector: <T,>(
        selector: (state: ReturnType<typeof store.get>) => T,
      ) => selector(React.useSyncExternalStore(subscribe, () => snapshot)),
    }));
    const client = {
      connectionId: "local",
      generation: 1,
      isCurrent: () => true,
    };
    mock.module("./useConnectionClient", () => ({
      useConnectionClient: () => client,
      useConnectionReady: () => true,
      connectionClientScopeKey: () => `local:${client.generation}`,
    }));
    mock.module("./assistant", () => ({
      useAssistantState: () => ({ snapshot: null }),
      assistantActionExecuting: () => false,
    }));
    for (const name of [
      "ConnectionSwitcher",
      "GlobalTooltip",
      "AnnotationPanel",
    ])
      mock.module(`./components/${name}`, () => ({ [name]: () => null }));
    let showSession!: () => void;
    mock.module("./components/MobileTabSheet", () => ({
      MobileTabSheet: ({
        onShowSession,
        onClose,
      }: {
        onShowSession: () => void;
        onClose: () => void;
      }) => {
        showSession = () => {
          onClose();
          onShowSession();
        };
        return null;
      },
    }));
    mock.module("./components/ConfigMenu", () => ({
      ConfigMenu: () => null,
      CONFIG_MENU_ID: "config-menu",
    }));
    mock.module("./components/TabBar", () => ({
      TabBar: () => null,
      requestClosePane() {},
      requestCloseTab() {},
    }));
    mock.module("./components/WorkspaceTree", () => ({
      WorkspaceTree: ({
        onViewAgentHistory,
      }: {
        onViewAgentHistory: (pane: Pane) => void;
      }) => (
        <>
          {panes.map((pane) => (
            <button key={pane.pane_id} onClick={() => onViewAgentHistory(pane)}>
              History {pane.pane_id}
            </button>
          ))}
        </>
      ),
    }));
    let terminalProps!: React.ComponentProps<typeof TerminalView>;
    let inspectorProps!: React.ComponentProps<typeof WorkspaceInspectorHost>;
    mock.module("./components/TerminalView", () => ({
      TerminalView: (props: typeof terminalProps) => {
        terminalProps = props;
        return null;
      },
    }));
    mock.module("./components/WorkspaceInspectorHost", () => ({
      WorkspaceInspectorHost: (props: typeof inspectorProps) => {
        inspectorProps = props;
        return null;
      },
    }));
    const { initializeLayoutPreferences } = await import("./layoutPreferences");
    initializeLayoutPreferences();
    const { default: App } = await import("./App");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const openHistory = (id: string) =>
      React.act(async () => {
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === `History ${id}`)!
          .click();
      });
    const focusSettled = (id: string) =>
      React.act(async () => {
        snapshot = { ...snapshot, selectedPaneId: id };
        for (const listener of listeners) listener();
        focusRequests.find((request) => request.paneId === id)?.finish();
      });
    try {
      await React.act(async () => root.render(<App />));
      expect(terminalProps.paneId).toBe("a");
      expect(terminalProps.mobileInputTarget).not.toBeNull();
      const chatButton = container.querySelector<HTMLButtonElement>(
        '.mobile-appbar [aria-label="Show agent message history"]',
      )!;
      const terminalButton = container.querySelector<HTMLButtonElement>(
        '.mobile-terminal-tools [aria-label="Show terminal session"]',
      )!;
      expect(
        container.querySelector(
          '.topbar [aria-label="Show agent message history"]',
        ),
      ).toBeNull();
      expect(container.querySelector(".mobile-appbar")?.firstElementChild).toBe(
        chatButton,
      );
      expect(
        container.querySelector(".mobile-bottom-bar[data-chat]"),
      ).not.toBeNull();
      expect(chatButton.textContent).toBe("Chat");
      expect(chatButton.getAttribute("aria-pressed")).toBe("true");
      expect(inspectorProps.historyPane?.pane_id).toBe("a");
      expect(terminalProps.agentHistoryOpen).toBe(true);
      const menuChat = container.querySelector<HTMLButtonElement>(
        ".mobile-terminal-tools button:first-child",
      )!;
      expect(menuChat.textContent).toBe("Chat");
      await React.act(async () => {
        container
          .querySelector<HTMLButtonElement>(".mobile-appbar-more")!
          .click();
      });
      await React.act(async () => menuChat.click());
      expect(container.querySelector("[data-mobile-more]")).toBeNull();
      expect(inspectorProps.historyPane?.pane_id).toBe("a");
      expect(terminalProps.agentHistoryOpen).toBe(true);
      expect(chatButton.getAttribute("aria-pressed")).toBe("true");
      await React.act(async () => chatButton.click());
      expect(inspectorProps.visible).toBe(true);
      await React.act(async () => terminalButton.click());
      expect(terminalProps.visible).toBe(true);
      expect(terminalProps.agentHistoryOpen).toBe(false);
      expect(chatButton.getAttribute("aria-pressed")).toBe("false");
      await React.act(async () => chatButton.click());
      expect(terminalProps.agentHistoryOpen).toBe(true);
      await React.act(async () => terminalButton.click());
      expect(focusRequests).toHaveLength(0);
      await React.act(async () => terminalProps.onComposerOpenChange!(true));
      expect(terminalProps.composerOpen).toBe(true);
      await openHistory("b");
      expect(inspectorProps.historyPane?.pane_id).toBe("b");
      expect(focusRequests.map((request) => request.paneId)).toEqual(["b"]);
      expect(terminalProps.mobileInputTarget).toBeNull();
      expect(terminalProps.composerOpen).toBe(false);
      // A failed focus cannot re-enable A's editor under B's history.
      await React.act(async () => focusRequests[0]!.finish());
      expect(terminalProps.mobileInputTarget).toBeNull();
      await focusSettled("b");
      expect(terminalProps.paneId).toBe("b");
      expect(terminalProps.mobileInputTarget).not.toBeNull();
      expect(terminalProps.agentHistoryOpen).toBe(true);
      expect(terminalProps.composerOpen).toBe(true);
      // A retained History panel must not keep its input tools on Workspaces.
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Show workspaces"]')!
          .click(),
      );
      expect(inspectorProps.state.open).toBe(true);
      expect(inspectorProps.visible).toBe(false);
      expect(terminalProps.visible).toBe(false);
      expect(terminalProps.agentHistoryOpen).toBe(false);
      expect(terminalProps.composerOpen).toBe(true);
      expect(terminalProps.mobileInputTarget).not.toBeNull();
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Show agent message history"]',
          )!
          .click(),
      );
      expect(inspectorProps.visible).toBe(true);
      expect(terminalProps.agentHistoryOpen).toBe(true);
      expect(terminalProps.composerOpen).toBe(true);
      expect(focusRequests).toHaveLength(1);
      // Rapid history switches must keep the latest target, even if focus lags.
      await openHistory("a");
      await openHistory("c");
      await focusSettled("a");
      expect(inspectorProps.historyPane?.pane_id).toBe("c");
      expect(terminalProps.mobileInputTarget).toBeNull();
      await focusSettled("c");
      expect(terminalProps.paneId).toBe("c");
      expect(terminalProps.mobileInputTarget).not.toBeNull();
      expect(terminalProps.agentHistoryOpen).toBe(true);
      // Ordinary shell panes do not advertise a Chat view they cannot open.
      await React.act(async () =>
        terminalProps.onAgentHistoryOpenChange!(false),
      );
      await React.act(async () => {
        snapshot = {
          ...snapshot,
          panes: snapshot.panes.map((pane) => ({ ...pane, agent: undefined })),
        };
        for (const listener of listeners) listener();
      });
      expect(
        container.querySelector(".mobile-appbar .mobile-chat-button"),
      ).toBeNull();
      expect(
        container.querySelector(".mobile-bottom-bar[data-chat]"),
      ).toBeNull();
      expect(menuChat.disabled).toBe(true);

      const { roamgateLocalStorage } = await import("./browserStorage");
      const chooseChat = () =>
        React.act(async () => {
          container
            .querySelector<HTMLButtonElement>(
              ".mobile-appbar .mobile-chat-button",
            )!
            .click();
        });
      const switchSession = async (id: string, agent = true) => {
        await React.act(async () => {
          container
            .querySelector<HTMLButtonElement>(".mobile-appbar-tabs")!
            .click();
        });
        await React.act(async () => {
          const tabId = `tab-${id}`;
          snapshot = {
            ...snapshot,
            selectedPaneId: id,
            panes: panes.map((pane) => ({
              ...pane,
              tab_id: `tab-${pane.pane_id}`,
              agent: pane.pane_id === id && !agent ? undefined : "codex",
              focused: pane.pane_id === id,
            })),
            tabs: panes.map((pane, index) => ({
              ...snapshot.tabs[0]!,
              tab_id: `tab-${pane.pane_id}`,
              number: index + 1,
              focused: pane.pane_id === id,
              pane_count: 1,
            })),
            workspaces: snapshot.workspaces.map((workspace) => ({
              ...workspace,
              active_tab_id: tabId,
              tab_count: 3,
            })),
            layout: {
              ...snapshot.layout,
              tab_id: tabId,
              focused_pane_id: id,
              panes: [{ pane_id: id, focused: true, rect }],
            },
          };
          for (const listener of listeners) listener();
        });
        // TabSheet completes after the store has published the new target.
        await React.act(async () => showSession());
      };
      const reload = (key: string) =>
        React.act(async () => root.render(<App key={key} />));

      // An explicit Terminal choice survives switching and page reloads.
      expect(roamgateLocalStorage.getItem("mobileAgentView")).toBe("terminal");
      await switchSession("a");
      expect(terminalProps.visible).toBe(true);
      expect(terminalProps.agentHistoryOpen).toBe(false);
      await reload("terminal");
      expect(terminalProps.visible).toBe(true);
      expect(terminalProps.agentHistoryOpen).toBe(false);

      await chooseChat();
      await switchSession("b");
      expect(inspectorProps.visible).toBe(true);
      expect(inspectorProps.historyPane?.pane_id).toBe("b");
      expect(terminalProps.paneId).toBe("b");
      expect(terminalProps.agentHistoryOpen).toBe(true);
      expect(terminalProps.mobileInputTarget).not.toBeNull();
      await switchSession("c", false);
      expect(terminalProps.visible).toBe(true);
      expect(terminalProps.agentHistoryOpen).toBe(false);
      expect(roamgateLocalStorage.getItem("mobileAgentView")).toBe("chat");
      // Shell Message/Direct input and the Terminal menu keep the agent choice.
      await React.act(async () => terminalProps.onActivateTerminalSurface!());
      expect(terminalProps.visible).toBe(true);
      expect(roamgateLocalStorage.getItem("mobileAgentView")).toBe("chat");
      await React.act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '.mobile-terminal-tools [aria-label="Show terminal session"]',
          )!
          .click(),
      );
      expect(roamgateLocalStorage.getItem("mobileAgentView")).toBe("chat");
      await switchSession("a");
      expect(inspectorProps.historyPane?.pane_id).toBe("a");
      expect(terminalProps.agentHistoryOpen).toBe(true);
      await reload("chat");
      expect(terminalProps.agentHistoryOpen).toBe(true);

      // Another browser tab updates the preference, without stealing this view.
      await React.act(async () => {
        roamgateLocalStorage.setItem("mobileAgentView", "terminal");
        browser.dispatchEvent(
          new browser.StorageEvent("storage", {
            key: "roamgate:mobileAgentView",
            storageArea: browser.localStorage,
          }),
        );
      });
      expect(terminalProps.agentHistoryOpen).toBe(true);
      await switchSession("b");
      expect(terminalProps.agentHistoryOpen).toBe(false);

      // Direct input is also an explicit Terminal choice; failed storage is safe.
      await chooseChat();
      const failedStorage = spyOn(
        roamgateLocalStorage,
        "setItem",
      ).mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      try {
        await React.act(async () => terminalProps.onActivateTerminalSurface!());
        expect(terminalProps.agentHistoryOpen).toBe(false);
        await switchSession("a");
        expect(terminalProps.agentHistoryOpen).toBe(false);
      } finally {
        failedStorage.mockRestore();
      }

      // Desktop choices never overwrite the mobile preference or auto-open Chat.
      const { updateLayoutPreferences } = await import("./layoutPreferences");
      await React.act(async () => updateLayoutPreferences({ mode: "desktop" }));
      await reload("desktop");
      expect(terminalProps.agentHistoryOpen).toBe(false);
      await React.act(async () => terminalProps.onActivateTerminalSurface!());
      expect(roamgateLocalStorage.getItem("mobileAgentView")).toBe("chat");
      await React.act(async () => updateLayoutPreferences({ mode: "mobile" }));
      expect(terminalProps.agentHistoryOpen).toBe(true);
      await React.act(async () => {
        client.generation += 1;
        snapshot = { ...snapshot, connectionGeneration: client.generation };
        for (const listener of listeners) listener();
      });
      expect(terminalProps.agentHistoryOpen).toBe(true);
    } finally {
      await React.act(async () => root.unmount());
      for (const spy of spies) spy.mockRestore();
      container.remove();
      await browser.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
}
